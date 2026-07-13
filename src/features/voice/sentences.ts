// Chunk streamed assistant text into clean, speakable sentences.
//
// Ported from voicecode's Python `sentences.py` (splitSentences) and code-tui's
// Go `voice.go` (chunkForSpeech / endsSentence). Pure functions — no I/O.
//
// The assistant's reply arrives as deltas. `splitSentences` peels complete
// sentences off a running buffer (so TTS can start before the turn ends),
// strips markdown artifacts that sound bad aloud, drops fenced code entirely,
// and returns the trailing incomplete remainder for the next call.
// `chunkForSpeech` then groups those clean sentences into natural,
// sentence-aligned TTS clips.

// A sentence ends at . ! ? or newline, plus any trailing whitespace. A run of
// closing quotes/brackets after the terminator is kept ON this sentence, so
// `... "stop."` does not leave a dangling `"` opening the next spoken unit.
// The alternation always consumes at least one terminator (or a newline), so a
// match can never be zero-width — the matchAll loop below cannot spin.
const RE_SENTENCE_END = /[^.!?\n]*(?:[.!?]+["'”’)\]]*|\n)\s*/g;

// Leading/trailing markdown noise to strip from a spoken sentence.
const RE_EDGE_MARKDOWN = /^[\s*`#>-]+|[\s*`#>-]+$/g;

// Leading list/enumeration marker left after markdown stripping — e.g. "1.",
// "2)", "3:", "a)", "B:", a bullet, or a dangling ":" from "**Option 1**:".
// Spoken aloud these read as noise ("colon full duplex"), so drop them.
const RE_LEADING_MARKER = /^(?:\d+[.):]|[A-Za-z][):]|[:•·])\s+/;

// Stripped patterns: `code`, **bold**, *italic*.
const RE_MARKDOWN_FORMAT = /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/g;

const RE_WHITESPACE = /\s+/g;

// Fenced code marker. Code must NEVER be spoken aloud: complete fenced blocks
// are dropped, and an unclosed fence holds its tail in the remainder so a block
// that is still streaming in can't leak to TTS.
const FENCE = '```';

/** Result of peeling complete sentences off a running delta buffer. */
export interface SplitSentencesResult {
  /** Complete, cleaned sentences ready to hand to TTS. */
  sentences: string[];
  /** Trailing text with no sentence terminator yet (carry into the next call). */
  remainder: string;
}

/** Strip markdown artifacts and collapse whitespace in one sentence. */
function clean(sentence: string): string {
  let text = sentence.replace(RE_MARKDOWN_FORMAT, '');
  text = text.replace(RE_EDGE_MARKDOWN, '');
  text = text.replace(RE_LEADING_MARKER, '');
  text = text.replace(RE_WHITESPACE, ' ').trim();
  return text;
}

/** Join the elements of `parts` at even indices [0, 2, 4, …] below `end`. */
function joinEvenIndices(parts: string[], end: number): string {
  let out = '';
  for (let i = 0; i < end; i += 2) {
    out += parts[i];
  }
  return out;
}

/**
 * Return `{ speakable, held }` with fenced code removed.
 *
 * Text inside paired ``` fences is deleted outright. If the last fence is
 * unclosed (the block is still streaming), everything from that fence on is
 * returned as `held` so the caller keeps it in the remainder instead of
 * speaking it.
 */
function dropFencedCode(buffer: string): { speakable: string; held: string } {
  if (!buffer.includes(FENCE)) {
    return { speakable: buffer, held: '' };
  }
  const parts = buffer.split(FENCE);
  // len(parts) === fence_count + 1. An odd number of parts means an even number
  // of fences: every block is closed. Keep the text outside the blocks.
  if (parts.length % 2 === 1) {
    return { speakable: joinEvenIndices(parts, parts.length), held: '' };
  }
  // Even number of parts === odd number of fences: the final block is still
  // open. Speak the text outside the closed blocks, hold the open block back
  // verbatim so its closing fence can arrive later.
  const speakable = joinEvenIndices(parts, parts.length - 1);
  const held = FENCE + parts[parts.length - 1];
  return { speakable, held };
}

/**
 * Split `buffer` into complete sentences plus a trailing remainder.
 *
 * Punctuation is kept on each complete sentence. Sentences that are only
 * symbols/whitespace after cleaning are dropped. Fenced code blocks are never
 * emitted: closed blocks are deleted, and a still-open block stays in the
 * remainder until its closing fence arrives. The remainder is the trailing text
 * with no sentence terminator yet.
 */
export function splitSentences(buffer: string): SplitSentencesResult {
  const { speakable, held } = dropFencedCode(buffer);

  const sentences: string[] = [];
  let lastEnd = 0;
  for (const match of speakable.matchAll(RE_SENTENCE_END)) {
    lastEnd = (match.index ?? 0) + match[0].length;
    const cleaned = clean(match[0]);
    if (cleaned) {
      sentences.push(cleaned);
    }
  }

  const remainder = speakable.slice(lastEnd) + held;
  return { sentences, remainder };
}

// TTS chunking is sentence-aligned, not word-capped. Tiny mid-sentence fragments
// make each clip render with sentence-final intonation and a gap before the next
// — a staccato, unnatural cadence. Breaking only at sentence ends (and merging
// short sentences) keeps prosody natural. Barge-in still cuts mid-clip via the
// bridge's interrupt, so larger chunks don't hurt responsiveness.
const CHUNK_FIRST_WORDS = 1; // first clip flushes at the first sentence end (fast start)
const CHUNK_TARGET_WORDS = 30; // merge whole sentences up to ~this many words per clip
const MAX_CHUNK_WORDS = 60; // hard cap for run-on text with no sentence terminator

/**
 * Report whether a word ends a sentence (last non-quote rune is a sentence
 * terminator), so chunking breaks on . ! ? including "right?" forms.
 */
function endsSentence(word: string): boolean {
  const runes = Array.from(word);
  for (let i = runes.length - 1; i >= 0; i--) {
    const r = runes[i];
    if (r === '"' || r === "'" || r === ')' || r === ']' || r === '”' || r === '’') {
      continue; // skip trailing quotes/brackets
    }
    return r === '.' || r === '!' || r === '?';
  }
  return false;
}

/**
 * Split clean speakable prose into natural, sentence-aligned TTS clips.
 *
 * The first clip flushes at the first sentence (snappy start); subsequent clips
 * merge whole sentences up to CHUNK_TARGET_WORDS so cadence stays natural and
 * inter-clip gaps are few. Run-on text with no terminator is split at
 * MAX_CHUNK_WORDS. Empty input yields an empty array. Joining the chunks with
 * single spaces preserves the word order. Input is assumed whitespace-collapsed
 * (i.e. already passed through `speakable`).
 */
export function chunkForSpeech(text: string): string[] {
  const fields = text.split(/\s+/).filter((w) => w.length > 0);
  if (fields.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    if (cur.length > 0) {
      chunks.push(cur.join(' '));
      cur = [];
    }
  };

  for (const word of fields) {
    cur.push(word);
    // First clip: flush at the first sentence end for a fast start; later clips
    // merge whole sentences up to the target word count.
    const target = chunks.length === 0 ? CHUNK_FIRST_WORDS : CHUNK_TARGET_WORDS;
    if ((endsSentence(word) && cur.length >= target) || cur.length >= MAX_CHUNK_WORDS) {
      flush();
    }
  }
  flush();
  return chunks;
}
