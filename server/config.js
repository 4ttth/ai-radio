// Central configuration: environment + persisted, UI-editable station settings.
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'station.default.json');
const BRANDING_PATH = path.join(ROOT, 'branding', 'stations.json');

// ── Environment ───────────────────────────────────────────────
export const env = {
  geminiKey: process.env.GEMINI_API_KEY || '',
  // Blank = auto-detect the best available model for this key (see ai/gemini.js).
  textModel: process.env.GEMINI_TEXT_MODEL || '',
  ttsModel: process.env.GEMINI_TTS_MODEL || '',
  maxRpm: Number(process.env.GEMINI_MAX_RPM || 8),
  musicFolder: process.env.MUSIC_FOLDER || '',
  port: Number(process.env.PORT || 4123),
  host: process.env.HOST || '127.0.0.1',
};

export function hasGeminiKey() {
  return Boolean(env.geminiKey && env.geminiKey.trim() && env.geminiKey !== 'your-gemini-api-key-here');
}

// ── Branding catalogue (the six station imagings) ─────────────
let brandingCache = null;
export async function loadBranding() {
  if (!brandingCache) {
    const raw = await readFile(BRANDING_PATH, 'utf8');
    brandingCache = JSON.parse(raw).stations;
  }
  return brandingCache;
}

export async function getBranding(id) {
  const stations = await loadBranding();
  return stations.find((s) => s.id === id) || stations[0];
}

// ── Persisted, editable station config ────────────────────────
let configCache = null;

export async function loadConfig() {
  if (configCache) return configCache;
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  let cfg;
  if (existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } else {
    cfg = JSON.parse(await readFile(DEFAULT_CONFIG_PATH, 'utf8'));
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }

  // Music folder from env takes precedence if the config doesn't have one yet.
  if (!cfg.musicFolder && env.musicFolder) cfg.musicFolder = env.musicFolder;

  configCache = cfg;
  return cfg;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = deepMerge(current, patch);
  configCache = next;
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// Resolve the active DJ roster: branding DJs are the base; config may override.
export async function getDjRoster() {
  const cfg = await loadConfig();
  const branding = await getBranding(cfg.brandingId);
  if (Array.isArray(cfg.djs) && cfg.djs.length) return cfg.djs;
  return branding.djs;
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = deepMerge(base ? base[k] : undefined, v);
    }
    return out;
  }
  return patch;
}
