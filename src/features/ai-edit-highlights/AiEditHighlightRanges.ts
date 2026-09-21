import type { DiffLine } from '../../core/types';

export type AiEditHighlightKind = 'added' | 'modified' | 'deleted';

export interface AiEditTextPositionSelector {
  type: 'TextPositionSelector';
  /** Unicode code-point offset, as required by the W3C Web Annotation model. */
  start: number;
  /** Unicode code-point offset, exclusive. */
  end: number;
}

export interface AiEditTextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

export interface AiEditReviewAnchor {
  position: AiEditTextPositionSelector;
  quote: AiEditTextQuoteSelector;
}

export interface AiEditReviewSpec {
  kind: AiEditHighlightKind;
  originalLines: readonly string[];
  currentLines: readonly string[];
  beforeText?: string;
  afterText?: string;
  hintedLine?: number;
  hintedLineIsExact?: boolean;
  hintedInsertionAfterLine?: number;
  anchor?: AiEditReviewAnchor;
}

export interface AiEditReviewSpecOptions {
  lineNumbersAreDocumentRelative?: boolean;
}

type AiEditReviewContent = Omit<AiEditReviewSpec, 'kind'>;

export type ResolvedAiEditReview =
  | AiEditReviewContent & {
    kind: 'added';
    fromLine: number;
    toLine: number;
  }
  | AiEditReviewContent & {
    kind: 'modified';
    fromLine: number;
    toLine: number;
  }
  | AiEditReviewContent & {
    kind: 'deleted';
    /** Number of surviving lines before the deleted content. */
    insertionAfterLine: number;
  };

interface ChangedGroup {
  startIndex: number;
  endIndex: number;
  inserted: DiffLine[];
  deleted: DiffLine[];
}

interface SequenceCandidate {
  startIndex: number;
  contextScore: number;
  hintDistance: number;
}

const ANCHOR_CONTEXT_CODE_POINTS = 64;

export function createAiEditReviewSpecs(
  diffLines: readonly DiffLine[],
  options: AiEditReviewSpecOptions = {},
): AiEditReviewSpec[] {
  // Provider patches may retain CR from a CRLF file; editor lines never do.
  const logicalLines = diffLines.map(line => line.text.endsWith('\r')
    ? { ...line, text: line.text.slice(0, -1) } : line);
  return collectChangedGroups(logicalLines).map(group => {
    const originalLines = group.deleted.map(line => line.text);
    const currentLines = group.inserted.map(line => line.text);
    const kind: AiEditHighlightKind = currentLines.length === 0
      ? 'deleted'
      : originalLines.length > 0
        ? 'modified'
        : 'added';
    const beforeText = readAdjacentEqualText(logicalLines, group.startIndex, -1);
    const afterText = readAdjacentEqualText(logicalLines, group.endIndex, 1);
    const hintedLine = group.inserted.find(line => line.newLineNum !== undefined)?.newLineNum
      ?? readFollowingNewLineHint(logicalLines, group.endIndex);
    const hintedLineIsExact = options.lineNumbersAreDocumentRelative === true
      && hintedLine !== undefined;
    const hintedInsertionAfterLine = kind === 'deleted'
      && options.lineNumbersAreDocumentRelative === true
      ? readDeletionBoundaryHint(logicalLines, group)
      : undefined;

    return {
      kind,
      originalLines,
      currentLines,
      ...(beforeText === undefined ? {} : { beforeText }),
      ...(afterText === undefined ? {} : { afterText }),
      ...(hintedLine === undefined ? {} : { hintedLine }),
      ...(hintedLineIsExact ? { hintedLineIsExact: true } : {}),
      ...(hintedInsertionAfterLine === undefined ? {} : { hintedInsertionAfterLine }),
    };
  });
}

