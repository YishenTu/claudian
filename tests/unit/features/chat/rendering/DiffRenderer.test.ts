/**
 * Tests for DiffRenderer - Diff utilities for Write/Edit tool visualization
 */

import type { DiffLine, StructuredPatchHunk } from '@/core/types/diff';
import { renderDiffContent, splitIntoHunks } from '@/features/chat/rendering/DiffRenderer';
import { countLineChanges, structuredPatchToDiffLines } from '@/utils/diff';

/** Minimal mock element for renderDiffContent tests. */
function createMockElement(): any {
  const children: any[] = [];
  const classes = new Set<string>();
  const el: any = {
    children,
    textContent: '',
    empty: () => { children.length = 0; el.textContent = ''; },
    addClass: (cls: string) => { classes.add(cls); return el; },
    hasClass: (cls: string) => classes.has(cls),
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) opts.cls.split(' ').forEach(c => child.addClass(c));
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) opts.cls.split(' ').forEach(c => child.addClass(c));
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    setText: (text: string) => { el.textContent = text; },
    _children: children,
    _classes: classes,
  };
  return el;
}

/** Recursively count elements matching a class. */
function countByClass(el: any, cls: string): number {
  let count = el.hasClass(cls) ? 1 : 0;
  for (const child of el._children) count += countByClass(child, cls);
  return count;
}

/** Generate N insert DiffLines. */
function makeInsertLines(n: number): DiffLine[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'insert' as const,
    text: `line ${i + 1}`,
    newLineNum: i + 1,
  }));
}

