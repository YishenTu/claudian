import type { DiffLine, DiffStats } from '@/core/types/diff';
import { t } from '@/i18n/i18n';
import {
  computeBlockInlineDiffs,
  createInlineDiffBudget,
  type InlineDiffBudget,
  type InlineDiffSegment,
} from '@/utils/inlineLineDiff';

export interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  newStart: number;
}

export function renderDiffStats(statsEl: HTMLElement, stats: DiffStats): void {
  if (stats.added > 0) {
    const addedEl = statsEl.createSpan({ cls: 'added' });
    addedEl.setText(`+${stats.added}`);
  }
  if (stats.removed > 0) {
    if (stats.added > 0) {
      statsEl.createSpan({ text: ' ' });
    }
    const removedEl = statsEl.createSpan({ cls: 'removed' });
    removedEl.setText(`-${stats.removed}`);
  }
}

export function splitIntoHunks(diffLines: DiffLine[], contextLines = 3): DiffHunk[] {
  if (diffLines.length === 0) return [];

  // Find indices of all changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== 'equal') {
      changedIndices.push(i);
    }
  }

  // If no changes, return empty
  if (changedIndices.length === 0) return [];

  // Group changed lines into ranges with context
  const ranges: Array<{ start: number; end: number }> = [];

  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diffLines.length - 1, idx + contextLines);

    // Merge with previous range if overlapping or adjacent
    if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
      ranges[ranges.length - 1].end = end;
    } else {
      ranges.push({ start, end });
    }
  }

  // Convert ranges to hunks
  const hunks: DiffHunk[] = [];

  let oldStart = 1;
  let newStart = 1;
  let cursor = 0;
  for (const range of ranges) {
    const lines = diffLines.slice(range.start, range.end + 1);
    while (cursor < range.start) {
      const type = diffLines[cursor++].type;
      if (type === 'equal' || type === 'delete') oldStart++;
      if (type === 'equal' || type === 'insert') newStart++;
    }

    hunks.push({ lines, oldStart, newStart });
  }

  return hunks;
}

/** Max lines to render for all-inserts diffs (new file creation). */
const NEW_FILE_DISPLAY_CAP = 20;

function renderDiffLine(
  hunkEl: HTMLElement,
  line: DiffLine,
  inlineSegments: readonly InlineDiffSegment[] | null = null,
): void {
  const lineEl = hunkEl.createDiv({ cls: `claudian-diff-line claudian-diff-${line.type}` });

  // Line prefix
  const prefix = line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' ';
  const prefixEl = lineEl.createSpan({ cls: 'claudian-diff-prefix' });
  prefixEl.setText(prefix);

  // Line content
  const contentEl = lineEl.createSpan({ cls: 'claudian-diff-text' });
  if (!inlineSegments) {
    contentEl.setText(line.text || ' '); // Show space for empty lines
    return;
  }

  const highlightCls = line.type === 'delete'
    ? 'claudian-diff-inline-delete'
    : 'claudian-diff-inline-insert';
  for (const segment of inlineSegments) {
    if (segment.changed) {
      const highlightEl = contentEl.createSpan({ cls: highlightCls });
      highlightEl.setText(segment.text);
    } else {
      contentEl.appendText(segment.text);
    }
  }
}

export function renderDiffContent(
  containerEl: HTMLElement,
  diffLines: DiffLine[],
  contextLines = 3,
  /** Shared across every diff in one tool card; defaults to a fresh budget. */
  inlineDiffBudget: InlineDiffBudget = createInlineDiffBudget(),
): void {
  containerEl.empty();

  // New file creation: all lines are inserts — cap display to avoid large DOM
  const allInserts = diffLines.length > 0 && diffLines.every(l => l.type === 'insert');
  if (allInserts && diffLines.length > NEW_FILE_DISPLAY_CAP) {
    const hunkEl = containerEl.createDiv({ cls: 'claudian-diff-hunk' });
    for (const line of diffLines.slice(0, NEW_FILE_DISPLAY_CAP)) {
      renderDiffLine(hunkEl, line);
    }
    const remaining = diffLines.length - NEW_FILE_DISPLAY_CAP;
    const separator = containerEl.createDiv({ cls: 'claudian-diff-separator' });
    separator.setText(t('chat.tools.moreLines', { count: remaining }));
    return;
  }

  const hunks = splitIntoHunks(diffLines, contextLines);

  if (hunks.length === 0) {
    // No changes
    const noChanges = containerEl.createDiv({ cls: 'claudian-diff-no-changes' });
    noChanges.setText(t('chat.tools.noChanges'));
    return;
  }

  hunks.forEach((hunk, hunkIndex) => {
    // Add separator between hunks
    if (hunkIndex > 0) {
      const separator = containerEl.createDiv({ cls: 'claudian-diff-separator' });
      separator.setText('...');
    }

    // Render hunk lines, pairing contiguous same-hunk delete/insert runs for intra-line highlights
    const hunkEl = containerEl.createDiv({ cls: 'claudian-diff-hunk' });
    let index = 0;

    while (index < hunk.lines.length) {
      if (hunk.lines[index].type !== 'delete') {
        renderDiffLine(hunkEl, hunk.lines[index++]);
        continue;
      }

      const deleteStart = index;
      do {
        index++;
      } while (index < hunk.lines.length && hunk.lines[index].type === 'delete' && !hunk.lines[index].hunkBreak);
      const insertStart = index;
      while (index < hunk.lines.length && hunk.lines[index].type === 'insert' && !hunk.lines[index].hunkBreak) {
        index++;
      }

      const deletedLines = hunk.lines.slice(deleteStart, insertStart);
      const insertedLines = hunk.lines.slice(insertStart, index);
      const { deleteSegments, insertSegments } = computeBlockInlineDiffs(
        deletedLines.map(entry => entry.text),
        insertedLines.map(entry => entry.text),
        inlineDiffBudget,
      );

      for (let i = 0; i < deletedLines.length; i++) {
        renderDiffLine(hunkEl, deletedLines[i], deleteSegments[i]);
      }
      for (let i = 0; i < insertedLines.length; i++) {
        renderDiffLine(hunkEl, insertedLines[i], insertSegments[i]);
      }
    }
  });
}
