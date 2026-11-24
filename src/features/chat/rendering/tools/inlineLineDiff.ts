export interface InlineDiffSegment {
  text: string;
  changed: boolean;
}

export interface PairedLineDiff {
  deleteSegments: InlineDiffSegment[] | null;
  insertSegments: InlineDiffSegment[] | null;
}

export interface BlockInlineDiffs {
  deleteSegments: Array<InlineDiffSegment[] | null>;
  insertSegments: Array<InlineDiffSegment[] | null>;
}

export interface InlineDiffBudget {
  remainingWork: number;
}

/** Cumulative tokenization, pairing, and LCS work budget per rendered diff card. */
export const DEFAULT_INLINE_DIFF_WORK_BUDGET = 2_000_000;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Matches graphemes starting with CJK scripts or CJK iteration/prolonged marks so each
 * displayed CJK character (including decomposed Hangul syllables and half-width voiced kana)
 * stays a single atomic token.
 */
const CJK_GRAPHEME_START_PATTERN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3005\u3031-\u3035\u303B\u30FC\uFF9E\uFF9F]/u;

/** Matches letter/digit graphemes (with nonspacing/spacing marks) that coalesce into word tokens. */
const WORD_GRAPHEME_PATTERN = /^[\p{L}\p{N}][\p{Mn}\p{Mc}]*$/u;

const WHITESPACE_ONLY_PATTERN = /^\s+$/;

/** Guard against huge single-line inputs such as minified bundles or base64 blobs. */
const MAX_LINE_LENGTH = 20_000;

/** Cap any single line pair's middle LCS matrix (~31 KiB bit-packed traceback). */
const MAX_LCS_CELLS = 250_000;

/** Cap pairwise similarity DP on large delete/insert blocks. */
const MAX_PAIRING_PRODUCT = 256;

/** Minimum Dice similarity needed to consider two lines related enough for inline highlights. */
const MIN_SIMILARITY = 0.25;

export function createInlineDiffBudget(maxWork = DEFAULT_INLINE_DIFF_WORK_BUDGET): InlineDiffBudget {
  return { remainingWork: Math.max(0, maxWork) };
}

function consumeWork(budget: InlineDiffBudget | undefined, cost: number): boolean {
  if (!budget) return true;
  if (cost > budget.remainingWork) {
    budget.remainingWork = 0;
    return false;
  }
  budget.remainingWork -= cost;
  return true;
}

function isWordGrapheme(grapheme: string): boolean {
  return WORD_GRAPHEME_PATTERN.test(grapheme) && !CJK_GRAPHEME_START_PATTERN.test(grapheme);
}

/**
 * Splits a line into grapheme-safe diff tokens:
 * - CJK characters split per grapheme cluster so single-character edits never split inside a syllable or voiced kana.
 * - Non-CJK letters and digits stay grouped into word tokens.
 * - Whitespace, punctuation, symbols, and emoji stay atomic grapheme tokens.
 */
export function tokenizeDiffLine(text: string): string[] {
  if (!text) return [];

  const tokens: string[] = [];
  let currentWord = '';

  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (isWordGrapheme(segment)) {
      currentWord += segment;
    } else {
      if (currentWord) {
        tokens.push(currentWord);
        currentWord = '';
      }
      tokens.push(segment);
    }
  }

  if (currentWord) {
    tokens.push(currentWord);
  }

  return tokens;
}

function isWhitespaceToken(token: string): boolean {
  return WHITESPACE_ONLY_PATTERN.test(token);
}

function mergeSegments(tokens: readonly string[], changedFlags: readonly boolean[]): InlineDiffSegment[] | null {
  const segments: InlineDiffSegment[] = [];
  let hasChanged = false;

  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i];
    const changed = changedFlags[i];
    if (changed) hasChanged = true;

    const prev = segments[segments.length - 1];
    if (prev && prev.changed === changed) {
      prev.text += text;
    } else {
      segments.push({ text, changed });
    }
  }

  return hasChanged ? segments : null;
}

