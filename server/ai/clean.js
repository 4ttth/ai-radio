// Strip anything that isn't meant to be spoken aloud, so TTS never reads
// markdown, bracketed stage directions, section labels ("Segue:", "Intro
// (1 line):"), list markers, or wrapping quotes.
export function cleanScript(input) {
  let t = String(input || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');        // code fences
  t = t.replace(/\[[^\]]*\]/g, ' ');            // [stage directions]
  t = t.replace(/[*_`#>|~]+/g, ' ');            // markdown symbols incl. stray asterisks
  // Section labels the model sometimes prefixes, e.g. "Segue (1 line): ..."
  t = t.replace(
    /(^|[.!?;:\n])\s*(segue|intro(?:duction)?|outro|transition|hand-?off|hand-?back|back-?announce|announcement|news(?:\s*break)?|headline|story|bumper|station\s*id|sign-?off|tease|delivery|note)\b[^:\n]{0,40}:\s*/gi,
    '$1 ',
  );
  t = t.replace(/(^|\n)\s*\d+[.)]\s+/g, '$1');  // "1. " / "2) " numbering
  t = t.replace(/(^|\n)\s*[-•]\s+/g, '$1');     // bullet markers
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim(); // wrapping quotes
  return t;
}
