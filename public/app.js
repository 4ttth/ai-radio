// The conductor: drives playback, decides when the AI DJ talks or reads news,
// pre-generates the next segment while the current song plays, and wires the UI.
import { RadioPlayer } from '/player.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');

// ── App state ─────────────────────────────────────────
let state = null; // /api/state payload
let player = null;
let history = []; // played track ids (most recent last)
let currentTrack = null;
let pending = null; // { track, segment } prepared during current song
let prefetching = false;
let prefetched = false;
let transitioning = false;
let started = false;

let djIndex = 0; // which DJ is on air (client-owned rotation)
let lastNewsAt = 0;
let lastHandoffAt = 0;
let songsSinceIntro = 0;

// ── API helpers ───────────────────────────────────────
const api = {
  state: () => fetch('/api/state').then((r) => r.json()),
  branding: () => fetch('/api/branding').then((r) => r.json()),
  next: () => fetch(`/api/next?lastId=${currentTrack?.id || ''}&history=${history.slice(-12).join(',')}`).then((r) => r.json()),
  scan: (folder) => fetch('/api/scan', { method: 'POST', headers: json(), body: JSON.stringify({ folder }) }).then((r) => r.json()),
  analyzeBpm: () => fetch('/api/analyze-bpm', { method: 'POST' }).then((r) => r.json()),
  saveConfig: (patch) => fetch('/api/config', { method: 'POST', headers: json(), body: JSON.stringify(patch) }).then((r) => r.json()),
  segment: (body) => fetch('/api/segment', { method: 'POST', headers: json(), body: JSON.stringify(body) }).then((r) => r.json()),
};
const json = () => ({ 'content-type': 'application/json' });

// ── Roster helpers ────────────────────────────────────
const roster = () => state?.djRoster || [];
const onAirDj = () => roster()[djIndex % Math.max(1, roster().length)] || null;

// ── Boot ──────────────────────────────────────────────
async function boot() {
  state = await api.state();
  const brand = await api.branding();
  window.__brandings = brand.stations;
  hydrate();
  wire();
}

// Push config to server and keep local copy in sync.
let saveTimer = null;
function saveConfig(patch, immediate = false) {
  state.config = deepMerge(state.config, patch);
  clearTimeout(saveTimer);
  const run = () => api.saveConfig(patch).then((s) => { state = s; });
  if (immediate) return run();
  saveTimer = setTimeout(run, 500);
}

// ── Rendering ─────────────────────────────────────────
function applyBranding(b) {
  if (!b) return;
  const c = b.colors;
  const root = document.documentElement.style;
  root.setProperty('--bg', c.bg);
  root.setProperty('--surface', c.surface);
  root.setProperty('--primary', c.primary);
  root.setProperty('--accent', c.accent);
  root.setProperty('--text', c.text);
  root.setProperty('--muted', c.muted);
  $('brandLogo').innerHTML = b.logo?.svg || '📻';
  $('tagline').textContent = b.tagline || '';
  $('brandingPreview').innerHTML = `<b style="color:var(--text)">${b.name}</b> — ${b.format}<br>${b.personality}`;
  renderRoster(b);
}

function renderRoster(b) {
  const list = state.config.djs?.length ? state.config.djs : b.djs;
  $('djRoster').innerHTML = list.map((d, i) => `
    <div class="dj-chip">
      <span class="avatar">${(d.name || '?')[0]}</span>
      <span class="who"><b>${d.name}</b> · voice: ${d.voice} ${i === (djIndex % list.length) ? '· <small>on air</small>' : ''}<br><small>${d.persona || ''}</small></span>
    </div>`).join('');
}

function renderFeeds() {
  const feeds = state.config.news?.feeds || [];
  $('feeds').innerHTML = feeds.map((f, i) => `
    <div class="feed">
      <span class="feed-url" title="${f.url}">${f.url}</span>
      <span class="feed-badge">${f.category || 'News'} · ${f.mood || 'Serious'}</span>
      <button class="del" data-i="${i}" aria-label="Remove feed">✕</button>
    </div>`).join('') || '<div class="sub">No feeds yet — add one below.</div>';
  $('feeds').querySelectorAll('.del').forEach((btn) => {
    btn.onclick = () => {
      const feeds2 = state.config.news.feeds.slice();
      feeds2.splice(Number(btn.dataset.i), 1);
      saveConfig({ news: { feeds: feeds2 } }, true).then(renderFeeds);
    };
  });
}

