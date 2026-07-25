# 📻 AI Radio

Turn a folder of music into your own AI-powered radio station — with rotating AI **DJs** who talk over the mix, describe the next song's name, artist and *feel*, hand off to each other every hour, and read **news** from RSS feeds you choose. Powered by the **Google Gemini API** (text + text-to-speech).

Runs as a small local web app: a Node backend scans your library and generates the AI segments; your browser handles smooth playback, crossfades, and talk-over ducking with the Web Audio API.

---

## Features

- **Streams music from a folder** you pick, with four+ shuffle modes:
  - **Per beat** — BPM ascending or descending
  - **Random**
  - **By genre** (from tags)
  - **Let AI pick** — Gemini sequences tracks for good energy flow
- **AI DJs** with distinct Gemini voices that:
  - Introduce the next track — name, artist, and a vivid sense of its *feel* — talking over the transition
  - **Hand off every hour**: *"That's it for me folks, I'm Vega — let's welcome Flux to the mic."*
  - Duck the music smoothly while they talk (configurable)
- **News breaks** from **your RSS feeds** — add as many as you like, each tagged with a **category** and a **mood** (Serious / Upbeat / Snarky / Calm) that flavors how the DJ reads it, with a natural segue in and out.
- **Editable station name** and **six ready-made brandings** ("station imaging") spanning Electronic, Pop, Hip-hop/R&B, Rock/Indie, eclectic, and soulful crossover — each with its own colors, logo, DJ roster, and on-air imaging lines.
- **Free-tier friendly**: segments are pre-generated a song ahead, every clip is cached on disk, requests are throttled, and it backs off automatically on rate limits.

---

## The six brandings

| Station | Format | Vibe |
|---|---|---|
| **Neon Pulse** | Electronic / Dance | Late-night, futuristic, "the city never sleeps" |
| **Golden Hour** | Pop / Top 40 | Bright, warm, "today's biggest hits" |
| **The Cipher** | Hip-hop / R&B | Smooth, confident, "where the beat lives" |
| **Static & Stone** | Rock / Indie / Alt | Gritty, guitar-forward, "loud since day one" |
| **Driftwave** | Eclectic / chill | Curatorial, genre-fluid, "everything, and the vibe in between" |
| **Aurelia FM** | Soulful crossover | Velvety, worldly, "sound with a little soul" |

Pick one in the UI (it recolors the whole app and swaps the DJ roster), rename the station to your brand, or edit `branding/stations.json` to make your own.

---

## Quick start

```bash
# 1. Install dependencies (needs Node 18.17+; Node 20+ recommended)
npm install

# 2. Configure your key
cp .env.example .env
#    then edit .env and set GEMINI_API_KEY=...   (get one at https://aistudio.google.com/apikey)

# 3. Run
npm start
#    → open http://127.0.0.1:4123
```

In the browser: set your **music folder** path → **Scan** → press **▶**. Add RSS feeds and tweak DJ/news cadence in the side panel.

> Without a Gemini key the station still **plays music** — the DJs and news are simply silent until a key is set. This makes it easy to try the player first.

See **[docs/SETUP.md](docs/SETUP.md)** for getting a Gemini key, installing ffmpeg (for BPM analysis), and troubleshooting.

---

## How things work

- **Tags & filenames** — metadata (title, artist, album, genre, BPM, year) is read from ID3/tags via `music-metadata`. When a file has no tags, the title/artist are parsed from the filename (`Artist - Title.mp3`).
- **BPM** — used by the "per beat" modes. Read from tags first; for untagged files, click **Analyze BPM** to estimate tempo (requires **ffmpeg** on your PATH). Analyzed values are cached next to your music in `.ai-radio-cache.json`. No ffmpeg? Those tracks just sort last in BPM modes — everything else still works.
- **"Feel" of a song** — inferred by Gemini from the artist, title, genre and BPM. No internet lookup; the model already knows a lot of popular music.
- **Talk-over** — the browser ducks the music bus while a DJ clip plays, then lifts it. Turn it off to have DJs speak in the gap instead.
- **Pre-generation & caching** — while a song plays, the next DJ/news segment is written and synthesized in advance and cached in `data/cache/`, so transitions are ready on time and identical lines are never re-synthesized.

---

## Configuration

`.env` (never committed):