export function resolveAiEditReview(
  documentText: string,
  spec: AiEditReviewSpec,
): ResolvedAiEditReview | null {
  const documentLines = documentText.split('\n');
  const anchored = spec.anchor ? resolveAiEditReviewAnchor(documentText, spec.anchor) : null;
  if (anchored) {
    if (spec.kind === 'deleted') {
      return {
        ...spec,
        kind: 'deleted',
        insertionAfterLine: insertionAfterLineAt(documentText, anchored.from),
      };
    }
    const fromLine = lineAtOffset(documentText, anchored.from);
    const toLine = lineAtOffset(documentText, spec.anchor!.quote.exact.endsWith('\n')
      ? anchored.to
      : Math.max(anchored.from, anchored.to - 1));
    const range = { ...spec, fromLine, toLine };
    return spec.kind === 'added'
      ? { ...range, kind: 'added' }
      : { ...range, kind: 'modified' };
  }
  if (spec.kind === 'deleted') {
    const insertionAfterLine = findDeletionBoundary(
      documentLines,
      spec.beforeText,
      spec.afterText,
      spec.hintedInsertionAfterLine,
    );
    return insertionAfterLine === null
      ? null
      : { ...spec, kind: 'deleted', insertionAfterLine };
  }

  const startIndex = findSequence(
    documentLines,
    spec.currentLines,
    spec.beforeText,
    spec.afterText,
    spec.hintedLine,
    spec.hintedLineIsExact === true,
    new Set<number>(),
  );
  if (startIndex === null) return null;
  const range = {
    ...spec,
    fromLine: startIndex + 1,
    toLine: startIndex + spec.currentLines.length,
  };
  return spec.kind === 'added'
    ? { ...range, kind: 'added' }
    : { ...range, kind: 'modified' };
}

export function createAiEditReviewAnchor(
  documentText: string,
  review: ResolvedAiEditReview,
): AiEditReviewAnchor {
  const offsets = reviewOffsets(documentText, review);
  return createAiEditReviewAnchorFromOffsets(documentText, offsets.from, offsets.to);
}

export function createAiEditReviewAnchorFromOffsets(
  documentText: string,
  from: number,
  to: number,
): AiEditReviewAnchor {
  const safeFrom = Math.max(0, Math.min(from, documentText.length));
  const safeTo = Math.max(safeFrom, Math.min(to, documentText.length));
  const codePoints = [...documentText];
  const start = codeUnitOffsetToCodePoint(documentText, safeFrom);
  const end = codeUnitOffsetToCodePoint(documentText, safeTo);
  return {
    position: {
      type: 'TextPositionSelector',
      start,
      end,
    },
    quote: {
      type: 'TextQuoteSelector',
      exact: documentText.slice(safeFrom, safeTo),
      prefix: codePoints.slice(Math.max(0, start - ANCHOR_CONTEXT_CODE_POINTS), start).join(''),
      suffix: codePoints.slice(end, end + ANCHOR_CONTEXT_CODE_POINTS).join(''),
    },
  };
}

export function resolveAiEditReviewAnchor(
  documentText: string,
  anchor: AiEditReviewAnchor,
): { from: number; to: number } | null {
  const hintedFrom = codePointOffsetToCodeUnit(documentText, anchor.position.start);
  const hintedTo = codePointOffsetToCodeUnit(documentText, anchor.position.end);
  if (hintedFrom !== null && hintedTo !== null && hintedTo >= hintedFrom) {
    const exactMatches = documentText.slice(hintedFrom, hintedTo) === anchor.quote.exact;
    if (exactMatches && (anchor.quote.exact !== '' || contextMatches(
      documentText, hintedFrom, hintedTo, anchor.quote,
    ))) {
      return { from: hintedFrom, to: hintedTo };
    }
  }

  const candidates = anchor.quote.exact === ''
    ? findBoundaryCandidates(documentText, anchor.quote)
    : findQuoteCandidates(documentText, anchor.quote.exact);
  const ranked = candidates.map(from => {
    const to = from + anchor.quote.exact.length;
    return {
      from,
      to,
      contextScore: contextScore(documentText, from, to, anchor.quote),
      hintDistance: hintedFrom === null ? 0 : Math.abs(from - hintedFrom),
    };
  }).filter(candidate => candidate.contextScore > 0 || candidates.length === 1);
  ranked.sort((left, right) => (
    right.contextScore - left.contextScore
    || left.hintDistance - right.hintDistance
    || left.from - right.from
  ));
  const best = ranked[0];
  if (!best) return null;
  const second = ranked[1];
  if (second
    && second.contextScore === best.contextScore
    && second.hintDistance === best.hintDistance) return null;
  return { from: best.from, to: best.to };
}

