// Renders a DJ/news script to speech and caches the audio on disk so the
// same line is never synthesized (or paid for) twice.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { synthesizeSpeech } from '../ai/gemini.js';
import { CACHE_DIR } from '../config.js';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Synthesize `script` in `voiceName`, cache by content, return a servable URL.
export async function renderVoice(script, voiceName) {
  const id = hash(`${voiceName}::${script}`);
  const file = path.join(CACHE_DIR, `${id}.wav`);
  if (!existsSync(file)) {
    const wav = await synthesizeSpeech(script, { voiceName });
    await writeFile(file, wav);
  }
  return { id, audioUrl: `/api/audio/${id}` };
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
