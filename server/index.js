// AI Radio server: serves the web UI and the API, and scans the music
// folder on startup.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env, loadConfig, hasGeminiKey, hasOllama } from './config.js';
import { scan } from './library/scanner.js';
import { ffmpegAvailable } from './library/bpm.js';
import { getModels } from './ai/gemini.js';
import { textProviderLabel } from './ai/text.js';
import { checkOllama, hasOllamaModel } from './ai/ollama.js';
import { preloadKokoro } from './ai/kokoroVoice.js';
import routes, { resolveVoiceEngine } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function main() {
  const app = Fastify({ logger: { level: 'info', transport: undefined } });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  await app.register(routes);

  const cfg = await loadConfig();

  // Initial scan (non-fatal if the folder isn't set yet).
  if (cfg.musicFolder) {
    const res = await scan(cfg.musicFolder);
    app.log.info(`Scanned "${cfg.musicFolder}": ${res.count} tracks`);
  } else {
    app.log.info('No music folder set yet — configure one in the web UI.');
  }

  // Probe the local text backend before we announce anything about it.
  let ollamaLine = 'not configured';
  if (hasOllama()) {
    const up = await checkOllama();
    const installed = hasOllamaModel();
    ollamaLine = up
      ? `${env.ollamaUrl} · ${env.ollamaModel}${installed === false ? ` — MODEL NOT PULLED (run: ollama pull ${env.ollamaModel})` : ''}`
      : `${env.ollamaUrl} — UNREACHABLE (is the ollama daemon running?)`;
  }

  // The local voice model takes a while to download/load the first time, so
  // start it at boot rather than at the first DJ break.
  const voiceEngine = resolveVoiceEngine(cfg);
  if (voiceEngine === 'kokoro') preloadKokoro();

  await app.listen({ port: env.port, host: env.host });

  const url = `http://${env.host}:${env.port}`;
  const ff = (await ffmpegAvailable()) ? 'yes' : 'no (BPM analysis disabled)';
  let modelLine = 'n/a (no key)';
  if (hasGeminiKey()) {
    const m = await getModels();
    modelLine = `text ${m.text} · tts ${m.tts} · native ${m.native}${m.discovered ? '' : ' (fallback — model list unavailable)'}`;
  }
  const voiceLabel = voiceEngine === 'native' ? 'native audio (Live API)'
    : voiceEngine === 'kokoro' ? `local Kokoro (${env.kokoroDtype}, CPU)` : 'Gemini TTS';
  const forced = voiceEngine !== (cfg.voiceEngine || 'tts') ? ' (no Gemini key — using the local engine)' : '';
  app.log.info('──────────────────────────────────────────────');
  app.log.info(`  📻  AI Radio is on the air:  ${url}`);
  app.log.info(`  Scripts:     ${textProviderLabel()}`);
  app.log.info(`  Ollama:      ${ollamaLine}`);
  app.log.info(`  Gemini key:  ${hasGeminiKey() ? 'configured' : 'not set'}`);
  app.log.info(`  Voice:       ${voiceLabel}${forced}`);
  app.log.info(`  Models:      ${modelLine}`);
  app.log.info(`  ffmpeg:      ${ff}`);
  app.log.info('──────────────────────────────────────────────');
  if (!hasOllama() && !hasGeminiKey()) {
    app.log.warn('No text backend: set OLLAMA_URL (local) or GEMINI_API_KEY in .env — the station will play music but the DJs stay silent.');
  }
}

main().catch((err) => {
  console.error('Failed to start AI Radio:', err);
  process.exit(1);
});
