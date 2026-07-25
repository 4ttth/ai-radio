// HTTP API: library, sequencing, AI segments, and audio streaming.
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  loadConfig, saveConfig, getBranding, getDjRoster, loadBranding, hasGeminiKey, env,
} from '../config.js';
import {
  scan, getTracks, getTrack, getFolderRoot, analyzeMissingBpm,
} from '../library/scanner.js';
import { ffmpegAvailable } from '../library/bpm.js';
import { pickNext, listGenres } from '../sequencer/sequencer.js';
import { introScript, handoffScript, welcomeScript, djForHour } from '../ai/dj.js';
import { fetchNews, newsScript } from '../ai/news.js';
import { renderVoice, readCached } from '../director/segments.js';
import { getModels } from '../ai/gemini.js';
import { kokoroStatus, preloadKokoro } from '../ai/kokoroVoice.js';

let bpmProgress = { running: false, analyzed: 0, total: 0, done: false };

const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
};

const publicTrack = (t) => t && ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, genre: t.genre,
  year: t.year, bpm: t.bpm, bpmSource: t.bpmSource, durationSec: t.durationSec,
  streamUrl: `/api/track/${t.id}`,
});

async function buildState() {
  const config = await loadConfig();
  const branding = await getBranding(config.brandingId);
  const roster = await getDjRoster();
  const tracks = getTracks();
  const models = await getModels();
  return {
    hasKey: hasGeminiKey(),
    models: { text: models.text, tts: models.tts, native: models.native, discovered: models.discovered },
    kokoro: kokoroStatus(),
    config,
    branding,
    djRoster: roster,
    onAirDj: djForHour(roster),
    library: {
      folder: config.musicFolder || getFolderRoot() || '',
      count: tracks.length,
      genres: listGenres(tracks),
      ffmpeg: await ffmpegAvailable(),
      untaggedBpm: tracks.filter((t) => !t.bpm).length,
      bpm: bpmProgress,
    },
  };
}

