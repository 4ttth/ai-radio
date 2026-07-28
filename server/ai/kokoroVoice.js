// Main-thread manager for the local Kokoro TTS engine. Spawns the worker
// lazily, tracks load status/progress, and dispatches synthesis requests.
//
// Loading pulls ~80MB over the network the first time, so a failed load is a
// normal event, not a fatal one: it's remembered, reported verbatim, and
// retried instead of leaving the DJ mute until the server is restarted.
//
// The retry happens *inside* the existing worker on purpose. onnxruntime-node's
// native binding can only be loaded by one worker thread per process — a second
// one dies with "Module did not self-register" — so this module creates the
// thread at most once and re-drives the load over a message.
import { Worker } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { env, MODELS_DIR } from '../config.js';

const RETRY_COOLDOWN_MS = 15000; // don't hammer a failing download
const SYNTH_TIMEOUT_MS = 120000;

let worker = null;
let spawned = false; // a worker thread has been created in this process
let status = 'idle'; // idle | loading | ready | error
let progress = 0;
let loadError = null;
let voices = [];
let readyPromise = null;
let readyResolve = null;
let lastFailAt = 0;
const pending = new Map();
let seq = 0;

function beginLoading() {
  status = 'loading';
  progress = 0;
  loadError = null;
  readyPromise = new Promise((res) => { readyResolve = res; });
}

function spawn() {
  if (worker) return;
  if (spawned) {
    // The one worker we're allowed died. A replacement can't load the ONNX
    // runtime again, so say so plainly instead of failing cryptically later.
    fail('kokoro worker died and cannot be restarted — restart the server');
    return;
  }
  spawned = true;
  beginLoading();
  mkdirSync(MODELS_DIR, { recursive: true });

  const w = new Worker(new URL('./kokoroWorker.js', import.meta.url), {
    workerData: {
      model: env.kokoroModel,
      dtype: env.kokoroDtype,
      device: env.kokoroDevice,
      defaultVoice: env.kokoroVoice,
      cacheDir: MODELS_DIR,
    },
  });
  worker = w;

  w.on('message', (msg) => {
    switch (msg.type) {
      case 'progress': if (status === 'loading') progress = msg.progress; break;
      case 'ready': status = 'ready'; progress = 100; voices = msg.voices || []; settleReady(true); break;
      case 'loadError': fail(msg.error); break;
      case 'result': resolvePending(msg.id, null, Buffer.from(msg.wav)); break;
      case 'error': resolvePending(msg.id, new Error(msg.error)); break;
      default: break;
    }
  });
  w.on('error', (err) => fail(String((err && err.message) || err)));
  w.on('exit', () => {
    worker = null;
    fail('kokoro worker exited');
  });
}

function settleReady(ok) {
  const resolve = readyResolve;
  readyResolve = null;
  if (resolve) resolve(ok);
}

function fail(message) {
  status = 'error';
  loadError = message;
  lastFailAt = Date.now();
  settleReady(false);
  rejectAllPending(new Error(message));
}

function rejectAllPending(err) {
  for (const [id] of [...pending]) resolvePending(id, err);
}

function resolvePending(id, err, buf) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (err) p.reject(err); else p.resolve(buf);
}

// Start loading the model in the background (safe to call repeatedly).
// `force` bypasses the retry cooldown — use it for explicit user actions.
export function preloadKokoro({ force = false } = {}) {
  if (!worker) {
    spawn();
  } else if (status === 'error' && (force || Date.now() - lastFailAt >= RETRY_COOLDOWN_MS)) {
    // Ask the live worker to try loading again — cached files make a retry
    // after a partial download much cheaper than the first attempt.
    beginLoading();
    worker.postMessage({ type: 'load' });
  }
  return kokoroStatus();
}

export function kokoroStatus() {
  return { status, progress, error: loadError, voices: voices.length };
}

// Synthesize `text` in `voiceName`; assumes the model is (or is becoming) ready.
export async function synthesizeKokoro(text, voiceName) {
  preloadKokoro();
  const ok = await readyPromise;
  const w = worker;
  if (!ok || status !== 'ready' || !w) throw new Error(`kokoro model not ready (${loadError || status})`);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolvePending(id, new Error('kokoro synthesis timed out')),
      SYNTH_TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ type: 'gen', id, text, voice: voiceName });
  });
}