function computeInlineLineDiffFromTokens(
  oldTokens: readonly string[],
  newTokens: readonly string[],
  budget?: InlineDiffBudget,
): PairedLineDiff | null {
  let prefixLen = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (prefixLen < minLen && oldTokens[prefixLen] === newTokens[prefixLen]) {
    prefixLen++;
  }

  let oldEnd = oldTokens.length;
  let newEnd = newTokens.length;
  while (oldEnd > prefixLen && newEnd > prefixLen && oldTokens[oldEnd - 1] === newTokens[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const m = oldEnd - prefixLen;
  const n = newEnd - prefixLen;
  if (m === 0 && n === 0) return null;

  const matrixCells = m * n;
  if (matrixCells > MAX_LCS_CELLS) return null;
  if (matrixCells > 0 && !consumeWork(budget, matrixCells)) return null;

  const oldChanged = new Array<boolean>(oldTokens.length).fill(false);
  const newChanged = new Array<boolean>(newTokens.length).fill(false);

  if (m === 0) {
    for (let j = prefixLen; j < newEnd; j++) newChanged[j] = true;
  } else if (n === 0) {
    for (let i = prefixLen; i < oldEnd; i++) oldChanged[i] = true;
  } else {
    const insertSteps = new Uint8Array(Math.ceil(matrixCells / 8));
    let previous = new Uint32Array(n + 1);
    let current = new Uint32Array(n + 1);

    for (let i = 1; i <= m; i++) {
      const oldToken = oldTokens[prefixLen + i - 1];
      for (let j = 1; j <= n; j++) {
        if (oldToken === newTokens[prefixLen + j - 1]) {
          current[j] = previous[j - 1] + 1;
        } else if (current[j - 1] >= previous[j]) {
          current[j] = current[j - 1];
          const cell = (i - 1) * n + j - 1;
          insertSteps[Math.floor(cell / 8)] |= 1 << (cell % 8);
        } else {
          current[j] = previous[j];
        }
      }
      [previous, current] = [current, previous];
    }

    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      const cell = (i - 1) * n + j - 1;
      if (i > 0 && j > 0 && oldTokens[prefixLen + i - 1] === newTokens[prefixLen + j - 1]) {
        i--;
        j--;
      } else if (j > 0 && (i === 0 || (insertSteps[Math.floor(cell / 8)] & (1 << (cell % 8))) !== 0)) {
        newChanged[prefixLen + j - 1] = true;
        j--;
      } else {
        oldChanged[prefixLen + i - 1] = true;
        i--;
      }
    }
  }

  let oldNonWs = 0;
  let newNonWs = 0;
  let matchedNonWs = 0;
  let oldTotal = 0;
  let newTotal = 0;
  let matchedTotal = 0;

  for (let i = 0; i < oldTokens.length; i++) {
    const len = oldTokens[i].length;
    const nonWs = !isWhitespaceToken(oldTokens[i]);
    oldTotal += len;
    if (nonWs) oldNonWs += len;
    if (!oldChanged[i]) {
      matchedTotal += len;
      if (nonWs) matchedNonWs += len;
    }
  }

  for (let j = 0; j < newTokens.length; j++) {
    const len = newTokens[j].length;
    newTotal += len;
    if (!isWhitespaceToken(newTokens[j])) newNonWs += len;
  }

  if (oldNonWs > 0 || newNonWs > 0) {
    if (matchedNonWs === 0 || (2 * matchedNonWs) / (oldNonWs + newNonWs) < MIN_SIMILARITY) {
      return null;
    }
  } else if (matchedTotal === 0 || (2 * matchedTotal) / (oldTotal + newTotal) < MIN_SIMILARITY) {
    return null;
  }

  const deleteSegments = mergeSegments(oldTokens, oldChanged);
  const insertSegments = mergeSegments(newTokens, newChanged);
  if (!deleteSegments && !insertSegments) return null;

  return { deleteSegments, insertSegments };
}

export function computeInlineLineDiff(
  oldText: string,
  newText: string,
  budget?: InlineDiffBudget,
): PairedLineDiff | null {
  if (!oldText || !newText || oldText === newText) return null;
  if (oldText.length > MAX_LINE_LENGTH || newText.length > MAX_LINE_LENGTH) return null;
  if (!consumeWork(budget, oldText.length + newText.length)) return null;

  const oldTokens = tokenizeDiffLine(oldText);
  const newTokens = tokenizeDiffLine(newText);
  return computeInlineLineDiffFromTokens(oldTokens, newTokens, budget);
}

interface LineSignature {
  allTokens: string[];
  tokens: string[];
  unigrams: Map<string, number>;
  bigrams: Map<string, number>;
  weight: number;
  whitespaceOnly: boolean;
}

function buildLineSignature(text: string, budget?: InlineDiffBudget): LineSignature | null {
  if (!text || text.length > MAX_LINE_LENGTH) return null;
  if (!consumeWork(budget, text.length)) return null;

  const allTokens = tokenizeDiffLine(text);
  const nonWsTokens: string[] = [];
  let nonWsWeight = 0;

  for (const token of allTokens) {
    if (isWhitespaceToken(token)) continue;
    nonWsTokens.push(token);
    nonWsWeight += token.length;
  }

  const whitespaceOnly = nonWsWeight === 0;
  const tokens = whitespaceOnly ? allTokens : nonWsTokens;
  if (tokens.length === 0) return null;

  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, number>();
  let weight = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    weight += token.length;
    unigrams.set(token, (unigrams.get(token) ?? 0) + 1);
    if (i > 0) {
      const bigram = `${tokens[i - 1]}\0${token}`;
      bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
    }
  }

  return { allTokens, tokens, unigrams, bigrams, weight, whitespaceOnly };
}