describe('DiffRenderer', () => {
  describe('structuredPatchToDiffLines', () => {
    it('should return empty array for empty hunks', () => {
      const result = structuredPatchToDiffLines([]);
      expect(result).toEqual([]);
    });

    it('should convert a simple insertion hunk', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
        lines: [' line1', '+inserted', ' line2'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 });
      expect(result[1]).toEqual({ type: 'insert', text: 'inserted', newLineNum: 2 });
      expect(result[2]).toEqual({ type: 'equal', text: 'line2', oldLineNum: 2, newLineNum: 3 });
    });

    it('should convert a simple deletion hunk', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 1, oldLines: 3, newStart: 1, newLines: 2,
        lines: [' line1', '-deleted', ' line2'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 });
      expect(result[1]).toEqual({ type: 'delete', text: 'deleted', oldLineNum: 2 });
      expect(result[2]).toEqual({ type: 'equal', text: 'line2', oldLineNum: 3, newLineNum: 2 });
    });

    it('should convert a replacement (delete + insert)', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
        lines: [' line1', '-old', '+new', ' line3'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 });
      expect(result[1]).toEqual({ type: 'delete', text: 'old', oldLineNum: 2 });
      expect(result[2]).toEqual({ type: 'insert', text: 'new', newLineNum: 2 });
      expect(result[3]).toEqual({ type: 'equal', text: 'line3', oldLineNum: 3, newLineNum: 3 });
    });

    it('should handle multiple hunks', () => {
      const hunks: StructuredPatchHunk[] = [
        {
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: [' ctx', '-old1', '+new1'],
        },
        {
          oldStart: 10, oldLines: 2, newStart: 10, newLines: 2,
          lines: [' ctx2', '-old2', '+new2'],
        },
      ];
      const result = structuredPatchToDiffLines(hunks);

      expect(result).toHaveLength(6);
      // First hunk
      expect(result[0]).toEqual({ type: 'equal', text: 'ctx', oldLineNum: 1, newLineNum: 1 });
      expect(result[1]).toEqual({ type: 'delete', text: 'old1', oldLineNum: 2 });
      expect(result[2]).toEqual({ type: 'insert', text: 'new1', newLineNum: 2 });
      // Second hunk
      expect(result[3]).toEqual({ type: 'equal', text: 'ctx2', oldLineNum: 10, newLineNum: 10 });
      expect(result[4]).toEqual({ type: 'delete', text: 'old2', oldLineNum: 11 });
      expect(result[5]).toEqual({ type: 'insert', text: 'new2', newLineNum: 11 });
    });

    it('should handle hunk with only insertions (new file)', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 0, oldLines: 0, newStart: 1, newLines: 3,
        lines: ['+line1', '+line2', '+line3'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result).toHaveLength(3);
      expect(result.every(l => l.type === 'insert')).toBe(true);
      expect(result[0]).toEqual({ type: 'insert', text: 'line1', newLineNum: 1 });
      expect(result[1]).toEqual({ type: 'insert', text: 'line2', newLineNum: 2 });
      expect(result[2]).toEqual({ type: 'insert', text: 'line3', newLineNum: 3 });
    });

    it('should handle lines with special characters', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ['-return "bar";', '+return `bar`;'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result[0].text).toBe('return "bar";');
      expect(result[1].text).toBe('return `bar`;');
    });

    it('should handle unicode content', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ['-こんにちは', '+さようなら'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      expect(result[0]).toEqual({ type: 'delete', text: 'こんにちは', oldLineNum: 1 });
      expect(result[1]).toEqual({ type: 'insert', text: 'さようなら', newLineNum: 1 });
    });

    it('should track line numbers correctly across mixed operations', () => {
      const hunks: StructuredPatchHunk[] = [{
        oldStart: 5, oldLines: 4, newStart: 5, newLines: 5,
        lines: [' ctx', '-del1', '-del2', '+ins1', '+ins2', '+ins3', ' ctx2'],
      }];
      const result = structuredPatchToDiffLines(hunks);

      // Context: oldLine=5, newLine=5
      expect(result[0]).toEqual({ type: 'equal', text: 'ctx', oldLineNum: 5, newLineNum: 5 });
      // Deletes: oldLine 6,7
      expect(result[1]).toEqual({ type: 'delete', text: 'del1', oldLineNum: 6 });
      expect(result[2]).toEqual({ type: 'delete', text: 'del2', oldLineNum: 7 });
      // Inserts: newLine 6,7,8
      expect(result[3]).toEqual({ type: 'insert', text: 'ins1', newLineNum: 6 });
      expect(result[4]).toEqual({ type: 'insert', text: 'ins2', newLineNum: 7 });
      expect(result[5]).toEqual({ type: 'insert', text: 'ins3', newLineNum: 8 });
      // Context: oldLine=8, newLine=9
      expect(result[6]).toEqual({ type: 'equal', text: 'ctx2', oldLineNum: 8, newLineNum: 9 });
    });
  });

  describe('countLineChanges', () => {
    it('should return zeros for no changes', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'equal', text: 'line2', oldLineNum: 2, newLineNum: 2 },
      ];
      const stats = countLineChanges(diffLines);
      expect(stats).toEqual({ added: 0, removed: 0 });
    });

    it('should count inserted lines', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'insert', text: 'new1', newLineNum: 2 },
        { type: 'insert', text: 'new2', newLineNum: 3 },
        { type: 'equal', text: 'line2', oldLineNum: 2, newLineNum: 4 },
      ];
      const stats = countLineChanges(diffLines);
      expect(stats).toEqual({ added: 2, removed: 0 });
    });

    it('should count deleted lines', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'delete', text: 'old1', oldLineNum: 2 },
        { type: 'delete', text: 'old2', oldLineNum: 3 },
        { type: 'equal', text: 'line2', oldLineNum: 4, newLineNum: 2 },
      ];
      const stats = countLineChanges(diffLines);
      expect(stats).toEqual({ added: 0, removed: 2 });
    });

    it('should count both insertions and deletions', () => {
      const diffLines: DiffLine[] = [
        { type: 'delete', text: 'old', oldLineNum: 1 },
        { type: 'insert', text: 'new1', newLineNum: 1 },
        { type: 'insert', text: 'new2', newLineNum: 2 },
      ];
      const stats = countLineChanges(diffLines);
      expect(stats).toEqual({ added: 2, removed: 1 });
    });

    it('should return zeros for empty array', () => {
      const stats = countLineChanges([]);
      expect(stats).toEqual({ added: 0, removed: 0 });
    });
  });

  describe('splitIntoHunks', () => {
    it('should return empty array for no changes', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'equal', text: 'line2', oldLineNum: 2, newLineNum: 2 },
      ];
      const hunks = splitIntoHunks(diffLines);
      expect(hunks).toEqual([]);
    });

    it('should return empty array for empty diff', () => {
      const hunks = splitIntoHunks([]);
      expect(hunks).toEqual([]);
    });

    it('should create single hunk for adjacent changes', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'delete', text: 'old', oldLineNum: 2 },
        { type: 'insert', text: 'new', newLineNum: 2 },
        { type: 'equal', text: 'line2', oldLineNum: 3, newLineNum: 3 },
      ];
      const hunks = splitIntoHunks(diffLines, 3);

      expect(hunks).toHaveLength(1);
      expect(hunks[0].lines).toHaveLength(4);
    });

    it('should include context lines around changes', () => {
      const lines: DiffLine[] = [];
      // 10 equal lines, then 1 change, then 10 equal lines
      for (let i = 1; i <= 10; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i });
      }
      lines.push({ type: 'insert', text: 'inserted', newLineNum: 11 });
      for (let i = 11; i <= 20; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 1 });
      }

      const hunks = splitIntoHunks(lines, 3);

      expect(hunks).toHaveLength(1);
      // Should include 3 context lines before, 1 change, 3 context lines after = 7 lines
      expect(hunks[0].lines.length).toBe(7);
    });

    it('should create multiple hunks for distant changes', () => {
      const lines: DiffLine[] = [];
      // 10 equal lines
      for (let i = 1; i <= 10; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i });
      }
      // 1 change
      lines.push({ type: 'insert', text: 'change1', newLineNum: 11 });
      // 20 equal lines (more than 2*context, so hunks will be separate)
      for (let i = 11; i <= 30; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 1 });
      }
      // Another change
      lines.push({ type: 'insert', text: 'change2', newLineNum: 32 });
      // 10 more equal lines
      for (let i = 31; i <= 40; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 2 });
      }

      const hunks = splitIntoHunks(lines, 3);

      expect(hunks).toHaveLength(2);
    });

    it('should merge overlapping context regions into single hunk', () => {
      const lines: DiffLine[] = [];
      // 3 equal lines
      for (let i = 1; i <= 3; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i });
      }
      // Change 1
      lines.push({ type: 'insert', text: 'change1', newLineNum: 4 });
      // 4 equal lines (less than 2*3=6, so contexts overlap)
      for (let i = 4; i <= 7; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 1 });
      }
      // Change 2
      lines.push({ type: 'insert', text: 'change2', newLineNum: 9 });
      // 3 equal lines
      for (let i = 8; i <= 10; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 2 });
      }

      const hunks = splitIntoHunks(lines, 3);

      // Should merge into single hunk since context regions overlap
      expect(hunks).toHaveLength(1);
    });

    it('should calculate correct starting line numbers for hunks', () => {
      const lines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
        { type: 'equal', text: 'line2', oldLineNum: 2, newLineNum: 2 },
        { type: 'equal', text: 'line3', oldLineNum: 3, newLineNum: 3 },
        { type: 'delete', text: 'old', oldLineNum: 4 },
        { type: 'insert', text: 'new', newLineNum: 4 },
        { type: 'equal', text: 'line5', oldLineNum: 5, newLineNum: 5 },
      ];

      const hunks = splitIntoHunks(lines, 2);

      expect(hunks).toHaveLength(1);
      expect(hunks[0].oldStart).toBe(2); // Context starts at line 2
      expect(hunks[0].newStart).toBe(2);
    });
  });

  describe('renderDiffContent', () => {
    it('should render all lines when all-inserts count is within cap', () => {
      const container = createMockElement();
      const lines = makeInsertLines(20);

      renderDiffContent(container, lines);

      // All 20 insert lines rendered, no separator
      expect(countByClass(container, 'claudian-diff-insert')).toBe(20);
      expect(countByClass(container, 'claudian-diff-separator')).toBe(0);
    });

    it('should cap all-inserts diff at 20 lines with remainder message', () => {
      const container = createMockElement();
      const lines = makeInsertLines(100);

      renderDiffContent(container, lines);

      // Only 20 insert lines rendered
      expect(countByClass(container, 'claudian-diff-insert')).toBe(20);

      // Separator shows remaining count
      const separator = container._children.find(
        (c: any) => c.hasClass('claudian-diff-separator'),
      );
      expect(separator).toBeDefined();
      expect(separator.textContent).toBe('... 80 more lines');
    });

    it('should not cap mixed diff lines (edits with context)', () => {
      const container = createMockElement();
      // Build a diff with equal + insert lines — not all-inserts
      const lines: DiffLine[] = [
        { type: 'equal', text: 'ctx', oldLineNum: 1, newLineNum: 1 },
        ...makeInsertLines(30),
      ];

      renderDiffContent(container, lines);

      // All 30 insert lines rendered (not capped because not all-inserts)
      expect(countByClass(container, 'claudian-diff-insert')).toBe(30);
    });
  });
});