function collectChangedGroups(diffLines: readonly DiffLine[]): ChangedGroup[] {
  const groups: ChangedGroup[] = [];
  let current: ChangedGroup | null = null;

  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };

  diffLines.forEach((line, index) => {
    if (line.type === 'equal') {
      flush();
      return;
    }

    // Multi-edit tool payloads may concatenate replacement pairs without an
    // equal spacer. A delete after an insert starts the next replacement.
    if (line.type === 'delete' && current?.inserted.length) {
      flush();
    }

    current ??= {
      startIndex: index,
      endIndex: index,
      inserted: [],
      deleted: [],
    };
    current.endIndex = index;
    if (line.type === 'insert') current.inserted.push(line);
    else current.deleted.push(line);
  });
  flush();
  return groups;
}

function readAdjacentEqualText(
  diffLines: readonly DiffLine[],
  index: number,
  direction: -1 | 1,
): string | undefined {
  const line = diffLines[index + direction];
  return line?.type === 'equal' ? line.text : undefined;
}

function readFollowingNewLineHint(
  diffLines: readonly DiffLine[],
  endIndex: number,
): number | undefined {
  const nextLine = diffLines[endIndex + 1];
  return nextLine?.type === 'equal' ? nextLine.newLineNum : undefined;
}

function readDeletionBoundaryHint(
  diffLines: readonly DiffLine[],
  group: ChangedGroup,
): number | undefined {
  const nextLine = diffLines[group.endIndex + 1];
  if (nextLine?.type === 'equal' && nextLine.newLineNum !== undefined) {
    return Math.max(0, nextLine.newLineNum - 1);
  }

  const previousLine = diffLines[group.startIndex - 1];
  if (previousLine?.type === 'equal' && previousLine.newLineNum !== undefined) {
    return previousLine.newLineNum;
  }

  const oldLine = group.deleted[0]?.oldLineNum;
  if (oldLine === undefined) return undefined;

  let priorLineDelta = 0;
  for (let index = 0; index < group.startIndex; index++) {
    if (diffLines[index].type === 'insert') priorLineDelta++;
    if (diffLines[index].type === 'delete') priorLineDelta--;
  }
  return Math.max(0, oldLine - 1 + priorLineDelta);
}

function findSequence(
  documentLines: readonly string[],
  sequence: readonly string[],
  beforeText: string | undefined,
  afterText: string | undefined,
  hintedLine: number | undefined,
  hintedLineIsExact: boolean,
  occupiedLines: ReadonlySet<number>,
): number | null {
  if (sequence.length === 0 || sequence.length > documentLines.length) return null;

  if (hintedLineIsExact && hintedLine !== undefined) {
    const hintedStartIndex = hintedLine - 1;
    const hintFits = hintedStartIndex >= 0
      && hintedStartIndex + sequence.length <= documentLines.length
      && matchesAt(documentLines, sequence, hintedStartIndex)
      && sequence.every((_, offset) => !occupiedLines.has(hintedStartIndex + offset))
      && (beforeText === undefined || documentLines[hintedStartIndex - 1] === beforeText)
      && (afterText === undefined
        || documentLines[hintedStartIndex + sequence.length] === afterText);
    if (hintFits) return hintedStartIndex;
  }

  const candidates: SequenceCandidate[] = [];
  for (let startIndex = 0; startIndex <= documentLines.length - sequence.length; startIndex++) {
    if (!matchesAt(documentLines, sequence, startIndex)) continue;
    if (sequence.some((_, offset) => occupiedLines.has(startIndex + offset))) continue;

    let contextScore = 0;
    if (beforeText !== undefined && documentLines[startIndex - 1] === beforeText) {
      contextScore++;
    }
    if (afterText !== undefined && documentLines[startIndex + sequence.length] === afterText) {
      contextScore++;
    }
    candidates.push({
      startIndex,
      contextScore,
      hintDistance: hintedLine === undefined
        ? 0
        : Math.abs(startIndex + 1 - hintedLine),
    });
  }

  candidates.sort((left, right) => (
    right.contextScore - left.contextScore
    || left.hintDistance - right.hintDistance
    || left.startIndex - right.startIndex
  ));
  const best = candidates[0];
  if (!best) return null;

  // A line hint may be snippet-local, so it cannot safely break a tie between
  // identical text matches. Require unchanged context to produce one winner.
  if (candidates[1]?.contextScore === best.contextScore) return null;
  return best.startIndex;
}

