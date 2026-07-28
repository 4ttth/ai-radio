// Worker thread: loads Kokoro TTS once and synthesizes speech off the main
// event loop, so CPU inference never stutters music streaming or the API.
//
// This thread is created once per process and reused forever: onnxruntime-node's
// native binding can only be loaded by a single worker thread ("Module did not
// self-register" on the second one), so a failed load is retried *in place* via
// a 'load' message rather than by respawning the thread.
import { parentPort, workerData } from 'node:worker_threads';
import { env as tenv } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { pcmToWav, floatToPcm16 } from './wav.js';

// Keep the (~80MB) model files under the app's data/ dir instead of a global cache.
if (workerData.cacheDir) tenv.cacheDir = workerData.cacheDir;

let tts = null;
let loading = false;
let voiceSet = new Set();

async function load() {
  if (tts || loading) return; // already usable, or an attempt is in flight
  loading = true;
  try {
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
  } catch (e) {
    tts = null;
    parentPort.postMessage({ type: 'loadError', error: String((e && e.message) || e) });
  } finally {
    loading = false;
  }
}

load();

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'load') {
    // Retry after a failed load. Always answer, even when there's nothing to
    // do, so the main thread never waits on a reply that isn't coming.
    if (tts) parentPort.postMessage({ type: 'ready', voices: [...voiceSet] });
    else load();
    return;
  }
  if (msg.type !== 'gen') return;
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
    // 16-bit PCM, same shape as the Gemini engines produce.
    const wav = pcmToWav(floatToPcm16(merged), { sampleRate: rate, channels: 1 });
    const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    parentPort.postMessage({ type: 'result', id, wav: buf }, [buf]); // transfer, no copy
  } catch (e) {
    parentPort.postMessage({ type: 'error', id, error: String((e && e.message) || e) });
  }
});
