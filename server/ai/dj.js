// Generates the spoken scripts an AI DJ says on air.
// Every script is spoken words ONLY (no stage directions) so TTS reads it cleanly.
import { generateText } from './gemini.js';

// Which DJ is on air for a given hour — rotates through the roster.
export function djForHour(roster, date = new Date()) {
  if (!roster || !roster.length) return null;
  return roster[date.getHours() % roster.length];
}

function songLine(t) {
  if (!t) return '';
  const bits = [`"${t.title}" by ${t.artist}`];
  if (t.genre) bits.push(`genre: ${t.genre}`);
  if (t.bpm) bits.push(`${t.bpm} BPM`);
  if (t.year) bits.push(`year: ${t.year}`);
  return bits.join(', ');
}

const rules = `Rules:
- Output ONLY the words to be spoken aloud. No stage directions, no asterisks, no emoji, no quotation marks around the whole thing.
- Sound like a real radio DJ talking over the mix. Natural, in the moment.
- Keep it tight: 2 to 4 sentences. This plays over the music, so no rambling.`;

function personaBlock(branding, dj) {
  const phrases = dj?.catchphrases?.length ? `Signature phrases you sometimes use: ${dj.catchphrases.join(' / ')}.` : '';
  return `${branding.vibePrompt}
You are ${dj?.name || 'the DJ'} on ${branding.name} ("${branding.tagline}"). Your on-air personality: ${dj?.persona || branding.personality}. ${phrases}`;
}

// Intro/transition into the next song, optionally talking over the current one ending.
export async function introScript({ branding, dj, current, next, styleNotes = '' }) {
  const prompt = `${personaBlock(branding, dj)}

${current ? `The song now finishing is ${songLine(current)}.` : 'The show is just getting started.'}
Coming up next: ${songLine(next)}.

Give a short on-air transition that leads into the next song. Mention the next song's title and artist, and evoke its feel or mood in a vivid word or two. ${current ? 'You may briefly nod to the track that just played.' : ''} ${styleNotes ? `Extra direction: ${styleNotes}.` : ''}
${rules}`;
  const text = await generateText(prompt, { temperature: 1.0, maxOutputTokens: 220 });
  return { text: clean(text), dj };
}

// Top-of-hour handoff: outgoing DJ signs off, welcomes the incoming DJ.
export async function handoffScript({ branding, outgoing, incoming, next }) {
  const prompt = `${personaBlock(branding, outgoing)}

It's the top of the hour and your shift is ending. Hand off to the next DJ, ${incoming?.name || 'the next host'} (${incoming?.persona || 'up next'}).
${next ? `Right after the handoff, the next song is ${songLine(next)}.` : ''}

Give a warm, natural sign-off that names yourself, thanks the listeners, and welcomes ${incoming?.name || 'the next DJ'} to the mic. Something in the spirit of "that's it for me folks, I'm ${outgoing?.name}, now let's welcome ${incoming?.name}."
${rules}`;
  const text = await generateText(prompt, { temperature: 1.0, maxOutputTokens: 200 });
  return { text: clean(text), dj: outgoing };
}

// A short welcome from the incoming DJ (optional, played after a handoff).
export async function welcomeScript({ branding, dj, next }) {
  const prompt = `${personaBlock(branding, dj)}

You've just taken over the mic. Give a brief, energetic hello that fits your personality${next ? `, then tease the next song: ${songLine(next)}` : ''}.
${rules}`;
  const text = await generateText(prompt, { temperature: 1.0, maxOutputTokens: 160 });
  return { text: clean(text), dj };
}

function clean(text) {
  return (text || '')
    .replace(/\*[^*]*\*/g, '') // strip *stage directions*
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
