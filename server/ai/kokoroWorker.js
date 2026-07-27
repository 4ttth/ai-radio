// Worker thread: loads Kokoro TTS once and synthesizes speech off the main
// event loop, so CPU inference never stutters music streaming or the API.
import { parentPort, workerData } from 'node:worker_threads';
import { env as tenv, RawAudio } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

// Keep the (~80MB) model files under the app's data/ dir instead of a global cache.
if (workerData.cacheDir) tenv.cacheDir = workerData.cacheDir;

let tts = null;
let voiceSet = new Set();

async function load() {
  tts = await KokoroTTS.from_pretrained(workerData.model, {
    dtype: workerData.dtype,
    device: workerData.device,
    progress_callback: (p) => {
      if (p && p.status === 'progress' && p.file) {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : Math.round(p.progress || 0);
        parentPort.postMessage({ type: 'progress', file: p.file, progress: pct });
      }
    },
  });
  voiceSet = new Set(Object.keys(tts.voices || {}));
  parentPort.postMessage({ type: 'ready', voices: [...voiceSet] });
}

load().catch((e) => parentPort.postMessage({ type: 'loadError', error: String((e && e.message) || e) }));

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'gen') return;
  const { id, text } = msg;
  const voice = voiceSet.has(msg.voice) ? msg.voice : workerData.defaultVoice;
  try {
    if (!tts) throw new Error('model not loaded yet');
    // Stream sentence-by-sentence and concatenate. Single-shot generate()
    // tokenizes with truncation, so long scripts get cut off; streaming splits
    // the text first and never truncates.
    const chunks = [];
    let rate = 24000;
    for await (const part of tts.stream(text, { voice })) {
      if (part.audio && part.audio.audio && part.audio.audio.length) {
        chunks.push(part.audio.audio);
        rate = part.audio.sampling_rate || rate;
      }
    }
    if (!chunks.length) throw new Error('no audio produced');
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const wav = new RawAudio(merged, rate).toWav(); // ArrayBuffer of a 24kHz WAV
    parentPort.postMessage({ type: 'result', id, wav }, [wav]); // transfer, no copy
  } catch (e) {
    parentPort.postMessage({ type: 'error', id, error: String((e && e.message) || e) });
  }
});
