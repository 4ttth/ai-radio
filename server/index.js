// AI Radio server: serves the web UI and the API, and scans the music
// folder on startup.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env, loadConfig, hasGeminiKey } from './config.js';
import { scan } from './library/scanner.js';
import { ffmpegAvailable } from './library/bpm.js';
import { getModels } from './ai/gemini.js';
import routes from './routes/api.js';

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

  await app.listen({ port: env.port, host: env.host });

  const url = `http://${env.host}:${env.port}`;
  const ff = (await ffmpegAvailable()) ? 'yes' : 'no (BPM analysis disabled)';
  let modelLine = 'n/a (no key)';
  if (hasGeminiKey()) {
    const m = await getModels();
    modelLine = `${m.text} / ${m.tts}${m.discovered ? '' : ' (fallback — model list unavailable)'}`;
  }
  app.log.info('──────────────────────────────────────────────');
  app.log.info(`  📻  AI Radio is on the air:  ${url}`);
  app.log.info(`  Gemini key:  ${hasGeminiKey() ? 'configured' : 'MISSING — add GEMINI_API_KEY to .env'}`);
  app.log.info(`  Models:      ${modelLine}`);
  app.log.info(`  ffmpeg:      ${ff}`);
  app.log.info('──────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Failed to start AI Radio:', err);
  process.exit(1);
});
