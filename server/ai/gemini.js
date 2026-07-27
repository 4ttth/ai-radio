// Gemini API client: text generation + text-to-speech, with a gentle
// request throttle so a listening session stays inside free-tier limits.
import { env, hasGeminiKey } from '../config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ── Throttle: space requests to stay under GEMINI_MAX_RPM ──────
let chain = Promise.resolve();
let lastStart = 0;
function throttle() {
  // Clamp RPM to a sane range so a blank/0/huge value can't wedge us
  // (e.g. rpm 0 would otherwise space calls 60s apart).
  const rpm = Math.min(60, Math.max(1, env.maxRpm || 8));
  const minGap = 60000 / rpm;
  const run = chain.then(async () => {
    const wait = Math.max(0, lastStart + minGap - Date.now());
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  });
  // Keep the chain alive even if one call rejects.
  chain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a hard timeout so a stalled request can never hang forever.
async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.rateLimited = status === 429;
  }
}

async function callModel(model, body, { retries = 2, timeout = 60000 } = {}) {
  if (!hasGeminiKey()) {
    throw new GeminiError('No Gemini API key configured (set GEMINI_API_KEY in .env).', 401);
  }
  const url = `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(env.geminiKey)}`;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await throttle();
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, timeout);
    } catch (netErr) {
      // A timeout means "too slow" — don't keep retrying and stacking delay.
      if (netErr.name === 'AbortError') {
        throw new GeminiError(`Gemini ${model} timed out after ${timeout}ms`, 504);
      }
      if (attempt++ < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GeminiError(`Network error calling Gemini: ${netErr.message}`, 0);
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    // Back off and retry on rate-limit / transient server errors.
    if ((res.status === 429 || res.status >= 500) && attempt++ < retries) {
      await sleep(1200 * 2 ** attempt);
      continue;
    }
    throw new GeminiError(`Gemini ${model} → ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
}

// ── Model resolution ──────────────────────────────────────────
// Models get retired often, so instead of trusting a hardcoded name we ask
// the key which models it actually has (ListModels) and pick the best. A blank
// .env means "auto"; an override is honored only if it's real and available.
const FALLBACK = {
  text: 'gemini-flash-latest',
  tts: 'gemini-3.1-flash-tts-preview',
  native: 'gemini-2.5-flash-native-audio-latest',
};
// Known-dead IDs we must never use, even if left over in a stale .env.
const RETIRED = new Set([
  'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-pro',
  'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro', 'gemini-pro',
]);

let modelCache = null;

async function listModels() {
  if (!hasGeminiKey()) return [];
  try {
    const res = await fetchWithTimeout(`${BASE}/models?pageSize=1000&key=${encodeURIComponent(env.geminiKey)}`, {}, 10000);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({
      id: (m.name || '').replace(/^models\//, ''),
      methods: m.supportedGenerationMethods || m.supportedActions || [],
    }));
  } catch {
    return [];
  }
}

const ver = (id) => parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);

function scoreText(id) {
  const n = id.toLowerCase();
  if (/(embedding|imagen|image|vision|tts|aqa|learnlm|gemma)/.test(n)) return -1;
  let s = n.includes('latest') ? 5000 : ver(id) * 100;
  if (n.includes('flash') && !n.includes('lite')) s += 400;
  else if (n.includes('flash')) s += 250;
  else if (n.includes('pro')) s += 300;
  else s -= 100;
  if (n.includes('preview') || n.includes('exp')) s -= 30;
  return s;
}

function scoreTts(id) {
  const n = id.toLowerCase();
  if (!n.includes('tts')) return -1;
  let s = n.includes('latest') ? 5000 : ver(id) * 100;
  if (n.includes('flash')) s += 200;
  return s;
}

function scoreNative(id) {
  const n = id.toLowerCase();
  if (!n.includes('native-audio')) return -1;
  let s = n.includes('latest') ? 5000 : ver(id) * 100;
  if (n.includes('dialog')) s += 50;
  if (n.includes('thinking')) s -= 20; // prefer plain dialog for a voice-over
  return s;
}

function bestBy(list, scorer) {
  let best = null;
  let bestScore = 0;
  for (const m of list) {
    const sc = scorer(m.id);
    if (sc > bestScore) { bestScore = sc; best = m.id; }
  }
  return best;
}

function useOverride(override, list) {
  if (!override) return null;
  if (RETIRED.has(override)) return null;
  if (list.length && !list.some((m) => m.id === override)) return null; // not available to this key
  return override;
}

export async function getModels(force = false) {
  if (modelCache && !force) return modelCache;
  const list = await listModels();
  const gen = list.filter((m) => !m.methods.length || m.methods.includes('generateContent'));
  modelCache = {
    text: useOverride(env.textModel, list) || bestBy(gen, scoreText) || FALLBACK.text,
    tts: useOverride(env.ttsModel, list) || bestBy(list, scoreTts) || FALLBACK.tts,
    native: useOverride(env.nativeModel, list) || bestBy(list, scoreNative) || FALLBACK.native,
    discovered: list.length > 0,
    available: list.map((m) => m.id),
  };
  return modelCache;
}

// Run `fn(model)` with the resolved model for `kind`; if it 404s (retired/
// unknown), re-discover once and retry with a fresh pick.
async function withModel(kind, fn) {
  const models = await getModels();
  try {
    return await fn(models[kind]);
  } catch (e) {
    if (e && e.status === 404) {
      const fresh = await getModels(true);
      if (fresh[kind] && fresh[kind] !== models[kind]) return fn(fresh[kind]);
    }
    throw e;
  }
}

// ── Text generation ───────────────────────────────────────────
let noThinking = false; // set true if the text model rejects thinkingConfig

export async function generateText(prompt, { temperature = 0.9, maxOutputTokens = 512, json = false } = {}) {
  const base = { temperature, maxOutputTokens };
  if (json) base.responseMimeType = 'application/json';
  const run = (cfg) => withModel('text', (model) => callModel(model, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: cfg,
  }, { timeout: 30000 }));

  let data;
  try {
    // Disable "thinking" so reasoning tokens don't consume the output budget
    // and truncate the script. Some models reject it — fall back if so.
    data = await run(noThinking ? base : { ...base, thinkingConfig: { thinkingBudget: 0 } });
  } catch (e) {
    if (!noThinking && e.status === 400 && /think/i.test(e.message || '')) {
      noThinking = true;
      data = await run(base);
    } else {
      throw e;
    }
  }

  const cand = data?.candidates?.[0];
  const out = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (cand?.finishReason === 'MAX_TOKENS') {
    console.warn(`[gemini] text hit MAX_TOKENS (maxOutputTokens=${maxOutputTokens}); output may be truncated.`);
  }
  return out;
}

export async function generateJson(prompt, opts = {}) {
  const raw = await generateText(prompt, { ...opts, json: true });
  try {
    return JSON.parse(raw);
  } catch {
    // Best-effort: pull the first {...} or [...] block out of the response.
    const match = raw.match(/[[{][\s\S]*[\]}]/);
    if (match) return JSON.parse(match[0]);
    throw new GeminiError(`Could not parse JSON from model: ${raw.slice(0, 200)}`, 422);
  }
}

// ── Text-to-speech ────────────────────────────────────────────
// Returns a Buffer containing a playable WAV file.
export async function synthesizeSpeech(text, { voiceName = 'Kore' } = {}) {
  const data = await withModel('tts', (model) => callModel(model, {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  }, { timeout: 60000 }));

  const inline = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) {
    throw new GeminiError('Gemini TTS returned no audio.', 502);
  }
  const pcm = Buffer.from(inline.data, 'base64');
  const rate = parseRate(inline.mimeType) || 24000;
  return pcmToWav(pcm, { sampleRate: rate, channels: 1, bitsPerSample: 16 });
}

function parseRate(mimeType = '') {
  const m = /rate=(\d+)/.exec(mimeType);
  return m ? Number(m[1]) : null;
}

// Wrap raw little-endian 16-bit PCM in a 44-byte WAV header.
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
