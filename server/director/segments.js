// Renders a DJ/news script to speech and caches the audio on disk so the
// same line is never synthesized (or paid for) twice.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { synthesizeSpeech } from '../ai/gemini.js';
import { synthesizeSpeechNative } from '../ai/liveVoice.js';
import { synthesizeKokoro, kokoroStatus, preloadKokoro } from '../ai/kokoroVoice.js';
import { CACHE_DIR, env } from '../config.js';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Cache-key token per engine. Bump one when a change makes already-cached clips
// undesirable — Kokoro moved from 32-bit float WAV to 16-bit PCM, and those old
// files would otherwise be served forever to the browsers that can't play them.
const CACHE_TOKEN = { kokoro: 'kokoro-pcm16' };

// Synthesize `script` in `voiceName` using the chosen engine ('tts' or
// 'native'), cache by content+engine, and return a servable URL. If the native
// (Live API) engine fails, fall back to TTS so the radio keeps talking.
export async function renderVoice(script, voiceName, { engine = 'tts' } = {}) {
  const id = hash(`${CACHE_TOKEN[engine] || engine}::${voiceName}::${script}`);
  const file = path.join(CACHE_DIR, `${id}.wav`);
  let engineUsed = engine;
  if (existsSync(file)) return { id, audioUrl: `/api/audio/${id}`, engineUsed: `${engine} (cached)` };

  let wav;
  if (engine === 'kokoro') {
    // Local model: if it isn't loaded yet, start loading and skip this break
    // (the music keeps playing) rather than blocking on a first-run download.
    if (kokoroStatus().status !== 'ready') {
      const after = preloadKokoro(); // nudges a retry if the last load failed
      const failed = after.status === 'error';
      const e = new Error(failed
        ? `local voice model failed to load: ${after.error}`
        : 'local voice model is still loading');
      // Distinct reasons: "loading" is worth waiting out, "error" needs the user.
      e.reason = failed ? 'kokoro-error' : 'kokoro-loading';
      throw e;
    }
    wav = await synthesizeKokoro(script, voiceName || env.kokoroVoice);
  } else if (engine === 'native') {
    try {
      wav = await synthesizeSpeechNative(script, { voiceName });
    } catch (err) {
      wav = await synthesizeSpeech(script, { voiceName });
      engineUsed = `tts (native failed: ${err.message})`;
    }
  } else {
    wav = await synthesizeSpeech(script, { voiceName });
  }
  await writeFile(file, wav);
  return { id, audioUrl: `/api/audio/${id}`, engineUsed };
}

export function cachePath(id) {
  // Guard against path traversal in the :id param.
  const safe = String(id).replace(/[^a-f0-9]/gi, '').slice(0, 32);
  return path.join(CACHE_DIR, `${safe}.wav`);
}

export async function readCached(id) {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  return readFile(p);
}