| Key | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | Your Gemini key (`AIzaSy…`) |
| `GEMINI_TEXT_MODEL` | *(auto)* | Force a text model; blank auto-detects the best your key has |
| `GEMINI_TTS_MODEL` | *(auto)* | Force a TTS model; blank auto-detects the best your key has |
| `GEMINI_NATIVE_MODEL` | *(auto)* | Force the native-audio (Live API) model; used only when Voice engine = Native |
| `KOKORO_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | Local TTS model (used when Voice engine = Local) |
| `KOKORO_DTYPE` | `q8` | Local model precision: `fp32` / `fp16` / `q8` / `q4` / `q4f16` |
| `KOKORO_DEVICE` | `cpu` | `cpu` (Node) or `webgpu` |
| `KOKORO_DEFAULT_VOICE` | `af_heart` | Fallback Kokoro voice if a DJ's voice is unset/invalid |
| `GEMINI_MAX_RPM` | `8` | Request-per-minute throttle (raise on a paid key) |
| `MUSIC_FOLDER` | — | Optional default library path |
| `PORT` / `HOST` | `4123` / `127.0.0.1` | Server bind |

Everything else (station name, branding, shuffle mode, DJ cadence, feeds, duck level, crossfade) is edited live in the UI and saved to `data/config.json`.

### Voice engines

Under **AI DJ → Voice engine** you can pick how DJ/news audio is produced:

- **Gemini TTS** (default) — the dedicated Gemini TTS model over a simple REST call. Reads scripts and news *verbatim*, is cheap, and caches perfectly. Best for a radio station. Free-tier requests/minute are limited, which is why segments are pre-generated and cached.
- **Gemini native audio (Live API)** — a native-audio model over a WebSocket (`BidiGenerateContent`). More expressive/natural and uses a different quota model (sessions rather than strict RPM), but it's conversational by design, so it's pinned with a system instruction to read text verbatim. **Experimental.** If a live session fails for any reason, it automatically falls back to the TTS model so the radio never goes silent.
- **Local · Kokoro TTS** — the open-source [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model running **100% locally on CPU** inside the Node server (via `kokoro-js`), in a worker thread so synthesis never stutters playback. **Free, offline, and rate-limit-free.** On first use it downloads ~80 MB of model files into `data/models/` (you'll see a load-progress indicator; DJ breaks are skipped until it's ready). Each DJ maps to a fitting Kokoro voice (`af_heart`, `am_puck`, `bm_george`, …), editable per DJ in `branding/stations.json`. *Note:* DJ/news **scripts** are still written by Gemini text — Kokoro only replaces the voice, which is where the free-tier limits were tightest.

All three cache clips to disk, keyed by engine + voice + text, so the same line is never synthesized twice within an engine.

---

## Architecture

```
server/
  index.js            Fastify server + static UI + startup scan
  config.js           env + persisted station config + branding catalogue
  ai/gemini.js        Gemini client: text, TTS, model auto-detect, throttle, PCM→WAV
  ai/liveVoice.js     Native-audio (Live API) voice engine over WebSocket (optional)
  ai/kokoroVoice.js   Local Kokoro TTS manager: worker lifecycle + load status
  ai/kokoroWorker.js  Worker thread running Kokoro on CPU (kokoro-js/ONNX)
  ai/dj.js            DJ persona scripts (intro / handoff / welcome)
  ai/news.js          RSS fetch + spoken news bulletin
  library/scanner.js  folder scan, tags, filename fallback
  library/bpm.js      optional ffmpeg-based BPM analysis
  sequencer/          the five shuffle modes (incl. AI pick)
  director/segments.js  script → TTS → cached WAV
  routes/api.js       HTTP API + range-streaming of audio
public/
  index.html/styles.css  the control panel
  player.js           Web Audio engine (decks, crossfade, ducking)
  app.js              the conductor: timing, pre-generation, wiring
branding/stations.json  the six station imagings
```

---

## Security notes

- **Your API key** lives only in `.env`, which is git-ignored. It is never hardcoded, logged, or committed. If you ever paste a key somewhere public, **revoke it** in Google AI Studio and issue a new one.
- **`npm audit`** reports two advisories inside `music-metadata` (an infinite-loop DoS when parsing *maliciously malformed* WMA/ASF files). For a personal app parsing your own local library the practical risk is low; `music-metadata` is already at its latest version, and tag parsing is wrapped in a timeout so a pathological file can't stall a scan. If you plan to expose this beyond localhost, sandbox the scanner accordingly.
- The server binds to `127.0.0.1` by default. Don't expose it to the open internet without adding auth and a hardened static layer.

---

## License

MIT
