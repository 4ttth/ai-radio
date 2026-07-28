// Ollama client: text generation via phi4-mini (local, free, no API key).
// Talks to Ollama's OpenAI-compatible API for local LLM inference.
import { env, hasOllama as ollamaConfigured } from '../config.js';

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

export class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
    this.rateLimited = false; // local model never rate-limits
  }
}

// ── Health check ──────────────────────────────────────────────
let _ollamaOk = null;
export async function checkOllama() {
  try {
    const res = await fetchWithTimeout(env.ollamaUrl, {}, 5000);
    _ollamaOk = res.ok;
  } catch {
    _ollamaOk = false;
  }
  return _ollamaOk;
}

export function isOllamaReachable() {
  return _ollamaOk === true;
}

// ── Text generation via Ollama OpenAI-compatible API ──────────
async function callOllama(messages, { temperature = 0.9, maxTokens = 512, jsonMode = false, retries = 2, timeout = 120000 } = {}) {
  if (!ollamaConfigured()) {
    throw new OllamaError('Ollama is not configured — check OLLAMA_URL in .env.', 0);
  }

  const url = `${env.ollamaUrl}/v1/chat/completions`;
  const body = {
    model: env.ollamaModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, timeout);
    } catch (netErr) {
      if (netErr.name === 'AbortError') {
        throw new OllamaError(`Ollama timed out after ${timeout}ms`, 504);
      }
      if (attempt++ < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new OllamaError(`Network error calling Ollama: ${netErr.message}`, 0);
    }

    if (res.ok) {
      const data = await res.json();
      return data;
    }

    const text = await res.text().catch(() => '');
    if (res.status >= 500 && attempt++ < retries) {
      await sleep(1200 * 2 ** attempt);
      continue;
    }
    throw new OllamaError(`Ollama ${env.ollamaModel} → ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
}

// ── Public API ────────────────────────────────────────────────

export async function generateText(prompt, { temperature = 0.9, maxOutputTokens = 512, json = false } = {}) {
  const data = await callOllama(
    [{ role: 'user', content: prompt }],
    { temperature, maxTokens: maxOutputTokens, jsonMode: json, timeout: 120000 },
  );

  const out = (data?.choices?.[0]?.message?.content || '').trim();
  if (data?.choices?.[0]?.finish_reason === 'length') {
    console.warn(`[ollama] text hit max_tokens (${maxOutputTokens}); raise it if scripts cut off.`);
  }
  return out;
}

export async function generateJson(prompt, opts = {}) {
  const raw = await generateText(prompt, { ...opts, json: true });
  try {
    return JSON.parse(raw);
  } catch {
    // Best-effort: pull the first {...} or [...] block out of the response.
    const match = raw.match(/[{[][\\s\\S]*[\\]}]/);
    if (match) return JSON.parse(match[0]);
    throw new OllamaError(`Could not parse JSON from model: ${raw.slice(0, 200)}`, 422);
  }
}

// ── Utility: wrap raw PCM in a WAV header ─────────────────────
// (Kept here as a shared utility used by Kokoro and other voice modules.)
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
