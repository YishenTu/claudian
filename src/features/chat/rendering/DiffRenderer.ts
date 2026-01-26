/**
 * DiffRenderer - Diff rendering utilities for Write/Edit tool visualization.
 *
 * Provides hunk-based rendering for showing only edited regions
 * with context lines and "..." separators.
 */

import type { DiffLine } from '../../../core/types/diff';

export interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  newStart: number;
}

/** Split diff into hunks with context lines. */
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

  for (const range of ranges) {
    const lines = diffLines.slice(range.start, range.end + 1);

    // Find the starting line numbers for this hunk
    let oldStart = 1;
    let newStart = 1;

    // Count lines before this range
    for (let i = 0; i < range.start; i++) {
      const line = diffLines[i];
      if (line.type === 'equal' || line.type === 'delete') oldStart++;
      if (line.type === 'equal' || line.type === 'insert') newStart++;
    }

    hunks.push({ lines, oldStart, newStart });
  }

  return hunks;
}

/** Max lines to render for all-inserts diffs (new file creation). */
const NEW_FILE_DISPLAY_CAP = 20;

/** Render diff content to a container element. */
export function renderDiffContent(
  containerEl: HTMLElement,
  diffLines: DiffLine[],
  contextLines = 3
): void {
  containerEl.empty();

  // New file creation: all lines are inserts — cap display to avoid large DOM
  const allInserts = diffLines.length > 0 && diffLines.every(l => l.type === 'insert');
  if (allInserts && diffLines.length > NEW_FILE_DISPLAY_CAP) {
    const hunkEl = containerEl.createDiv({ cls: 'claudian-diff-hunk' });
    for (const line of diffLines.slice(0, NEW_FILE_DISPLAY_CAP)) {
      const lineEl = hunkEl.createDiv({ cls: 'claudian-diff-line claudian-diff-insert' });
      const prefixEl = lineEl.createSpan({ cls: 'claudian-diff-prefix' });
      prefixEl.setText('+');
      const contentEl = lineEl.createSpan({ cls: 'claudian-diff-text' });
      contentEl.setText(line.text || ' ');
    }
    const remaining = diffLines.length - NEW_FILE_DISPLAY_CAP;
    const separator = containerEl.createDiv({ cls: 'claudian-diff-separator' });
    separator.setText(`... ${remaining} more lines`);
    return;
  }

  const hunks = splitIntoHunks(diffLines, contextLines);

  if (hunks.length === 0) {
    // No changes
    const noChanges = containerEl.createDiv({ cls: 'claudian-diff-no-changes' });
    noChanges.setText('No changes');
    return;
  }

  hunks.forEach((hunk, hunkIndex) => {
    // Add separator between hunks
    if (hunkIndex > 0) {
      const separator = containerEl.createDiv({ cls: 'claudian-diff-separator' });
      separator.setText('...');
    }

    // Render hunk lines
    const hunkEl = containerEl.createDiv({ cls: 'claudian-diff-hunk' });

    for (const line of hunk.lines) {
      const lineEl = hunkEl.createDiv({ cls: `claudian-diff-line claudian-diff-${line.type}` });

      // Line prefix
      const prefix = line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' ';
      const prefixEl = lineEl.createSpan({ cls: 'claudian-diff-prefix' });
      prefixEl.setText(prefix);

      // Line content
      const contentEl = lineEl.createSpan({ cls: 'claudian-diff-text' });
      contentEl.setText(line.text || ' '); // Show space for empty lines
    }
  });
}