function findDeletionBoundary(
  documentLines: readonly string[],
  beforeText: string | undefined,
  afterText: string | undefined,
  hintedInsertionAfterLine: number | undefined,
): number | null {
  if (
    hintedInsertionAfterLine !== undefined
    && hintedInsertionAfterLine >= 0
    && hintedInsertionAfterLine <= documentLines.length
  ) {
    const beforeMatches = beforeText === undefined
      || documentLines[hintedInsertionAfterLine - 1] === beforeText;
    const afterMatches = afterText === undefined
      || documentLines[hintedInsertionAfterLine] === afterText;
    if (beforeMatches && afterMatches) return hintedInsertionAfterLine;
  }

  if (beforeText === undefined && afterText === undefined) return null;

  const candidates: number[] = [];
  for (let boundary = 0; boundary <= documentLines.length; boundary++) {
    const beforeMatches = beforeText === undefined || documentLines[boundary - 1] === beforeText;
    const afterMatches = afterText === undefined || documentLines[boundary] === afterText;
    if (beforeMatches && afterMatches) candidates.push(boundary);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function reviewOffsets(
  documentText: string,
  review: ResolvedAiEditReview,
): { from: number; to: number } {
  const lineStarts = documentLineStarts(documentText);
  if (review.kind === 'deleted') {
    if (review.insertionAfterLine <= 0) return { from: 0, to: 0 };
    if (review.insertionAfterLine >= lineStarts.length) {
      return { from: documentText.length, to: documentText.length };
    }
    const position = lineStarts[review.insertionAfterLine];
    return { from: position, to: position };
  }

  const from = lineStarts[Math.max(0, review.fromLine - 1)] ?? documentText.length;
  const nextLineStart = lineStarts[review.toLine];
  const to = nextLineStart === undefined
    ? documentText.length
    : Math.max(from, nextLineStart - 1);
  return { from, to };
}

function documentLineStarts(documentText: string): number[] {
  const starts = [0];
  for (let index = 0; index < documentText.length; index++) {
    if (documentText[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function codeUnitOffsetToCodePoint(text: string, offset: number): number {
  return [...text.slice(0, offset)].length;
}

function codePointOffsetToCodeUnit(text: string, offset: number): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let codePoints = 0;
  let codeUnits = 0;
  for (const character of text) {
    if (codePoints === offset) return codeUnits;
    codePoints++;
    codeUnits += character.length;
  }
  return codePoints === offset ? codeUnits : null;
}

function contextMatches(
  documentText: string,
  from: number,
  to: number,
  quote: AiEditTextQuoteSelector,
): boolean {
  return (quote.prefix === '' || documentText.slice(0, from).endsWith(quote.prefix))
    && (quote.suffix === '' || documentText.slice(to).startsWith(quote.suffix));
}

function contextScore(
  documentText: string,
  from: number,
  to: number,
  quote: AiEditTextQuoteSelector,
): number {
  let score = 0;
  if (quote.prefix !== '' && documentText.slice(0, from).endsWith(quote.prefix)) score++;
  if (quote.suffix !== '' && documentText.slice(to).startsWith(quote.suffix)) score++;
  return score;
}

function findQuoteCandidates(documentText: string, exact: string): number[] {
  const candidates: number[] = [];
  let from = 0;
  while (from <= documentText.length - exact.length) {
    const match = documentText.indexOf(exact, from);
    if (match < 0) break;
    candidates.push(match);
    from = match + Math.max(1, exact.length);
  }
  return candidates;
}

function findBoundaryCandidates(
  documentText: string,
  quote: AiEditTextQuoteSelector,
): number[] {
  const candidates = new Set<number>();
  if (quote.prefix !== '') {
    for (const match of findQuoteCandidates(documentText, quote.prefix)) {
      candidates.add(match + quote.prefix.length);
    }
  }
  if (quote.suffix !== '') {
    for (const match of findQuoteCandidates(documentText, quote.suffix)) candidates.add(match);
  }
  return [...candidates];
}

function lineAtOffset(documentText: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, documentText.length); index++) {
    if (documentText[index] === '\n') line++;
  }
  return line;
}

function insertionAfterLineAt(documentText: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= documentText.length) return documentText === '' ? 0 : documentText.split('\n').length;
  let lineBreaks = 0;
  for (let index = 0; index < offset; index++) {
    if (documentText[index] === '\n') lineBreaks++;
  }
  return lineBreaks;
}

function matchesAt(
  documentLines: readonly string[],
  sequence: readonly string[],
  startIndex: number,
): boolean {
  return sequence.every((line, offset) => documentLines[startIndex + offset] === line);
}
