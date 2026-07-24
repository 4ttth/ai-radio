// Fetches the configured RSS feeds and turns them into a spoken news break,
// read in the current DJ's voice with the mood the user tagged each feed.
import Parser from 'rss-parser';
import { generateText } from './gemini.js';

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
    .map((it, i) => `${i + 1}. [${it.category} · read it ${it.mood.toLowerCase()}] ${it.title}${it.summary ? ` — ${it.summary}` : ''}`)
    .join('\n');

  const overallMood = items[0]?.mood || defaultMood;

  const prompt = `${branding.vibePrompt}
You are ${dj?.name || 'the host'} on ${branding.name}. Right now you're doing a short news break.

Deliver, as spoken words only:
1. A brief, natural segue from the music into the news (one line).
2. Read these ${items.length} stories in your own words — concise, one to two sentences each. Read each in the tone tagged in brackets (${Object.entries(moodDirections).map(([k, v]) => `${k} = ${v}`).join('; ')}).
3. A quick line handing back to the music.

Stories:
${itemLines}

Rules:
- Output ONLY the words to be spoken aloud. No headings, no numbering, no stage directions, no emoji.
- Keep the whole break under about 150 words.
- Overall tone leans ${overallMood.toLowerCase()}. Stay factual; don't invent details beyond what's given.`;

  const text = await generateText(prompt, { temperature: 0.8, maxOutputTokens: 380 });
  return { text: (text || '').replace(/\s+/g, ' ').trim(), dj, items };
}
