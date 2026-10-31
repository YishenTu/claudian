
import type { DiffLine } from '@/core/types/diff';
import { splitIntoHunks } from '@/features/chat/rendering/tools/DiffRenderer';

describe('DiffRenderer', () => {
  describe('splitIntoHunks', () => {
    it('numbers separated insert/delete hunks with linear line visits', () => {
      let visits = 0;
      const lines: DiffLine[] = Array.from({ length: 1000 }, (_, index) => ({
        text: `${index}`,
        get type() {
          visits++;
          return index % 40 === 10 ? 'insert' : index % 40 === 30 ? 'delete' : 'equal';
        },
      }));
      const hunks = splitIntoHunks(lines);
      expect(hunks).toHaveLength(50);
      expect(hunks.map(hunk => [hunk.oldStart, hunk.newStart, hunk.lines.map(line => line.text)]))
        .toEqual(Array.from({ length: 50 }, (_, index) => [
          8 + 20 * index - Math.ceil(index / 2),
          8 + 20 * index - Math.floor(index / 2),
          Array.from({ length: 7 }, (_, offset) => `${7 + 20 * index + offset}`),
        ]));
      expect(visits).toBeLessThanOrEqual(5 * lines.length);
    });

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


});
