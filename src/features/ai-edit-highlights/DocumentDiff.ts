import type { DiffLine, ToolDiffData } from '../../core/types';

const MAX_LCS_CELLS = 250_000;
const MAX_MYERS_WORK = 2_000_000;
const MAX_MYERS_TRACE_ENTRIES = 1_000_000;

export type DocumentDiffResult =
  | { status: 'unchanged' }
  | { status: 'complete'; diff: ToolDiffData }
  | { status: 'incomplete' };

/** Match CodeMirror's logical lines without changing the file on disk. */
export function normalizeReviewText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function createDocumentDiffData(
  filePath: string,
  beforeText: string,
  afterText: string,
): ToolDiffData | null {
  const result = calculateDocumentDiff(filePath, beforeText, afterText);
  return result.status === 'complete' ? result.diff : null;
}

export function calculateDocumentDiff(
  filePath: string,
  beforeText: string,
  afterText: string,
): DocumentDiffResult {
  beforeText = normalizeReviewText(beforeText);
  afterText = normalizeReviewText(afterText);
  if (beforeText === afterText) return { status: 'unchanged' };

  const beforeLines = splitDocumentLines(beforeText);
  const afterLines = splitDocumentLines(afterText);
  const prefixLength = commonPrefixLength(beforeLines, afterLines);
  const suffixLength = commonSuffixLength(beforeLines, afterLines, prefixLength);
  const beforeMiddle = beforeLines.slice(prefixLength, beforeLines.length - suffixLength);
  const afterMiddle = afterLines.slice(prefixLength, afterLines.length - suffixLength);
  const diffLines: DiffLine[] = [];

  for (let index = 0; index < prefixLength; index++) {
    diffLines.push(equalLine(beforeLines[index], index, index));
  }

  const middle = diffMiddle(beforeMiddle, afterMiddle, prefixLength);
  if (middle === null) return { status: 'incomplete' };
  diffLines.push(...middle);

  for (let offset = 0; offset < suffixLength; offset++) {
    const oldIndex = beforeLines.length - suffixLength + offset;
    const newIndex = afterLines.length - suffixLength + offset;
    diffLines.push(equalLine(beforeLines[oldIndex], oldIndex, newIndex));
  }

  const added = diffLines.filter(line => line.type === 'insert').length;
  const removed = diffLines.filter(line => line.type === 'delete').length;
  return {
    status: 'complete',
    diff: {
      filePath,
      diffLines,
      lineNumbersAreDocumentRelative: true,
      stats: { added, removed },
    },
  };
}

function splitDocumentLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function commonPrefixLength(beforeLines: readonly string[], afterLines: readonly string[]): number {
  const limit = Math.min(beforeLines.length, afterLines.length);
  let length = 0;
  while (length < limit && beforeLines[length] === afterLines[length]) length++;
  return length;
}

function commonSuffixLength(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  prefixLength: number,
): number {
  const limit = Math.min(beforeLines.length, afterLines.length) - prefixLength;
  let length = 0;
  while (
    length < limit
    && beforeLines[beforeLines.length - 1 - length] === afterLines[afterLines.length - 1 - length]
  ) {
    length++;
  }
  return length;
}

function diffMiddle(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  lineOffset: number,
  alignEqualLines = true,
): DiffLine[] | null {
  if (beforeLines.length * afterLines.length > MAX_LCS_CELLS) {
    if (alignEqualLines && beforeLines.length === afterLines.length) {
      const aligned = diffAroundAlignedEqualLines(beforeLines, afterLines, lineOffset);
      if (aligned) return aligned;
    }
    return buildMyersDiff(beforeLines, afterLines, lineOffset);
  }

  const table = buildLcsTable(beforeLines, afterLines);
  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (
      oldIndex < beforeLines.length
      && newIndex < afterLines.length
      && beforeLines[oldIndex] === afterLines[newIndex]
    ) {
      result.push(equalLine(
        beforeLines[oldIndex],
        lineOffset + oldIndex,
        lineOffset + newIndex,
      ));
      oldIndex++;
      newIndex++;
      continue;
    }

    if (
      oldIndex < beforeLines.length
      && (newIndex >= afterLines.length
        || table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])
    ) {
      result.push({
        oldLineNum: lineOffset + oldIndex + 1,
        text: beforeLines[oldIndex],
        type: 'delete',
      });
      oldIndex++;
      continue;
    }

    result.push({
      newLineNum: lineOffset + newIndex + 1,
      text: afterLines[newIndex],
      type: 'insert',
    });
    newIndex++;
  }
  return result;
}