function lineSignatureSimilarity(left: LineSignature | null, right: LineSignature | null): number {
  if (!left || !right || left.whitespaceOnly !== right.whitespaceOnly) return 0;

  let sharedUnigramChars = 0;
  const [smallUni, largeUni] = left.unigrams.size <= right.unigrams.size ? [left, right] : [right, left];
  for (const [token, count] of smallUni.unigrams) {
    const otherCount = largeUni.unigrams.get(token);
    if (otherCount) {
      sharedUnigramChars += Math.min(count, otherCount) * token.length;
    }
  }

  const unigramDice = sharedUnigramChars > 0 ? (2 * sharedUnigramChars) / (left.weight + right.weight) : 0;
  if (unigramDice < MIN_SIMILARITY) return 0;

  // Common prefix/suffix overlap preserves order for short edits and insertions.
  let prefix = 0;
  const minTokens = Math.min(left.tokens.length, right.tokens.length);
  let edgeChars = 0;
  while (prefix < minTokens && left.tokens[prefix] === right.tokens[prefix]) {
    edgeChars += left.tokens[prefix].length;
    prefix++;
  }

  let leftEnd = left.tokens.length;
  let rightEnd = right.tokens.length;
  while (leftEnd > prefix && rightEnd > prefix && left.tokens[leftEnd - 1] === right.tokens[rightEnd - 1]) {
    edgeChars += left.tokens[leftEnd - 1].length;
    leftEnd--;
    rightEnd--;
  }
  const prefixSuffixDice = (2 * edgeChars) / (left.weight + right.weight);

  // Adjacent-token bigrams distinguish ordered edits from reversed anagrams.
  let bigramDice = 0;
  if (left.tokens.length >= 2 && right.tokens.length >= 2) {
    let sharedBigrams = 0;
    const [smallBi, largeBi] = left.bigrams.size <= right.bigrams.size ? [left, right] : [right, left];
    for (const [bigram, count] of smallBi.bigrams) {
      const otherCount = largeBi.bigrams.get(bigram);
      if (otherCount) {
        sharedBigrams += Math.min(count, otherCount);
      }
    }
    bigramDice = (2 * sharedBigrams) / ((left.tokens.length - 1) + (right.tokens.length - 1));
  }

  const orderedScore = Math.max(bigramDice, prefixSuffixDice);
  return 0.2 * unigramDice + 0.8 * orderedScore;
}

