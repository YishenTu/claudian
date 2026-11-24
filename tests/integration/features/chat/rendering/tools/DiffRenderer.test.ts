/** @vitest-environment jsdom */

import { within } from '@testing-library/dom';

import { diffFromStructuredPatch, diffFromUnifiedText, parseApplyPatchDiffs } from '@/core/tools/toolDiff';
import type { DiffLine } from '@/core/types/diff';
import { renderDiffContent } from '@/features/chat/rendering/tools/DiffRenderer';

/** Generate N insert DiffLines. */
function makeInsertLines(n: number): DiffLine[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'insert' as const,
    text: `line ${i + 1}`,
    newLineNum: i + 1,
  }));
}

  describe('renderDiffContent', () => {
    it('should render all lines when all-inserts count is within cap', () => {
      const container = document.createElement('div');
      const lines = makeInsertLines(20);

      renderDiffContent(container, lines);

      // All 20 insert lines rendered, no separator
      expect(container.querySelectorAll('.claudian-diff-insert').length).toBe(20);
      expect(container.querySelectorAll('.claudian-diff-separator').length).toBe(0);
    });

    it('should cap all-inserts diff at 20 lines with remainder message', () => {
      const container = document.createElement('div');
      const lines = makeInsertLines(100);

      renderDiffContent(container, lines);

      // Only 20 insert lines rendered
      expect(container.querySelectorAll('.claudian-diff-insert').length).toBe(20);

      // Separator shows remaining count
      const separator = within(container).getByText('... 80 more lines');
      expect(separator).toBeDefined();
      expect(separator.textContent).toBe('... 80 more lines');
    });

    it('should not cap mixed diff lines (edits with context)', () => {
      const container = document.createElement('div');
      // Build a diff with equal + insert lines — not all-inserts
      const lines: DiffLine[] = [
        { type: 'equal', text: 'ctx', oldLineNum: 1, newLineNum: 1 },
        ...makeInsertLines(30),
      ];

      renderDiffContent(container, lines);

      // All 30 insert lines rendered (not capped because not all-inserts)
      expect(container.querySelectorAll('.claudian-diff-insert').length).toBe(30);
    });

    it('highlights only the changed CJK character on single-character insertion and modification', () => {
      const container = document.createElement('div');
      const lines: DiffLine[] = [
        { type: 'delete', text: '这是一段文字', oldLineNum: 1 },
        { type: 'insert', text: '这不是一段文字', newLineNum: 1 },
        { type: 'equal', text: '保持不变', oldLineNum: 2, newLineNum: 2 },
        { type: 'delete', text: '这是一段文字', oldLineNum: 3 },
        { type: 'insert', text: '这是一句文字', newLineNum: 3 },
      ];

      renderDiffContent(container, lines);

      // Line counts and full text content remain intact
      const deleteLines = Array.from(container.querySelectorAll('.claudian-diff-delete'));
      const insertLines = Array.from(container.querySelectorAll('.claudian-diff-insert'));
      expect(deleteLines).toHaveLength(2);
      expect(insertLines).toHaveLength(2);
      expect(Array.from(container.querySelectorAll('.claudian-diff-text'), el => el.textContent)).toEqual([
        '这是一段文字',
        '这不是一段文字',
        '保持不变',
        '这是一段文字',
        '这是一句文字',
      ]);

      // Pair 1: pure insertion of '不' highlights only '不' on the insert line
      expect(Array.from(deleteLines[0].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual([]);
      expect(Array.from(insertLines[0].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['不']);

      // Pair 2: replacing '段' with '句' highlights only '段' and '句'
      expect(Array.from(deleteLines[1].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual(['段']);
      expect(Array.from(insertLines[1].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['句']);
    });

    it('uses character-level diffing for Japanese/Korean and word-level for Latin in mixed lines', () => {
      const container = document.createElement('div');
      const lines: DiffLine[] = [
        { type: 'delete', text: 'これはテストです。', oldLineNum: 1 },
        { type: 'insert', text: 'これはベストです。', newLineNum: 1 },
        { type: 'equal', text: '---', oldLineNum: 2, newLineNum: 2 },
        { type: 'delete', text: '이것은 테스트 문장입니다.', oldLineNum: 3 },
        { type: 'insert', text: '이것은 좋은 테스트 문장입니다.', newLineNum: 3 },
        { type: 'equal', text: '---', oldLineNum: 4, newLineNum: 4 },
        { type: 'delete', text: '在 Obsidian 中使用 Claudian 插件', oldLineNum: 5 },
        { type: 'insert', text: '在 Notion 中使用 Claudian 工具', newLineNum: 5 },
      ];

      renderDiffContent(container, lines);

      const deleteLines = Array.from(container.querySelectorAll('.claudian-diff-delete'));
      const insertLines = Array.from(container.querySelectorAll('.claudian-diff-insert'));

      expect(Array.from(deleteLines[0].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual(['テ']);
      expect(Array.from(insertLines[0].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['ベ']);

      expect(Array.from(deleteLines[1].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual([]);
      expect(Array.from(insertLines[1].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['좋은 ']);

      expect(Array.from(deleteLines[2].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual(['Obsidian', '插件']);
      expect(Array.from(insertLines[2].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['Notion', '工具']);
    });

    it('pairs modified CJK lines across asymmetric multi-line hunks and skips unrelated replacements', () => {
      const container = document.createElement('div');
      const lines: DiffLine[] = [
        { type: 'delete', text: '这是一段文字', oldLineNum: 1 },
        { type: 'insert', text: '新增加的标题行', newLineNum: 1 },
        { type: 'insert', text: '这不是一段文字', newLineNum: 2 },
        { type: 'equal', text: 'ctx', oldLineNum: 2, newLineNum: 3 },
        { type: 'delete', text: 'const alpha = 1;', oldLineNum: 3 },
        { type: 'insert', text: 'return false;', newLineNum: 4 },
      ];

      renderDiffContent(container, lines);

      const deleteLines = Array.from(container.querySelectorAll('.claudian-diff-delete'));
      const insertLines = Array.from(container.querySelectorAll('.claudian-diff-insert'));

      // Asymmetric hunk pairs '这是一段文字' with '这不是一段文字', leaving the new heading unhighlighted inline
      expect(Array.from(insertLines[0].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual([]);
      expect(Array.from(insertLines[1].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['不']);

      // Unrelated replacement lines stay whole-line highlighted without noisy inline spans
      expect(deleteLines[1].querySelectorAll('.claudian-diff-inline-delete')).toHaveLength(0);
      expect(insertLines[2].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
    });

    it('does not pair distant zero-context hunks from unified, structured, or apply_patch diffs', () => {
      const unified = diffFromUnifiedText([
        '--- a/note.md',
        '+++ b/note.md',
        '@@ -10,1 +10,0 @@',
        '-旧标题',
        '@@ -100,0 +100,1 @@',
        '+新标题',
        '@@ -200,1 +200,1 @@',
        '-旧章节',
        '+新章节',
      ].join('\n'));
      expect(unified).toBeDefined();

      const unifiedContainer = document.createElement('div');
      renderDiffContent(unifiedContainer, unified!.diffLines);
      const unifiedDeletes = Array.from(unifiedContainer.querySelectorAll('.claudian-diff-delete'));
      const unifiedInserts = Array.from(unifiedContainer.querySelectorAll('.claudian-diff-insert'));

      // Distant zero-context hunks stay unpaired; same-hunk replacement is highlighted
      expect(unifiedDeletes[0].querySelectorAll('.claudian-diff-inline-delete')).toHaveLength(0);
      expect(unifiedInserts[0].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
      expect(Array.from(unifiedDeletes[1].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual(['旧']);
      expect(Array.from(unifiedInserts[1].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['新']);

      const structured = diffFromStructuredPatch([
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 0, lines: ['-旧标题'] },
        { oldStart: 100, oldLines: 0, newStart: 100, newLines: 1, lines: ['+新标题'] },
      ]);
      const structuredContainer = document.createElement('div');
      renderDiffContent(structuredContainer, structured!.diffLines);
      expect(structuredContainer.querySelectorAll('.claudian-diff-inline-delete')).toHaveLength(0);
      expect(structuredContainer.querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);

      const applied = parseApplyPatchDiffs([
        '*** Begin Patch',
        '*** Update File: note.md',
        '@@',
        '-旧标题',
        '@@',
        '+新标题',
        '*** End Patch',
      ].join('\n'));
      const applyContainer = document.createElement('div');
      renderDiffContent(applyContainer, applied[0].diffLines);
      expect(applyContainer.querySelectorAll('.claudian-diff-inline-delete')).toHaveLength(0);
      expect(applyContainer.querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
    });

    it('falls back to whole-line rendering once the cumulative inline-diff work budget is exhausted', () => {
      // Many small replacement runs in one render
      const manyRuns: DiffLine[] = [];
      for (let i = 0; i < 6; i++) {
        manyRuns.push(
          { type: 'delete', text: `这是一段文字${i}`, oldLineNum: i * 2 + 1 },
          { type: 'insert', text: `这不是一段文字${i}`, newLineNum: i * 2 + 1 },
          { type: 'equal', text: `context ${i}`, oldLineNum: i * 2 + 2, newLineNum: i * 2 + 2 },
        );
      }

      const manyContainer = document.createElement('div');
      // Budget allows only the first ~2 pairs (each pair charges ~15 chars of tokenization + 0 LCS cells)
      renderDiffContent(manyContainer, manyRuns, 3, 35);
      const manyInserts = Array.from(manyContainer.querySelectorAll('.claudian-diff-insert'));
      expect(manyInserts).toHaveLength(6);
      expect(manyInserts[0].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(1);
      expect(manyInserts[5].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
      expect(manyInserts[5].querySelector('.claudian-diff-text')?.textContent).toBe('这不是一段文字5');

      // Large equal-sized delete/insert block above the pairwise DP cap (20 * 20 = 400 > 256)
      const largeBlock: DiffLine[] = [
        ...Array.from({ length: 20 }, (_, i) => ({
          type: 'delete' as const,
          text: `前段甲乙丙丁旧${i}后段`,
          oldLineNum: i + 1,
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          type: 'insert' as const,
          text: `前段甲乙丙丁新${i}后段`,
          newLineNum: i + 1,
        })),
      ];

      const largeContainer = document.createElement('div');
      renderDiffContent(largeContainer, largeBlock, 3, 60);
      const largeInserts = Array.from(largeContainer.querySelectorAll('.claudian-diff-insert'));
      expect(largeInserts).toHaveLength(20);
      expect(largeInserts[0].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(1);
      expect(largeInserts[19].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
      expect(largeInserts[19].querySelector('.claudian-diff-text')?.textContent).toBe('前段甲乙丙丁新19后段');

      // Exhaustion driven specifically by LCS matrix work (not tokenization alone):
      // Each pair has 16-char lines with changes at both ends -> tokenization=32, matrix=16*16=256.
      // Budget 330 leaves 42 after pair 1 (288) and 10 after tokenizing pair 2 (32), exhausting on pair 2's matrix.
      const lcsExhaustionLines: DiffLine[] = [
        { type: 'delete', text: '甲今天天气很好，我们去公园散步乙', oldLineNum: 1 },
        { type: 'insert', text: '丙今天天气很好，我们去公园散步丁', newLineNum: 1 },
        { type: 'equal', text: 'ctx', oldLineNum: 2, newLineNum: 2 },
        { type: 'delete', text: '甲今天天气很好，我们去公园散步乙', oldLineNum: 3 },
        { type: 'insert', text: '丙今天天气很好，我们去公园散步丁', newLineNum: 3 },
      ];
      const lcsContainer = document.createElement('div');
      renderDiffContent(lcsContainer, lcsExhaustionLines, 3, 330);
      const lcsDeletes = Array.from(lcsContainer.querySelectorAll('.claudian-diff-delete'));
      const lcsInserts = Array.from(lcsContainer.querySelectorAll('.claudian-diff-insert'));
      expect(Array.from(lcsDeletes[0].querySelectorAll('.claudian-diff-inline-delete'), el => el.textContent)).toEqual(['甲', '乙']);
      expect(Array.from(lcsInserts[0].querySelectorAll('.claudian-diff-inline-insert'), el => el.textContent)).toEqual(['丙', '丁']);
      expect(lcsDeletes[1].querySelectorAll('.claudian-diff-inline-delete')).toHaveLength(0);
      expect(lcsInserts[1].querySelectorAll('.claudian-diff-inline-insert')).toHaveLength(0);
      expect(lcsInserts[1].querySelector('.claudian-diff-text')?.textContent).toBe('丙今天天气很好，我们去公园散步丁');
    });
  });