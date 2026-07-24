// Scans a music folder into an in-memory track index.
// Reads ID3/metadata tags when present; falls back to parsing filenames.
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { analyzeBpm, ffmpegAvailable } from './bpm.js';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.webm']);

// id -> track ; also keep an ordered array.
let index = new Map();
let folderRoot = '';

export function getFolderRoot() {
  return folderRoot;
}

export function getTracks() {
  return [...index.values()];
}

export function getTrack(id) {
  return index.get(id);
}

const trackId = (relPath) => crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 12);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

// Parse "Artist - Title" style filenames when tags are missing.
function parseFilename(file) {
  let base = path.basename(file, path.extname(file));
  base = base.replace(/^\s*\d{1,3}\s*[-._)]\s*/, ''); // leading track number
  base = base.replace(/_/g, ' ').trim();
  const parts = base.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { artist: parts[0], title: parts.slice(1).join(' - ') };
  }
  return { artist: '', title: base };
}

async function readTrack(file, root) {
  const rel = path.relative(root, file);
  const id = trackId(rel);
  let common = {};
  let format = {};
  try {
    // Guard against a pathological/corrupt file stalling the scan.
    const meta = await withTimeout(parseFile(file, { duration: true, skipCovers: true }), 10000);
    common = meta.common || {};
    format = meta.format || {};
  } catch {
    // Unreadable tags or timeout — we'll lean on the filename.
  }

  const fromName = parseFilename(file);
  const title = clean(common.title) || fromName.title || path.basename(file);
  const artist = clean(common.artist) || (common.artists && common.artists[0]) || fromName.artist || 'Unknown Artist';
  const genre = Array.isArray(common.genre) ? common.genre[0] : clean(common.genre);
  const bpm = numeric(common.bpm);

  return {
    id,
    rel,
    file,
    title,
    artist,
    album: clean(common.album) || '',
    genre: genre || null,
    year: common.year || null,
    bpm: bpm || null,
    bpmSource: bpm ? 'tag' : null,
    durationSec: format.duration ? Math.round(format.duration) : null,
    hasTags: Boolean(common.title || common.artist),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('parse timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const numeric = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

// Scan the folder. Returns { count, tracks, ffmpeg }.
export async function scan(folder) {
  if (!folder || !existsSync(folder)) {
    index = new Map();
    folderRoot = '';
    return { count: 0, tracks: [], ffmpeg: false, error: 'Folder not found' };
  }
  folderRoot = folder;
  const next = new Map();
  for await (const file of walk(folder)) {
    const track = await readTrack(file, folder);
    next.set(track.id, track);
  }
  index = next;
  return { count: index.size, tracks: getTracks(), ffmpeg: await ffmpegAvailable() };
}

// Analyze BPM for tracks that don't have it from tags (needs ffmpeg).
// Runs in the background; updates the index in place and caches to disk.
export async function analyzeMissingBpm({ onProgress } = {}) {
  if (!(await ffmpegAvailable())) return { analyzed: 0, skipped: true, reason: 'ffmpeg not found' };

  const cachePath = folderRoot ? path.join(folderRoot, '.ai-radio-cache.json') : null;
  let cache = {};
  if (cachePath && existsSync(cachePath)) {
    try {
      cache = JSON.parse(await readFile(cachePath, 'utf8'));
    } catch {
      cache = {};
    }
  }

  const pending = getTracks().filter((t) => !t.bpm);
  let analyzed = 0;
  for (const track of pending) {
    if (cache[track.rel]?.bpm) {
      track.bpm = cache[track.rel].bpm;
      track.bpmSource = 'analysis';
      continue;
    }
    try {
      const bpm = await analyzeBpm(track.file);
      if (bpm) {
        track.bpm = bpm;
        track.bpmSource = 'analysis';
        cache[track.rel] = { bpm };
        analyzed++;
        if (onProgress) onProgress({ analyzed, total: pending.length, track: track.title });
      }
    } catch {
      // Skip tracks we can't decode.
    }
  }

  if (cachePath) {
    await writeFile(cachePath, JSON.stringify(cache, null, 2)).catch(() => {});
  }
  return { analyzed, total: pending.length };
}
