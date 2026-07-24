// CLI: scan the configured (or given) music folder and print a summary.
//   npm run scan -- "/path/to/music"
import { loadConfig, env } from '../config.js';
import { scan, getTracks } from '../library/scanner.js';
import { ffmpegAvailable } from '../library/bpm.js';

const folder = process.argv[2] || (await loadConfig()).musicFolder || env.musicFolder;
if (!folder) {
  console.error('No folder given. Usage: npm run scan -- "/path/to/music"');
  process.exit(1);
}

const res = await scan(folder);
const tracks = getTracks();
const withBpm = tracks.filter((t) => t.bpm).length;
const genres = new Set(tracks.map((t) => t.genre).filter(Boolean));

console.log(`\nScanned: ${folder}`);
console.log(`Tracks:  ${res.count}`);
console.log(`Genres:  ${genres.size} (${[...genres].slice(0, 10).join(', ')}${genres.size > 10 ? '…' : ''})`);
console.log(`BPM:     ${withBpm} tagged, ${res.count - withBpm} missing`);
console.log(`ffmpeg:  ${(await ffmpegAvailable()) ? 'available (BPM analysis possible)' : 'not found'}`);
console.log('');
