# Setup guide

## 1. Install Node

You need **Node.js 18.17+** (Node 20+ recommended). Check with:

```bash
node --version
```

Get it from <https://nodejs.org> if needed.

## 2. Get a Gemini API key

1. Go to <https://aistudio.google.com/apikey>.
2. Create an API key (a valid key looks like `AIzaSy...`).
3. Copy `.env.example` to `.env` and paste it in:

```bash
cp .env.example .env
```

```ini
GEMINI_API_KEY=AIzaSy...your-real-key...
```

> **Free tier & rate limits.** Gemini's TTS preview model works on the free tier but with tight rate limits (a few requests/minute, a modest daily cap). AI Radio pre-generates and caches segments and throttles requests (`GEMINI_MAX_RPM`, default 8) to stay within them. If you hit limits, DJ breaks are skipped gracefully and retried later — the music never stops. On a paid key, raise `GEMINI_MAX_RPM`.

> **Keep keys secret.** `.env` is git-ignored. Never commit a real key or paste it into a chat/issue. If a key leaks, revoke it in Google AI Studio and make a new one.

## 3. (Optional) Install ffmpeg — for BPM analysis

The **per-beat (BPM)** shuffle modes use tempo. It's read from tags automatically; to analyze tracks that have no BPM tag, install ffmpeg:

- **macOS:** `brew install ffmpeg`
- **Debian/Ubuntu:** `sudo apt install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (or download from ffmpeg.org and add to PATH)

Verify: `ffmpeg -version`. Then click **Analyze BPM** in the UI. Without ffmpeg, untagged tracks simply sort last in BPM modes.

## 4. Run

```bash
npm start
```

Open <http://127.0.0.1:4123>.

1. Paste your **music folder** path (absolute) → **Scan**.
2. Choose a **branding** and rename the station if you like.
3. Pick a **shuffle mode**.
4. Add **RSS feeds** (see examples below) and set news/DJ cadence.
5. Press **▶**. Use **🎙️ DJ** and **📰 News** to trigger a break on demand.

## Example RSS feeds

| Feed | URL | Suggested mood |
|---|---|---|
| BBC World | `https://feeds.bbci.co.uk/news/world/rss.xml` | Serious |
| NPR News | `https://feeds.npr.org/1001/rss.xml` | Serious |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` | Upbeat |
| Local news | *(your town's paper/station RSS)* | Serious |

Add your own **local** feed and tag its category (e.g. "Local") so the DJ frames it that way.

## Troubleshooting

- **"No Gemini key" banner / silent DJs** — set `GEMINI_API_KEY` in `.env` and restart `npm start`.
- **DJ voices don't play but music does** — check the terminal for `segment ... failed`. A `429` means you hit the free-tier rate limit; it retries later. Lower cadence (fewer intros/news) or raise `GEMINI_MAX_RPM` on a paid key.
- **`segment ... failed: ... 404 ... model ... no longer available`** — a model name got retired. The app auto-detects the best available model for your key, so just restart `npm start`. To see what it picked (and everything your key can use), open <http://127.0.0.1:4123/api/models>. Make sure `GEMINI_TEXT_MODEL` / `GEMINI_TTS_MODEL` in `.env` are **blank** (auto) unless you're deliberately forcing a model.
- **Local (Kokoro) voice says "still loading"** — the first time you pick **AI DJ → Voice engine → Local · Kokoro**, it downloads ~80 MB of model files into `data/models/`. Watch the load % in the AI DJ panel / **Audio & status**; DJ breaks are skipped until it's ready, then it's fully offline. That first download needs to reach `huggingface.co`. It runs on CPU — no GPU or `espeak-ng` install required. Note the DJ **scripts** still come from Gemini text, so you still need a `GEMINI_API_KEY`; Kokoro only replaces the voice.
- **No sound at all** — browsers block audio until you interact; press **▶** first. Make sure the tab isn't muted.
- **A track won't play** — the browser must support the codec. MP3, M4A/AAC, OGG/Opus, WAV, FLAC and WebM generally work; exotic formats may not.
- **BPM button says "ffmpeg not installed"** — install ffmpeg (step 3) and rescan.
- **Scan finds 0 tracks** — check the path is absolute and correct, and that files have supported extensions.

## Resetting

Delete `data/config.json` to reset settings to defaults, and `data/cache/` to clear cached voice clips. Delete `.ai-radio-cache.json` inside your music folder to force BPM re-analysis.
