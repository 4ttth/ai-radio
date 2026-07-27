// Fetches the configured RSS feeds and turns them into a spoken news break,
// read in the current DJ's voice with the mood the user tagged each feed.
import Parser from 'rss-parser';
import { generateText } from './gemini.js';
import { cleanScript } from './clean.js';

const parser = new Parser({ timeout: 10000 });
const seen = new Set(); // links we've already read on air, to avoid repeats

export async function fetchNews(feeds = [], { maxItems = 3 } = {}) {
  const collected = [];
  for (const feed of feeds) {
    if (!feed?.url) continue;
    try {
      const parsed = await parser.parseURL(feed.url);
      const source = parsed.title || feed.category || 'the newsroom';
      for (const item of parsed.items || []) {
        const key = item.link || item.guid || item.title;
        if (!key || seen.has(key)) continue;
        collected.push({
          title: (item.title || '').trim(),
          summary: (item.contentSnippet || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          category: feed.category || 'News',
          mood: feed.mood || 'Serious',
          source,
          key,
        });
      }
    } catch {
      // Skip unreachable/invalid feeds silently.
    }
  }

  // Prefer a spread across categories, newest-ish first (feeds come sorted).
  const chosen = collected.slice(0, Math.max(1, maxItems));
  for (const c of chosen) seen.add(c.key);
  if (seen.size > 500) seen.clear(); // bound memory
  return chosen;
}

export async function newsScript({ branding, dj, items, defaultMood = 'Serious' }) {
  if (!items || !items.length) return null;

  const moodDirections = {
    Serious: 'measured, credible, straightforward — like a trusted news anchor',
    Upbeat: 'bright and energetic, but still clear and respectful of the facts',
    Snarky: 'wry and a little cheeky, with light editorial commentary — never mean about tragedy',
    Calm: 'soft, unhurried, reassuring',
  };

  const itemLines = items
    .map((it) => `- (${it.category}, read ${it.mood.toLowerCase()}) ${it.title}${it.summary ? ` — ${it.summary}` : ''}`)
    .join('\n');

  const overallMood = items[0]?.mood || defaultMood;

  const prompt = `${branding.vibePrompt}
You are ${dj?.name || 'the host'} on ${branding.name}, doing a short on-air news break.

Write it as ONE continuous piece of spoken radio copy: open with a quick, natural segue from the music into the news, then deliver these ${items.length} stories in your own words — one or two sentences each — and finish by handing back to the music in a single line. It must sound like one person talking on air, start to finish.

Read each story in the tone noted next to it (${Object.entries(moodDirections).map(([k, v]) => `${k} = ${v}`).join('; ')}).

Stories:
${itemLines}

Rules:
- Output ONLY the words to be spoken aloud, as flowing speech.
- Do NOT include any labels or headings (no "Segue:", "Story 1:", "Back-announce:"), no numbering, no markdown, no asterisks, no brackets, no emoji.
- Keep the whole break under about 140 words, and always finish your final sentence.
- Overall tone leans ${overallMood.toLowerCase()}. Stay factual; don't invent details beyond what's given.`;

  const text = await generateText(prompt, { temperature: 0.8, maxOutputTokens: 2000 });
  return { text: cleanScript(text), dj, items };
}
