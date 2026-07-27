// Chooses the next track according to the active shuffle mode.
// Modes: random | bpm-asc | bpm-desc | genre | ai-pick
import { generateJson } from '../ai/gemini.js';

const RECENT_WINDOW = 12;

function withoutRecent(tracks, history, lastId) {
  const recent = new Set([...(history || []).slice(-RECENT_WINDOW), lastId].filter(Boolean));
  const fresh = tracks.filter((t) => !recent.has(t.id));
  return fresh.length ? fresh : tracks.filter((t) => t.id !== lastId);
}

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function byBpm(tracks, dir) {
  const known = tracks.filter((t) => t.bpm).sort((a, b) => (dir === 'asc' ? a.bpm - b.bpm : b.bpm - a.bpm));
  const unknown = tracks.filter((t) => !t.bpm);
  return [...known, ...unknown];
}

function stepThrough(ordered, lastId) {
  if (!ordered.length) return null;
  const idx = ordered.findIndex((t) => t.id === lastId);
  return ordered[(idx + 1) % ordered.length];
}

function pickGenre(tracks, { lastId, history, genreFilter }) {
  if (genreFilter) {
    const pool = tracks.filter((t) => (t.genre || '').toLowerCase() === genreFilter.toLowerCase());
    return rand(withoutRecent(pool.length ? pool : tracks, history, lastId));
  }
  const last = tracks.find((t) => t.id === lastId);
  const currentGenre = last?.genre;
  if (currentGenre) {
    const sameGenre = tracks.filter((t) => t.genre === currentGenre && t.id !== lastId);
    const fresh = withoutRecent(sameGenre, history, lastId);
    // Stay in the genre most of the time; occasionally wander to a new one.
    if (fresh.length && Math.random() > 0.2) return rand(fresh);
  }
  return rand(withoutRecent(tracks, history, lastId));
}

async function pickAi(tracks, { lastId, history }) {
  const candidates = shuffle(withoutRecent(tracks, history, lastId)).slice(0, 25);
  if (!candidates.length) return rand(tracks);

  const recentTitles = (history || [])
    .slice(-6)
    .map((id) => tracks.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => `${t.artist} — ${t.title}`);

  const list = candidates
    .map((t) => `- id:${t.id} | ${t.artist} — ${t.title}${t.genre ? ` [${t.genre}]` : ''}${t.bpm ? ` (${t.bpm} BPM)` : ''}`)
    .join('\n');

  const prompt = `You are a radio music director building a smooth, engaging set.
Recently played (oldest→newest):
${recentTitles.length ? recentTitles.map((s) => `- ${s}`).join('\n') : '- (nothing yet)'}

Choose the single best NEXT track from these candidates for good energy flow and variety.
Candidates:
${list}

Respond with JSON only: {"id":"<candidate id>","reason":"<short reason>"}`;

  try {
    const out = await generateJson(prompt, { temperature: 0.8, maxOutputTokens: 300 });
    const chosen = candidates.find((t) => t.id === out.id);
    return chosen || rand(candidates);
  } catch {
    return rand(candidates);
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Main entry. `mode` is one of the modes above.
export async function pickNext(tracks, { mode = 'random', lastId = null, history = [], genreFilter = null } = {}) {
  if (!tracks || !tracks.length) return null;
  switch (mode) {
    case 'bpm-asc':
      return stepThrough(byBpm(tracks, 'asc'), lastId) || rand(tracks);
    case 'bpm-desc':
      return stepThrough(byBpm(tracks, 'desc'), lastId) || rand(tracks);
    case 'genre':
      return pickGenre(tracks, { lastId, history, genreFilter });
    case 'ai-pick':
      return pickAi(tracks, { lastId, history });
    case 'random':
    default:
      return rand(withoutRecent(tracks, history, lastId));
  }
}

// Distinct genres present in the library (for the UI dropdown).
export function listGenres(tracks) {
  const set = new Set();
  for (const t of tracks) if (t.genre) set.add(t.genre);
  return [...set].sort((a, b) => a.localeCompare(b));
}
