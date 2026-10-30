/** @vitest-environment jsdom */

import { within } from '@testing-library/dom';

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
  });