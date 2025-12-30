/**
 * Tests for DiffRenderer - Diff utilities for Write/Edit tool visualization
 */

import type { DiffLine } from '@/ui/renderers/DiffRenderer';
import {
  computeLineDiff,
  countLineChanges,
  diffLinesToHtml,
  isBinaryContent,
  splitIntoHunks,
} from '@/ui/renderers/DiffRenderer';

describe('DiffRenderer', () => {
  describe('computeLineDiff', () => {
    it('should handle empty string as single empty line', () => {
      // Empty string split on '\n' yields [''] - one empty line
      const result = computeLineDiff('', '');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('equal');
      expect(result[0].text).toBe('');
    });

    it('should return single equal line for identical single-line texts', () => {
      const result = computeLineDiff('hello', 'hello');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'equal',
        text: 'hello',
        oldLineNum: 1,
        newLineNum: 1,
      });
    });

    it('should detect single line insert with empty baseline', () => {
      // '' split yields [''], 'hello' split yields ['hello']
      // So this is a change from empty line to 'hello'
      const result = computeLineDiff('', 'hello');
      expect(result).toHaveLength(2);
      // Delete empty line, insert 'hello'
      expect(result[0].type).toBe('delete');
      expect(result[0].text).toBe('');
      expect(result[1].type).toBe('insert');
      expect(result[1].text).toBe('hello');
    });

    it('should detect single line delete to empty', () => {
      // 'hello' split yields ['hello'], '' split yields ['']
      const result = computeLineDiff('hello', '');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('delete');
      expect(result[0].text).toBe('hello');
      expect(result[1].type).toBe('insert');
      expect(result[1].text).toBe('');
    });

    it('should detect single line change', () => {
      const result = computeLineDiff('hello', 'world');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('delete');
      expect(result[0].text).toBe('hello');
      expect(result[1].type).toBe('insert');
      expect(result[1].text).toBe('world');
    });

    it('should handle multi-line diffs with insertions', () => {
      const oldText = 'line1\nline2\nline3';
      const newText = 'line1\ninserted\nline2\nline3';
      const result = computeLineDiff(oldText, newText);

      const insertedLines = result.filter(l => l.type === 'insert');
      expect(insertedLines).toHaveLength(1);
      expect(insertedLines[0].text).toBe('inserted');

      const equalLines = result.filter(l => l.type === 'equal');
      expect(equalLines).toHaveLength(3);
    });

    it('should handle multi-line diffs with deletions', () => {
      const oldText = 'line1\ndeleted\nline2\nline3';
      const newText = 'line1\nline2\nline3';
      const result = computeLineDiff(oldText, newText);

      const deletedLines = result.filter(l => l.type === 'delete');
      expect(deletedLines).toHaveLength(1);
      expect(deletedLines[0].text).toBe('deleted');

      const equalLines = result.filter(l => l.type === 'equal');
      expect(equalLines).toHaveLength(3);
    });

    it('should handle complete replacement', () => {
      const oldText = 'old1\nold2\nold3';
      const newText = 'new1\nnew2\nnew3';
      const result = computeLineDiff(oldText, newText);

      const deletedLines = result.filter(l => l.type === 'delete');
      const insertedLines = result.filter(l => l.type === 'insert');

      expect(deletedLines).toHaveLength(3);
      expect(insertedLines).toHaveLength(3);
    });

    it('should assign correct line numbers', () => {
      const oldText = 'a\nb\nc';
      const newText = 'a\nx\nb\nc';
      const result = computeLineDiff(oldText, newText);

      // First line should be equal with oldLineNum=1, newLineNum=1
      expect(result[0]).toMatchObject({
        type: 'equal',
        text: 'a',
        oldLineNum: 1,
        newLineNum: 1,
      });

      // Inserted line should have only newLineNum
      const inserted = result.find(l => l.type === 'insert');
      expect(inserted).toBeDefined();
      expect(inserted!.newLineNum).toBeDefined();
      expect(inserted!.oldLineNum).toBeUndefined();
    });

    it('should handle trailing newlines correctly', () => {
      const oldText = 'line1\nline2\n';
      const newText = 'line1\nline2\n';
      const result = computeLineDiff(oldText, newText);

      // Should have 3 equal lines (line1, line2, empty)
      expect(result.every(l => l.type === 'equal')).toBe(true);
      expect(result).toHaveLength(3);
    });

    it('should handle LCS algorithm for complex diffs', () => {
      const oldText = 'A\nB\nC\nD\nE';
      const newText = 'A\nX\nC\nY\nE';
      const result = computeLineDiff(oldText, newText);

      // A, C, E should be equal
      const equalLines = result.filter(l => l.type === 'equal');
      expect(equalLines.map(l => l.text)).toEqual(['A', 'C', 'E']);

      // B, D should be deleted
      const deletedLines = result.filter(l => l.type === 'delete');
      expect(deletedLines.map(l => l.text)).toEqual(['B', 'D']);

      // X, Y should be inserted
      const insertedLines = result.filter(l => l.type === 'insert');
      expect(insertedLines.map(l => l.text)).toEqual(['X', 'Y']);
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

  describe('isBinaryContent', () => {
    it('should return false for normal text', () => {
      expect(isBinaryContent('Hello, world!')).toBe(false);
      expect(isBinaryContent('Line 1\nLine 2\nLine 3')).toBe(false);
      expect(isBinaryContent('')).toBe(false);
    });

    it('should return true for null byte', () => {
      expect(isBinaryContent('hello\x00world')).toBe(true);
    });

    it('should return true for high ratio of non-printable characters', () => {
      // Create string with >10% non-printable chars
      const binary = 'a'.repeat(80) + '\x01\x02\x03\x04\x05\x06\x07\x08\x0E\x0F\x10\x11';
      expect(isBinaryContent(binary)).toBe(true);
    });

    it('should return false for low ratio of non-printable characters', () => {
      // Create string with <10% non-printable chars
      const mostlyText = 'a'.repeat(100) + '\x01';
      expect(isBinaryContent(mostlyText)).toBe(false);
    });

    it('should handle tabs and newlines as printable', () => {
      const withTabs = 'hello\tworld';
      const withNewlines = 'hello\nworld\r\n';
      expect(isBinaryContent(withTabs)).toBe(false);
      expect(isBinaryContent(withNewlines)).toBe(false);
    });

    it('should detect common binary file signatures', () => {
      // PNG header contains null bytes
      const pngLike = '\x89PNG\r\n\x1a\n\x00\x00\x00';
      expect(isBinaryContent(pngLike)).toBe(true);
    });
  });

  describe('diffLinesToHtml', () => {
    it('should return no-changes message for identical texts', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
      ];
      const html = diffLinesToHtml(diffLines);
      expect(html).toContain('claudian-diff-no-changes');
      expect(html).toContain('No changes');
    });

    it('should render inserted line with + prefix', () => {
      const diffLines: DiffLine[] = [
        { type: 'insert', text: 'new line', newLineNum: 1 },
      ];
      const html = diffLinesToHtml(diffLines);
      expect(html).toContain('claudian-diff-insert');
      expect(html).toContain('+');
      expect(html).toContain('new line');
    });

    it('should render deleted line with - prefix', () => {
      const diffLines: DiffLine[] = [
        { type: 'delete', text: 'old line', oldLineNum: 1 },
      ];
      const html = diffLinesToHtml(diffLines);
      expect(html).toContain('claudian-diff-delete');
      expect(html).toContain('-');
      expect(html).toContain('old line');
    });

    it('should render equal line with space prefix', () => {
      const diffLines: DiffLine[] = [
        { type: 'equal', text: 'same', oldLineNum: 1, newLineNum: 1 },
        { type: 'insert', text: 'new', newLineNum: 2 },
      ];
      const html = diffLinesToHtml(diffLines);
      expect(html).toContain('claudian-diff-equal');
    });

    it('should escape HTML special characters', () => {
      const diffLines: DiffLine[] = [
        { type: 'insert', text: '<script>alert("xss")</script>', newLineNum: 1 },
      ];
      const html = diffLinesToHtml(diffLines);
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&quot;xss&quot;');
      expect(html).not.toContain('<script>');
    });

    it('should add separator between distant hunks', () => {
      // Create diff with two distant changes
      const lines: DiffLine[] = [];
      for (let i = 1; i <= 5; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i });
      }
      lines.push({ type: 'insert', text: 'change1', newLineNum: 6 });
      for (let i = 6; i <= 15; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 1 });
      }
      lines.push({ type: 'insert', text: 'change2', newLineNum: 17 });
      for (let i = 16; i <= 20; i++) {
        lines.push({ type: 'equal', text: `line${i}`, oldLineNum: i, newLineNum: i + 2 });
      }

      const html = diffLinesToHtml(lines, 3);
      expect(html).toContain('claudian-diff-separator');
      expect(html).toContain('...');
    });

    it('should handle empty line text', () => {
      const diffLines: DiffLine[] = [
        { type: 'insert', text: '', newLineNum: 1 },
      ];
      const html = diffLinesToHtml(diffLines);
      // Should render space for empty line
      expect(html).toContain('claudian-diff-text');
    });
  });

  describe('edge cases', () => {
    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const result = computeLineDiff(longLine, longLine);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('equal');
    });

    it('should handle many lines efficiently', () => {
      const lines = Array(100).fill('line').join('\n');
      const result = computeLineDiff(lines, lines);
      expect(result).toHaveLength(100);
      expect(result.every(l => l.type === 'equal')).toBe(true);
    });

    it('should handle special characters in content', () => {
      const oldText = 'function foo() {\n  return "bar";\n}';
      const newText = 'function foo() {\n  return `bar`;\n}';
      const result = computeLineDiff(oldText, newText);

      expect(result).toHaveLength(4);
      const changed = result.filter(l => l.type !== 'equal');
      expect(changed).toHaveLength(2); // One delete, one insert
    });

    it('should handle unicode characters', () => {
      const oldText = 'Hello 世界\nこんにちは';
      const newText = 'Hello 世界\nさようなら';
      const result = computeLineDiff(oldText, newText);

      const deleted = result.find(l => l.type === 'delete');
      const inserted = result.find(l => l.type === 'insert');

      expect(deleted?.text).toBe('こんにちは');
      expect(inserted?.text).toBe('さようなら');
    });

    it('should handle Windows line endings', () => {
      const oldText = 'line1\r\nline2\r\n';
      const newText = 'line1\r\nline2\r\n';
      const result = computeLineDiff(oldText, newText);

      // Split on \n treats \r as part of line
      expect(result.every(l => l.type === 'equal')).toBe(true);
    });
  });
});
