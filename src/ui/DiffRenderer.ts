/**
 * DiffRenderer - Diff utilities for Write/Edit tool visualization
 *
 * Provides line-based diff computation with hunk support for showing
 * only edited regions with context lines and "..." separators.
 */

export interface DiffLine {
  type: 'equal' | 'insert' | 'delete';
  text: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  newStart: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Compute line-based diff between two texts using LCS algorithm. */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  // Normalize line endings for cross-platform compatibility
  const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
  const newLines = newText.replace(/\r\n/g, '\n').split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to find diff operations
  const result: DiffLine[] = [];
  let i = m,
    j = n;
  const temp: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'equal', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'insert', text: newLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'delete', text: oldLines[i - 1] });
      i--;
    }
  }

  // Reverse and assign line numbers
  temp.reverse();
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of temp) {
    if (line.type === 'equal') {
      result.push({ ...line, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
    } else if (line.type === 'delete') {
      result.push({ ...line, oldLineNum: oldLineNum++ });
    } else {
      result.push({ ...line, newLineNum: newLineNum++ });
    }
  }

  return result;
}

/** Count lines added and removed. */
export function countLineChanges(diffLines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;

  for (const line of diffLines) {
    if (line.type === 'insert') added++;
    else if (line.type === 'delete') removed++;
  }

  return { added, removed };
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

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render diff content to a container element. */
export function renderDiffContent(
  containerEl: HTMLElement,
  diffLines: DiffLine[],
  contextLines = 3
): void {
  containerEl.empty();

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

/** Convert diff lines to HTML string. */
export function diffLinesToHtml(diffLines: DiffLine[], contextLines = 3): string {
  const hunks = splitIntoHunks(diffLines, contextLines);

  if (hunks.length === 0) {
    return '<div class="claudian-diff-no-changes">No changes</div>';
  }

  const parts: string[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      parts.push('<div class="claudian-diff-separator">...</div>');
    }

    parts.push('<div class="claudian-diff-hunk">');

    for (const line of hunk.lines) {
      const prefix = line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' ';
      const escapedText = escapeHtml(line.text || ' ');
      parts.push(
        `<div class="claudian-diff-line claudian-diff-${line.type}">` +
          `<span class="claudian-diff-prefix">${prefix}</span>` +
          `<span class="claudian-diff-text">${escapedText}</span>` +
          `</div>`
      );
    }

    parts.push('</div>');
  });

  return parts.join('');
}

/** Check if content appears to be binary. */
export function isBinaryContent(content: string): boolean {
  // Check for null bytes or high ratio of non-printable characters
  // eslint-disable-next-line no-control-regex
  const nonPrintable = content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g);
  if (nonPrintable && nonPrintable.length > content.length * 0.1) {
    return true;
  }
  // Check for null byte specifically
  return content.includes('\x00');
}
