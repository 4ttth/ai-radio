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
let _ollamaModels = [];

// Ask Ollama for its installed models: proves the daemon is up *and* tells us
// whether the model we're configured to use is actually pulled.
export async function checkOllama() {
  if (!ollamaConfigured()) {
    _ollamaOk = false;
    _ollamaModels = [];
    return false;
  }
  try {
    const res = await fetchWithTimeout(`${env.ollamaUrl}/api/tags`, {}, 5000);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json().catch(() => ({}));
    _ollamaModels = (data.models || []).map((m) => m.name).filter(Boolean);
    _ollamaOk = true;
  } catch {
    _ollamaOk = false;
    _ollamaModels = [];
  }
  return _ollamaOk;
}

export function isOllamaReachable() {
  return _ollamaOk === true;
}

export function ollamaModels() {
  return _ollamaModels.slice();
}

// Ollama tags carry a ":tag" suffix ("phi4-mini:latest"), so match on the
// base name too — otherwise a perfectly good install looks missing.
export function hasOllamaModel(name = env.ollamaModel) {
  if (!_ollamaModels.length) return null; // unknown (not checked / unreachable)
  const want = String(name).split(':')[0];
  return _ollamaModels.some((m) => m === name || m.split(':')[0] === want);
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
    if (res.status === 404) {
      throw new OllamaError(`Ollama has no model "${env.ollamaModel}" — run: ollama pull ${env.ollamaModel}`, 404);
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
    const match = raw.match(/[[{][\s\S]*[\]}]/);
    if (match) return JSON.parse(match[0]);
    throw new OllamaError(`Could not parse JSON from model: ${raw.slice(0, 200)}`, 422);
  }
}