export default async function routes(app) {
  app.get('/api/state', async () => buildState());

  app.get('/api/branding', async () => ({ stations: await loadBranding() }));

  // Which models the key actually has, and which we auto-picked (?refresh=1 to re-check).
  app.get('/api/models', async (req) => getModels(req.query.refresh === '1'));

  // Update config; rescan if the music folder changed.
  app.post('/api/config', async (req) => {
    const patch = req.body || {};
    const before = await loadConfig();
    const cfg = await saveConfig(patch);
    if (patch.musicFolder && patch.musicFolder !== before.musicFolder) {
      await scan(cfg.musicFolder);
    }
    // Start loading the local model as soon as the user selects it.
    if (patch.voiceEngine === 'kokoro') preloadKokoro();
    return buildState();
  });

  // Begin loading the local Kokoro model (returns current load status).
  app.post('/api/kokoro/preload', async () => preloadKokoro());

  // Scan (or rescan) the music folder.
  app.post('/api/scan', async (req) => {
    const folder = (req.body && req.body.folder) || (await loadConfig()).musicFolder || env.musicFolder;
    if (req.body && req.body.folder) await saveConfig({ musicFolder: req.body.folder });
    const result = await scan(folder);
    return { folder, count: result.count, ffmpeg: result.ffmpeg, error: result.error || null };
  });

  // Kick off background BPM analysis for untagged tracks.
  app.post('/api/analyze-bpm', async () => {
    if (bpmProgress.running) return bpmProgress;
    if (!(await ffmpegAvailable())) return { running: false, error: 'ffmpeg not installed' };
    bpmProgress = { running: true, analyzed: 0, total: getTracks().filter((t) => !t.bpm).length, done: false };
    analyzeMissingBpm({
      onProgress: ({ analyzed, total }) => { bpmProgress.analyzed = analyzed; bpmProgress.total = total; },
    }).then((r) => { bpmProgress = { running: false, analyzed: r.analyzed || 0, total: r.total || 0, done: true }; })
      .catch(() => { bpmProgress = { running: false, analyzed: 0, total: 0, done: true, error: true }; });
    return bpmProgress;
  });

  // Next track per the active shuffle mode.
  app.get('/api/next', async (req) => {
    const cfg = await loadConfig();
    const tracks = getTracks();
    if (!tracks.length) return { track: null, reason: 'no-tracks' };
    const lastId = req.query.lastId || null;
    const history = req.query.history ? String(req.query.history).split(',').filter(Boolean) : [];
    const track = await pickNext(tracks, {
      mode: cfg.shuffleMode, lastId, history, genreFilter: cfg.genreFilter,
    });
    return { track: publicTrack(track) };
  });

  // Stream a music file (supports HTTP range requests for seeking).
  app.get('/api/track/:id', async (req, reply) => {
    const track = getTrack(req.params.id);
    if (!track || !existsSync(track.file)) return reply.code(404).send({ error: 'not found' });
    const stat = statSync(track.file);
    const type = MIME[path.extname(track.file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      return reply.code(206).headers({
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      }).send(createReadStream(track.file, { start, end }));
    }
    return reply.headers({
      'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
    }).send(createReadStream(track.file));
  });

  // Serve a cached TTS clip.
  app.get('/api/audio/:id', async (req, reply) => {
    const buf = await readCached(req.params.id);
    if (!buf) return reply.code(404).send({ error: 'not found' });
    return reply.header('Content-Type', 'audio/wav').send(buf);
  });

  // Generate an AI DJ or news segment: script + synthesized audio URL.
  app.post('/api/segment', async (req, reply) => {
    if (!hasGeminiKey()) return { skip: true, reason: 'no-key' };
    const { type = 'intro', currentId, nextId, djId, outgoingId, incomingId } = req.body || {};
    const cfg = await loadConfig();
    const branding = await getBranding(cfg.brandingId);
    const roster = await getDjRoster();
    const current = getTrack(currentId);
    const next = getTrack(nextId);
    // Prefer the DJ the client says is on air (client owns rotation); fall back to clock.
    const byId = (id) => roster.find((d) => d.id === id);
    const onAir = byId(djId) || djForHour(roster);

    try {
      let result;
      if (type === 'news') {
        if (!cfg.news?.enabled) return { skip: true, reason: 'news-disabled' };
        const items = await fetchNews(cfg.news.feeds || [], { maxItems: cfg.news.maxItems || 3 });
        if (!items.length) return { skip: true, reason: 'no-news' };
        result = await newsScript({ branding, dj: onAir, items, defaultMood: cfg.news.defaultMood });
      } else if (type === 'handoff') {
        const outgoing = byId(outgoingId) || onAir;
        const incoming = byId(incomingId) || djForHour(roster, new Date(Date.now() + 3600_000));
        result = await handoffScript({ branding, outgoing, incoming, next });
      } else if (type === 'welcome') {
        result = await welcomeScript({ branding, dj: onAir, next });
      } else {
        result = await introScript({
          branding, dj: onAir, current, next, styleNotes: cfg.dj?.styleNotes || '',
        });
      }

      if (!result || !result.text) return { skip: true, reason: 'empty' };
      const engine = ['native', 'kokoro'].includes(cfg.voiceEngine) ? cfg.voiceEngine : 'tts';
      const voice = engine === 'kokoro'
        ? (result.dj?.kokoroVoice || 'af_heart')
        : (result.dj?.voice || 'Kore');
      const t0 = Date.now();
      const audio = await renderVoice(result.text, voice, { engine });
      req.log.info(`segment(${type}) voice=${voice} engine=${audio.engineUsed} chars=${result.text.length} ms=${Date.now() - t0}`);
      return {
        type,
        script: result.text,
        djName: result.dj?.name || 'DJ',
        voice,
        audioUrl: audio.audioUrl,
      };
    } catch (err) {
      // Local model still downloading/loading — expected, not an error.
      if (err.reason === 'kokoro-loading') return { skip: true, reason: 'kokoro-loading' };
      req.log.warn(`segment(${type}) failed: ${err.message}`);
      // Never let an AI hiccup stop the music — the client just skips the talk.
      return { skip: true, reason: err.reason || 'error', message: err.message, rateLimited: err.rateLimited || false };
    }
  });
}