function hydrate() {
  const cfg = state.config;
  const b = state.branding;
  applyBranding(b);
  $('stationName').value = cfg.stationName || b.name;
  updateOnAir();

  // Branding select
  $('branding').innerHTML = window.__brandings.map((s) => `<option value="${s.id}" ${s.id === cfg.brandingId ? 'selected' : ''}>${s.name}</option>`).join('');

  // Library
  $('musicFolder').value = cfg.musicFolder || state.library.folder || '';
  renderLibStats();
  $('mode').value = cfg.shuffleMode;
  toggleGenreField();
  populateGenres();

  // DJ
  $('introEvery').value = cfg.dj?.introEverySongs ?? 1;
  $('handoffEvery').value = cfg.dj?.handoffEveryMinutes ?? cfg.dj?.handoffEvery ?? 60;
  $('styleNotes').value = cfg.dj?.styleNotes || '';
  $('voiceEngine').value = cfg.voiceEngine || 'tts';
  updateVoiceEngineHint();
  $('talkOver').checked = cfg.talkOverMusic !== false;

  // News
  $('newsEnabled').checked = cfg.news?.enabled !== false;
  $('newsEvery').value = cfg.news?.everyMinutes ?? 45;
  $('newsMax').value = cfg.news?.maxItems ?? 3;
  renderFeeds();

  // Audio
  $('duck').value = cfg.duckVolume ?? 0.22;
  $('duckVal').textContent = `${Math.round((cfg.duckVolume ?? 0.22) * 100)}%`;
  $('crossfade').value = cfg.crossfadeSeconds ?? 4;
  $('crossVal').textContent = cfg.crossfadeSeconds ?? 4;

  renderStatus();
}

function renderLibStats() {
  const l = state.library;
  $('libStats').innerHTML = l.count
    ? `<b style="color:var(--text)">${l.count}</b> tracks · ${l.genres.length} genres · ${l.untaggedBpm} without BPM · ffmpeg: ${l.ffmpeg ? '✓' : '✗'}`
    : 'No tracks found. Set a folder and Scan.';
}

function populateGenres() {
  const sel = $('genreFilter');
  const cur = state.config.genreFilter || '';
  sel.innerHTML = '<option value="">Any</option>' + (state.library.genres || []).map((g) => `<option value="${g}" ${g === cur ? 'selected' : ''}>${g}</option>`).join('');
}

function toggleGenreField() {
  $('genreField').hidden = $('mode').value !== 'genre';
}

function updateVoiceEngineHint() {
  const eng = $('voiceEngine').value;
  const m = state.models || {};
  $('voiceEngineHint').textContent = eng === 'native'
    ? `Live API model ${m.native || 'native-audio'}. More natural, different quota; auto-falls back to TTS if a session fails.`
    : `Dedicated TTS model ${m.tts || ''}. Best for reading scripts/news exactly.`;
}

function renderStatus() {
  const l = state.library;
  $('statusLines').innerHTML = `
    Gemini key: <b>${state.hasKey ? 'configured ✓' : 'missing ✗'}</b><br>
    Voice engine: <b>${state.config.voiceEngine === 'native' ? 'native audio (Live API)' : 'TTS'}</b><br>
    Models: text <b>${state.models.text}</b> · tts <b>${state.models.tts}</b> · native <b>${state.models.native || '—'}</b><br>
    Library folder: <b>${l.folder || '(none)'}</b><br>
    ffmpeg (BPM analysis): <b>${l.ffmpeg ? 'available' : 'not installed'}</b>`;
  if (!state.hasKey) hint('⚠️ No Gemini key — the station plays music, but DJs & news are silent until you add GEMINI_API_KEY to .env and restart.');
}

function updateOnAir() {
  const dj = onAirDj();
  $('onairDj').textContent = dj ? `${dj.name}` : '—';
  if (state.branding) renderRoster(state.branding);
}

function showNowPlaying(t) {
  $('npTitle').textContent = t.title;
  $('npArtist').textContent = t.artist;
  const tags = [];
  if (t.genre) tags.push(t.genre);
  if (t.bpm) tags.push(`${t.bpm} BPM${t.bpmSource === 'analysis' ? '*' : ''}`);
  if (t.album) tags.push(t.album);
  $('npTags').innerHTML = tags.map((x) => `<span class="tag">${x}</span>`).join('');
}

function showCaption(seg) {
  if (!seg || !seg.script) return;
  $('djCaptionName').textContent = seg.djName || onAirDj()?.name || 'DJ';
  $('djCaptionText').textContent = seg.script;
  $('djCaption').hidden = false;
}
function hideCaptionSoon() { setTimeout(() => { $('djCaption').hidden = true; }, 6000); }

function hint(msg) { $('statusHint').textContent = msg || ''; }
function setLive(on) { $('onairDot').classList.toggle('live', on); }

