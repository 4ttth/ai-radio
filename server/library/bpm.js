// Optional BPM analysis for tracks whose tags don't include tempo.
// Uses ffmpeg (if installed) to decode audio to raw PCM, then estimates
// tempo with music-tempo. If ffmpeg is missing, we simply skip analysis.
import { spawn } from 'node:child_process';
import MusicTempo from 'music-tempo';

let ffmpegOk = null;

export async function ffmpegAvailable() {
  if (ffmpegOk !== null) return ffmpegOk;
  ffmpegOk = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  return ffmpegOk;
}

// Decode up to `seconds` of audio to mono float32 PCM at `rate` Hz.
function decodePcm(file, { rate = 22050, seconds = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'];
    const p = spawn('ffmpeg', args);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) return reject(new Error(`ffmpeg exited ${code}`));
      const buf = Buffer.concat(chunks);
      // Reinterpret bytes as Float32.
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      resolve({ samples, rate });
    });
  });
}

export async function analyzeBpm(file) {
  if (!(await ffmpegAvailable())) return null;
  const { samples } = await decodePcm(file);
  if (!samples || samples.length < 22050 * 5) return null; // need a few seconds

  // music-tempo mutates/reads a plain array-like of samples.
  const mt = new MusicTempo(Array.from(samples));
  const tempo = Math.round(Number(mt.tempo));
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 220) return null;
  return tempo;
}
