// Text-generation router. DJ scripts, news bulletins and AI sequencing all go
// through here so the rest of the app never cares who wrote the words.
//
// Ollama wins whenever OLLAMA_URL is set — that makes a fully local station
// (Ollama for text + Kokoro for voice) work with no Gemini key at all. Gemini
// is used otherwise, and as a fallback if a local generation fails but a key
// happens to be configured.
import { hasGeminiKey, hasOllama, env } from '../config.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';

// 'ollama' | 'gemini' | null (null = no text backend configured at all)
export function provider() {
  if (hasOllama()) return 'ollama';
  if (hasGeminiKey()) return 'gemini';
  return null;
}

export function hasTextProvider() {
  return provider() !== null;
}

// What the UI/banner shows for "who writes the scripts".
export function textProviderLabel() {
  const p = provider();
  if (p === 'ollama') return `Ollama · ${env.ollamaModel}`;
  if (p === 'gemini') return 'Gemini';
  return 'none';
}

class NoTextProviderError extends Error {
  constructor() {
    super('No text backend configured — set OLLAMA_URL (local) or GEMINI_API_KEY in .env.');
    this.name = 'NoTextProviderError';
    this.reason = 'no-text-provider';
  }
}

async function route(fn, ...args) {
  const p = provider();
  if (!p) throw new NoTextProviderError();
  if (p === 'gemini') return gemini[fn](...args);
  try {
    return await ollama[fn](...args);
  } catch (err) {
    // A local model being down shouldn't silence the station if a key exists.
    if (!hasGeminiKey()) throw err;
    console.warn(`[text] Ollama failed (${err.message}) — falling back to Gemini.`);
    return gemini[fn](...args);
  }
}

export function generateText(prompt, opts = {}) {
  return route('generateText', prompt, opts);
}

export function generateJson(prompt, opts = {}) {
  return route('generateJson', prompt, opts);
}