// ── Conductor ─────────────────────────────────────────
async function start() {
  if (!state.library.count) { hint('No tracks — set your music folder and Scan first.'); return; }
  if (!player) {
    player = new RadioPlayer({ duckVolume: state.config.duckVolume, crossfadeSeconds: state.config.crossfadeSeconds });
    await player.init();
    player.setVolume(Number($('volume').value));
    player.onTime = onTime;
    player.onEnded = () => { if (!transitioning) doTransition(); };
  }
  await player.resume();
  started = true;
  $('btnPlay').textContent = '⏸';
  lastNewsAt = Date.now();
  lastHandoffAt = Date.now();

  const { track } = await api.next();
  if (!track) { hint('Could not pick a track.'); return; }
  currentTrack = track;
  history.push(track.id);
  await player.playTrack(track.streamUrl);
  showNowPlaying(track);
  setLive(true);
  prefetched = false;
}

function onTime(cur, dur) {
  if (dur) {
    $('progressFill').style.width = `${Math.min(100, (cur / dur) * 100)}%`;
    $('durTime').textContent = fmt(dur);
  }
  $('curTime').textContent = fmt(cur);

  if (!started || transitioning) return;

  // Pre-generate the upcoming segment partway through the song.
  if (!prefetched && !prefetching && (cur > 20 || (dur && cur > dur * 0.4))) prefetch();

  // Begin the transition early enough to talk over the outro.
  const lead = pending?.segment ? 12 : (state.config.crossfadeSeconds || 4) + 0.5;
  if (dur && dur - cur <= lead) doTransition();
}

function decideSegmentType() {
  const cfg = state.config;
  const newsEvery = (cfg.news?.everyMinutes ?? 45) * 60000;
  const handoffEvery = (cfg.dj?.handoffEveryMinutes ?? 60) * 60000;
  if (cfg.news?.enabled !== false && state.hasKey && Date.now() - lastNewsAt >= newsEvery) return 'news';
  if (state.hasKey && roster().length > 1 && Date.now() - lastHandoffAt >= handoffEvery) return 'handoff';
  if (state.hasKey && songsSinceIntro >= (cfg.dj?.introEverySongs ?? 1)) return 'intro';
  return null;
}

async function prefetch() {
  prefetching = true;
  try {
    const { track } = await api.next();
    if (!track) { prefetching = false; return; }
    let segment = null;
    const type = decideSegmentType();
    if (type) {
      const body = { type, currentId: currentTrack?.id, nextId: track.id };
      const dj = onAirDj();
      if (type === 'handoff') {
        body.outgoingId = roster()[djIndex % roster().length]?.id;
        body.incomingId = roster()[(djIndex + 1) % roster().length]?.id;
      } else if (dj) {
        body.djId = dj.id;
      }
      const seg = await api.segment(body);
      if (!seg.skip) segment = { ...seg, type };
      else if (seg.rateLimited) hint('Gemini rate-limited — skipping this DJ break. It will retry later.');
    }
    pending = { track, segment };
    prefetched = true;
  } catch (e) {
    pending = pending || { track: null, segment: null };
  }
  prefetching = false;
}

async function doTransition() {
  if (transitioning) return;
  transitioning = true;
  try {
    if (!pending) await prefetch();
    let next = pending?.track;
    if (!next) { const r = await api.next(); next = r.track; }
    if (!next) { transitioning = false; return; }

    const seg = pending?.segment;
    const talkOver = state.config.talkOverMusic !== false;

    if (seg) {
      showCaption(seg);
      if (talkOver) {
        // Bring the next song up underneath while the DJ talks over it.
        await player.playTrack(next.streamUrl);
        await player.playVoice(seg.audioUrl);
      } else {
        // DJ speaks in the gap, then the next song starts.
        player.pause();
        await player.playVoice(seg.audioUrl);
        await player.playTrack(next.streamUrl);
      }
      hideCaptionSoon();
      // Advance counters based on what we just aired.
      if (seg.type === 'news') { lastNewsAt = Date.now(); }
      else if (seg.type === 'handoff') { lastHandoffAt = Date.now(); djIndex++; updateOnAir(); }
      if (seg.type === 'intro' || seg.type === 'handoff') songsSinceIntro = 0;
    } else {
      await player.playTrack(next.streamUrl);
      songsSinceIntro++;
    }

    currentTrack = next;
    history.push(next.id);
    if (history.length > 40) history = history.slice(-40);
    showNowPlaying(next);
    pending = null;
    prefetched = false;
  } catch (e) {
    hint(`Transition error: ${e.message}`);
  }
  transitioning = false;
}

