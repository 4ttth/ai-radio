// Gemini API client: text generation + text-to-speech, with a gentle
// request throttle so a listening session stays inside free-tier limits.
import { env, hasGeminiKey } from '../config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ── Throttle: space requests to stay under GEMINI_MAX_RPM ──────
let chain = Promise.resolve();
let lastStart = 0;
function throttle() {
  const minGap = 60000 / Math.max(1, env.maxRpm);
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

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.rateLimited = status === 429;
  }
}

async function callModel(model, body, { retries = 2 } = {}) {
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
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
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

// ── Text generation ───────────────────────────────────────────
export async function generateText(prompt, { temperature = 0.9, maxOutputTokens = 512, json = false } = {}) {
  const generationConfig = { temperature, maxOutputTokens };
  if (json) generationConfig.responseMimeType = 'application/json';

  const data = await callModel(env.textModel, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const out = parts.map((p) => p.text || '').join('').trim();
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
  const data = await callModel(env.ttsModel, {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  });

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