export function computeBlockInlineDiffs(
  deleteLines: readonly string[],
  insertLines: readonly string[],
  budget?: InlineDiffBudget,
): BlockInlineDiffs {
  const deleteCount = deleteLines.length;
  const insertCount = insertLines.length;
  const deleteSegments: Array<InlineDiffSegment[] | null> = new Array<InlineDiffSegment[] | null>(deleteCount).fill(null);
  const insertSegments: Array<InlineDiffSegment[] | null> = new Array<InlineDiffSegment[] | null>(insertCount).fill(null);

  if (deleteCount === 0 || insertCount === 0 || (budget && budget.remainingWork <= 0)) {
    return { deleteSegments, insertSegments };
  }

  if (deleteCount === 1 && insertCount === 1) {
    const pairDiff = computeInlineLineDiff(deleteLines[0], insertLines[0], budget);
    if (pairDiff) {
      deleteSegments[0] = pairDiff.deleteSegments;
      insertSegments[0] = pairDiff.insertSegments;
    }
    return { deleteSegments, insertSegments };
  }

  if (deleteCount * insertCount > MAX_PAIRING_PRODUCT) {
    if (deleteCount === insertCount) {
      for (let i = 0; i < deleteCount; i++) {
        if (budget && budget.remainingWork <= 0) break;
        const pairDiff = computeInlineLineDiff(deleteLines[i], insertLines[i], budget);
        if (pairDiff) {
          deleteSegments[i] = pairDiff.deleteSegments;
          insertSegments[i] = pairDiff.insertSegments;
        }
      }
    }
    return { deleteSegments, insertSegments };
  }

  const deleteSignatures: Array<LineSignature | null> = [];
  for (const line of deleteLines) {
    if (budget && budget.remainingWork <= 0) return { deleteSegments, insertSegments };
    deleteSignatures.push(buildLineSignature(line, budget));
  }
  const insertSignatures: Array<LineSignature | null> = [];
  for (const line of insertLines) {
    if (budget && budget.remainingWork <= 0) return { deleteSegments, insertSegments };
    insertSignatures.push(buildLineSignature(line, budget));
  }

  // Monotonic maximum-weight matching so paired lines stay in source order.
  const cols = insertCount + 1;
  const dp = new Float64Array((deleteCount + 1) * cols);
  // 0 = skip delete (up), 1 = skip insert (left), 2 = pair (diagonal)
  const choice = new Uint8Array((deleteCount + 1) * cols);

  for (let d = 1; d <= deleteCount; d++) {
    const deleteSig = deleteSignatures[d - 1];
    for (let i = 1; i <= insertCount; i++) {
      const idx = d * cols + i;
      const up = dp[(d - 1) * cols + i];
      const left = dp[d * cols + (i - 1)];

      let best = up;
      let move = 0;
      if (left > best) {
        best = left;
        move = 1;
      }

      const insertSig = insertSignatures[i - 1];
      if (deleteSig && insertSig) {
        const pairWork = Math.min(deleteSig.tokens.length, insertSig.tokens.length) + 1;
        if (!consumeWork(budget, pairWork)) {
          return { deleteSegments, insertSegments };
        }
        const similarity = lineSignatureSimilarity(deleteSig, insertSig);
        if (similarity >= MIN_SIMILARITY) {
          const diag = dp[(d - 1) * cols + (i - 1)] + similarity;
          if (diag >= best) {
            best = diag;
            move = 2;
          }
        }
      }

      dp[idx] = best;
      choice[idx] = move;
    }
  }

  const matchedPairs: Array<[number, number]> = [];
  let d = deleteCount;
  let i = insertCount;
  while (d > 0 && i > 0) {
    const move = choice[d * cols + i];
    if (move === 2) {
      matchedPairs.push([d - 1, i - 1]);
      d--;
      i--;
    } else if (move === 1) {
      i--;
    } else {
      d--;
    }
  }

  for (let p = matchedPairs.length - 1; p >= 0; p--) {
    if (budget && budget.remainingWork <= 0) break;
    const [delIdx, insIdx] = matchedPairs[p];
    const deleteSig = deleteSignatures[delIdx];
    const insertSig = insertSignatures[insIdx];
    if (deleteSig && insertSig && deleteLines[delIdx] !== insertLines[insIdx]) {
      const pairDiff = computeInlineLineDiffFromTokens(deleteSig.allTokens, insertSig.allTokens, budget);
      if (pairDiff) {
        deleteSegments[delIdx] = pairDiff.deleteSegments;
        insertSegments[insIdx] = pairDiff.insertSegments;
      }
    }
  }

  return { deleteSegments, insertSegments };
}