// One-off DJ talk over the current song (doesn't change track).
async function talkNow(type) {
  if (!started || !state.hasKey) { hint('Start the station first (needs a Gemini key).'); return; }
  const prevId = history[history.length - 2];
  const dj = onAirDj();
  const body = type === 'news'
    ? { type: 'news', currentId: currentTrack?.id, nextId: currentTrack?.id, djId: dj?.id }
    : { type: 'intro', currentId: prevId, nextId: currentTrack?.id, djId: dj?.id };
  hint('Generating…');
  const seg = await api.segment(body);
  hint('');
  if (seg.skip) { hint(`No segment: ${seg.reason}${seg.rateLimited ? ' (rate-limited)' : ''}`); return; }
  showCaption(seg);
  await player.playVoice(seg.audioUrl);
  hideCaptionSoon();
  if (type === 'news') lastNewsAt = Date.now();
}

// ── Wiring ────────────────────────────────────────────
function wire() {
  $('btnPlay').onclick = async () => {
    if (!started) return start();
    if (player.paused) { await player.play(); $('btnPlay').textContent = '⏸'; setLive(true); }
    else { player.pause(); $('btnPlay').textContent = '▶'; setLive(false); }
  };
  $('btnSkip').onclick = () => { if (started) doTransition(); };
  $('btnTalk').onclick = () => talkNow('intro');
  $('btnNews').onclick = () => talkNow('news');
  $('volume').oninput = (e) => player?.setVolume(Number(e.target.value));

  $('stationName').onchange = (e) => saveConfig({ stationName: e.target.value }, true);

  $('branding').onchange = async (e) => {
    const s = await api.saveConfig({ brandingId: e.target.value });
    state = s;
    djIndex = 0;
    // Adopt the new station's name unless the user has clearly customized it.
    state = await api.saveConfig({ stationName: state.branding.name });
    hydrate();
  };

  $('musicFolder').onchange = (e) => saveConfig({ musicFolder: e.target.value });
  $('btnScan').onclick = async () => {
    hint('Scanning…');
    const r = await api.scan($('musicFolder').value.trim());
    state = await api.state();
    renderLibStats(); populateGenres(); renderStatus();
    hint(r.error ? `Scan error: ${r.error}` : `Found ${r.count} tracks.`);
  };
  $('btnAnalyzeBpm').onclick = async () => {
    const r = await api.analyzeBpm();
    if (r.error) { $('bpmStatus').textContent = r.error; return; }
    pollBpm();
  };

  $('mode').onchange = (e) => { saveConfig({ shuffleMode: e.target.value }, true); toggleGenreField(); };
  $('genreFilter').onchange = (e) => saveConfig({ genreFilter: e.target.value || null }, true);

  $('introEvery').onchange = (e) => saveConfig({ dj: { introEverySongs: Number(e.target.value) } });
  $('handoffEvery').onchange = (e) => saveConfig({ dj: { handoffEveryMinutes: Number(e.target.value) } });
  $('styleNotes').onchange = (e) => saveConfig({ dj: { styleNotes: e.target.value } });
  $('voiceEngine').onchange = (e) => { saveConfig({ voiceEngine: e.target.value }, true); updateVoiceEngineHint(); };
  $('talkOver').onchange = (e) => saveConfig({ talkOverMusic: e.target.checked });

  $('newsEnabled').onchange = (e) => saveConfig({ news: { enabled: e.target.checked } });
  $('newsEvery').onchange = (e) => saveConfig({ news: { everyMinutes: Number(e.target.value) } });
  $('newsMax').onchange = (e) => saveConfig({ news: { maxItems: Number(e.target.value) } });
  $('btnAddFeed').onclick = () => {
    const url = $('feedUrl').value.trim();
    if (!url) return;
    const feeds = (state.config.news?.feeds || []).concat({ url, category: $('feedCat').value.trim() || 'News', mood: $('feedMood').value });
    saveConfig({ news: { feeds } }, true).then(renderFeeds);
    $('feedUrl').value = ''; $('feedCat').value = '';
  };

  $('duck').oninput = (e) => { $('duckVal').textContent = `${Math.round(e.target.value * 100)}%`; if (player) player.duckVolume = Number(e.target.value); };
  $('duck').onchange = (e) => saveConfig({ duckVolume: Number(e.target.value) });
  $('crossfade').oninput = (e) => { $('crossVal').textContent = e.target.value; if (player) player.crossfadeSeconds = Number(e.target.value); };
  $('crossfade').onchange = (e) => saveConfig({ crossfadeSeconds: Number(e.target.value) });
}

async function pollBpm() {
  const s = await api.state();
  const b = s.library.bpm || {};
  $('bpmStatus').textContent = b.running ? `Analyzing… ${b.analyzed}/${b.total}` : (b.done ? `Done — analyzed ${b.analyzed} tracks.` : '');
  if (b.running) setTimeout(pollBpm, 1500);
  else { state = s; renderLibStats(); populateGenres(); }
}

// tiny deep-merge for local config mirror
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base ? base[k] : undefined, v);
    return out;
  }
  return patch;
}

boot().catch((e) => hint(`Startup error: ${e.message}`));
