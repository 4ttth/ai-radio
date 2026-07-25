// Worker thread: loads Kokoro TTS once and synthesizes speech off the main
// event loop, so CPU inference never stutters music streaming or the API.
import { parentPort, workerData } from 'node:worker_threads';
import { env as tenv } from '@huggingface/transformers';
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
    const audio = await tts.generate(text, { voice });
    const wav = audio.toWav(); // ArrayBuffer of a 24kHz WAV
    parentPort.postMessage({ type: 'result', id, wav }, [wav]); // transfer, no copy
  } catch (e) {
    parentPort.postMessage({ type: 'error', id, error: String((e && e.message) || e) });
  }
});
