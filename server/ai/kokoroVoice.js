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

// Synthesis budgets. CPU inference is roughly linear in text length, and a news
// bulletin is several times an intro, so a flat timeout either cuts long clips
// off or waits absurdly long for short ones. The clock starts when the worker
// picks the job up (see the 'started' message) — never while it sits in the
// queue — and these numbers are deliberately loose: they exist to catch a wedged
// run, not to police a slow machine.
const QUEUE_TIMEOUT_MS = 300000; // worker never even started the job
const SYNTH_BASE_MS = 60000;
const SYNTH_PER_CHAR_MS = 250; // ~4 chars/sec floor
const SYNTH_MAX_MS = 300000;

const synthBudget = (text) => Math.min(SYNTH_MAX_MS, SYNTH_BASE_MS + text.length * SYNTH_PER_CHAR_MS);

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
      case 'started': restartTimer(msg.id); break;
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

// The worker has this job in hand now: swap the queue watchdog for the real
// synthesis budget, so waiting its turn cost it nothing.
function restartTimer(id) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.startedAt = Date.now();
  p.timer = setTimeout(
    () => resolvePending(id, new Error(`kokoro synthesis timed out after ${Math.round(p.budget / 1000)}s (${p.chars} chars)`)),
    p.budget,
  );
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
    // Until the worker says it started, only guard against it never starting.
    const timer = setTimeout(
      () => resolvePending(id, new Error('kokoro synthesis never started (worker busy or stuck)')),
      QUEUE_TIMEOUT_MS,
    );
    pending.set(id, {
      resolve, reject, timer, chars: text.length, budget: synthBudget(text),
    });
    w.postMessage({ type: 'gen', id, text, voice: voiceName });
  });
}
