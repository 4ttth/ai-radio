// Main-thread manager for the local Kokoro TTS engine. Spawns the worker
// lazily, tracks load status/progress, and dispatches synthesis requests.
import { Worker } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { env, MODELS_DIR } from '../config.js';

let worker = null;
let status = 'idle'; // idle | loading | ready | error
let progress = 0;
let loadError = null;
let voices = [];
let readyPromise = null;
let readyResolve = null;
const pending = new Map();
let seq = 0;

function spawn() {
  if (worker) return;
  status = 'loading';
  progress = 0;
  loadError = null;
  readyPromise = new Promise((res) => { readyResolve = res; });
  mkdirSync(MODELS_DIR, { recursive: true });

  worker = new Worker(new URL('./kokoroWorker.js', import.meta.url), {
    workerData: {
      model: env.kokoroModel,
      dtype: env.kokoroDtype,
      device: env.kokoroDevice,
      defaultVoice: env.kokoroVoice,
      cacheDir: MODELS_DIR,
    },
  });

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'progress': progress = msg.progress; break;
      case 'ready': status = 'ready'; voices = msg.voices || []; readyResolve && readyResolve(true); break;
      case 'loadError': status = 'error'; loadError = msg.error; readyResolve && readyResolve(false); break;
      case 'result': resolvePending(msg.id, null, Buffer.from(msg.wav)); break;
      case 'error': resolvePending(msg.id, new Error(msg.error)); break;
      default: break;
    }
  });
  worker.on('error', (err) => { fail(String((err && err.message) || err)); });
  worker.on('exit', () => {
    worker = null;
    if (status !== 'error') status = 'idle';
    for (const [, p] of pending) p.reject(new Error('kokoro worker exited'));
    pending.clear();
  });
}

function fail(message) {
  status = 'error';
  loadError = message;
  readyResolve && readyResolve(false);
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}

function resolvePending(id, err, buf) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (err) p.reject(err); else p.resolve(buf);
}

// Start loading the model in the background (safe to call repeatedly).
export function preloadKokoro() {
  spawn();
  return kokoroStatus();
}

export function kokoroStatus() {
  return { status, progress, error: loadError, voices: voices.length };
}

// Synthesize `text` in `voiceName`; assumes the model is (or is becoming) ready.
export async function synthesizeKokoro(text, voiceName) {
  spawn();
  const ok = await readyPromise;
  if (!ok || status !== 'ready') throw new Error(`kokoro model not ready (${loadError || status})`);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'gen', id, text, voice: voiceName });
    setTimeout(() => resolvePending(id, new Error('kokoro synthesis timed out')), 120000);
  });
}