function diffAroundAlignedEqualLines(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  lineOffset: number,
): DiffLine[] | null {
  if (!beforeLines.some((line, index) => line === afterLines[index])) return null;
  const result: DiffLine[] = [];
  let index = 0;
  while (index < beforeLines.length) {
    if (beforeLines[index] === afterLines[index]) {
      result.push(equalLine(beforeLines[index], lineOffset + index, lineOffset + index));
      index++;
      continue;
    }

    const start = index;
    while (index < beforeLines.length && beforeLines[index] !== afterLines[index]) index++;
    const changed = diffMiddle(
      beforeLines.slice(start, index),
      afterLines.slice(start, index),
      lineOffset + start,
      false,
    );
    if (changed === null) return null;
    result.push(...changed);
  }
  return result;
}

function buildMyersDiff(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  lineOffset: number,
): DiffLine[] | null {
  const oldLength = beforeLines.length;
  const newLength = afterLines.length;
  const maxDepth = oldLength + newLength;
  let frontier: MyersFrontier = { depth: -1, values: new Int32Array() };
  const trace: MyersFrontier[] = [];
  let work = 0;
  let traceEntries = 0;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const current: MyersFrontier = {
      depth,
      values: new Int32Array(2 * depth + 1),
    };
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      if (++work > MAX_MYERS_WORK) return null;
      const left = readMyersFrontier(frontier, diagonal - 1);
      const right = readMyersFrontier(frontier, diagonal + 1);
      const moveDown = depth === 0
        || diagonal === -depth
        || (diagonal !== depth && (left ?? -1) < (right ?? -1));
      let oldIndex = moveDown ? (right ?? 0) : (left ?? 0) + 1;
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLength
        && newIndex < newLength
        && beforeLines[oldIndex] === afterLines[newIndex]
      ) {
        if (++work > MAX_MYERS_WORK) return null;
        oldIndex++;
        newIndex++;
      }
      current.values[diagonal + depth] = oldIndex;
      if (oldIndex >= oldLength && newIndex >= newLength) {
        traceEntries += current.values.length;
        if (traceEntries > MAX_MYERS_TRACE_ENTRIES) return null;
        trace.push(current);
        return reconstructMyersDiff(beforeLines, afterLines, lineOffset, trace, depth);
      }
    }

    traceEntries += current.values.length;
    if (traceEntries > MAX_MYERS_TRACE_ENTRIES) return null;
    trace.push(current);
    frontier = current;
  }
  return null;
}

interface MyersFrontier {
  depth: number;
  values: Int32Array;
}

function readMyersFrontier(frontier: MyersFrontier, diagonal: number): number | undefined {
  if (Math.abs(diagonal) > frontier.depth || (diagonal + frontier.depth) % 2 !== 0) {
    return undefined;
  }
  return frontier.values[diagonal + frontier.depth];
}

function reconstructMyersDiff(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  lineOffset: number,
  trace: readonly MyersFrontier[],
  finalDepth: number,
): DiffLine[] {
  const reversed: DiffLine[] = [];
  let oldIndex = beforeLines.length;
  let newIndex = afterLines.length;

  for (let depth = finalDepth; depth > 0; depth--) {
    const previous = trace[depth - 1];
    const diagonal = oldIndex - newIndex;
    const left = readMyersFrontier(previous, diagonal - 1);
    const right = readMyersFrontier(previous, diagonal + 1);
    const previousDiagonal = diagonal === -depth
      || (diagonal !== depth && (left ?? -1) < (right ?? -1))
      ? diagonal + 1
      : diagonal - 1;
    const previousOldIndex = readMyersFrontier(previous, previousDiagonal) ?? 0;
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      oldIndex--;
      newIndex--;
      reversed.push(equalLine(
        beforeLines[oldIndex],
        lineOffset + oldIndex,
        lineOffset + newIndex,
      ));
    }

    if (oldIndex === previousOldIndex) {
      newIndex--;
      reversed.push({
        newLineNum: lineOffset + newIndex + 1,
        text: afterLines[newIndex],
        type: 'insert',
      });
    } else {
      oldIndex--;
      reversed.push({
        oldLineNum: lineOffset + oldIndex + 1,
        text: beforeLines[oldIndex],
        type: 'delete',
      });
    }
  }

  while (oldIndex > 0 && newIndex > 0) {
    oldIndex--;
    newIndex--;
    reversed.push(equalLine(
      beforeLines[oldIndex],
      lineOffset + oldIndex,
      lineOffset + newIndex,
    ));
  }
  return reversed.reverse();
}

function buildLcsTable(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): Uint32Array[] {
  const table = Array.from(
    { length: beforeLines.length + 1 },
    () => new Uint32Array(afterLines.length + 1),
  );
  for (let oldIndex = beforeLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = afterLines.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = beforeLines[oldIndex] === afterLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}

function equalLine(text: string, oldIndex: number, newIndex: number): DiffLine {
  return {
    newLineNum: newIndex + 1,
    oldLineNum: oldIndex + 1,
    text,
    type: 'equal',
  };
}
