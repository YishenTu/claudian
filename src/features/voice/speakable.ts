// Text cleaning for text-to-speech. Ported from code-tui's voice/speakable.go
// (itself ported from voicecode's Python `_MAX_SPEAK_CHARS` / speakable logic).
//
// Strips things that must never be read aloud (code, URLs, file paths, markdown
// markers) and caps overall spoken length. Pure functions — no I/O.

/**
 * maxSpeakChars caps spoken length (in code points) so a long write-up is not
 * read out in full. Matches voicecode's _MAX_SPEAK_CHARS.
 */
export const MAX_SPEAK_CHARS = 1200;

/**
 * Appended when text is truncated at the length cap. Doubles as the sentinel
 * that makes the cap idempotent (see capLength).
 */
const ELLIPSIS = ' ...';

// Fenced code blocks -> dropped entirely. `s` flag so `.` matches newlines.
const RE_FENCED_CODE = /```[\s\S]*?```/g;
// Inline code -> keep the words, drop the backticks.
const RE_INLINE_CODE = /`([^`]*)`/g;
// URLs -> dropped.
const RE_URL = /https?:\/\/\S+/g;
// Absolute file paths (2+ segments) -> dropped. JS regex supports lookbehind in
// modern V8 (Obsidian ships a current Electron), but to mirror the Go port we
// capture the preceding boundary and put it back, leaving a space where the
// path was. A relative path like `src/main.ts` has no leading slash and is not
// matched; `/usr/local/bin` is.
const RE_PATH = /(^|[^\w])(?:\/[\w.-]+){2,}\/?/g;
// Markdown emphasis / heading / blockquote markers.
const RE_MARKERS = /[*_#>]+/g;
// List bullets at line start. `m` flag so `^` matches each line.
const RE_BULLET = /^\s*[-•]\s+/gm;
// Whitespace runs.
const RE_SPACE = /\s+/g;

/**
 * Strips things that should not be read aloud and collapses whitespace,
 * returning clean prose suitable for TTS. Pure function.
 *
 * Order matters: fenced-code drop precedes inline-backtick strip, and whitespace
 * collapse runs last before the length cap.
 */
export function speakable(text: string): string {
  let out = text.replace(RE_FENCED_CODE, ' ');
  out = out.replace(RE_INLINE_CODE, '$1');
  out = out.replace(RE_URL, ' ');
  out = out.replace(RE_PATH, '$1 ');
  out = out.replace(RE_MARKERS, ' ');
  out = out.replace(RE_BULLET, ' ');
  out = out.replace(RE_SPACE, ' ').trim();

  return capLength(out);
}

/**
 * Truncates text to MAX_SPEAK_CHARS code points at a word boundary, appending
 * the ellipsis. Idempotent: text already ending in the ellipsis sentinel is
 * returned unchanged, and the ellipsis is budgeted inside the cap so a capped
 * result never exceeds MAX_SPEAK_CHARS and cannot be re-truncated on a later
 * pass.
 */
function capLength(text: string): string {
  const runes = Array.from(text);
  if (runes.length <= MAX_SPEAK_CHARS) {
    return text;
  }
  if (text.endsWith(ELLIPSIS)) {
    return text; // already capped; do not re-truncate
  }

  // Reserve room for the ellipsis so the final string fits within the cap.
  const budget = MAX_SPEAK_CHARS - Array.from(ELLIPSIS).length;
  let capped = runes.slice(0, budget).join('');
  const lastSpace = capped.lastIndexOf(' ');
  if (lastSpace >= 0) {
    capped = capped.slice(0, lastSpace);
  }
  return capped + ELLIPSIS;
}
