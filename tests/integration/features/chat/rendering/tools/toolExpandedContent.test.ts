/** @vitest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';

import type { ToolCallInfo } from '@/core/types';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';

// Helper to create a basic tool call
function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tool-123',
    name: 'Read',
    input: { file_path: '/test/file.md' },
    status: 'running',
    ...overrides,
  };
}

describe('toolExpandedContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('result presentation contracts', () => {
    const expandedLines = (toolCall: ToolCallInfo) => {
      const toolEl = renderStoredToolCall(document.createElement('div'), toolCall);
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));
      return Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);
    };

    it.each([
      ['Read', '     1→alpha\n     2→beta', ['alpha', 'beta']],
      ['Read', 'alpha\n2→ literal arrow', ['alpha', '2→ literal arrow']],
      ['Read', '1→alpha\n7→ literal', ['1→alpha', '7→ literal']],
      ['Read', '1→alpha\n2→beta\n9→literal arrow', ['1→alpha', '2→beta', '9→literal arrow']],
      ['Read', '1→alpha\n\n2→beta', ['1→alpha', ' ', '2→beta']],
      ['Read', '1→alpha\n2→beta\nplain line\n3→gamma', ['1→alpha', '2→beta', 'plain line', '3→gamma']],
      ['Read', '1→alpha\n2→beta\n3→gamma', ['alpha', 'beta', 'gamma']],
      ['Read', '5→alpha\n6→beta', ['alpha', 'beta']],
      ['Read', '1→alpha\n2→beta\n', ['alpha', 'beta', ' ']],
      ['Read', '1→alpha\n2→beta\n\n', ['1→alpha', '2→beta', ' ', ' ']],
      ['Read', '1→alpha\r\n2→beta\r\n3→gamma', ['alpha', 'beta', 'gamma']],
      ['Grep', '1→match', ['1→match']],
    ])('strips %s line-number gutters only when numbering is consecutive', (name, result, lines) => {
      expect(expandedLines(createToolCall({ name, input: { file_path: 'a.md', pattern: 'x' }, status: 'completed', result }))).toEqual(lines);
    });

    it('displays normalized Read text verbatim even when it resembles consecutive gutters', () => {
      expect(expandedLines(createToolCall({
        name: 'Read', input: { file_path: 'a.md' }, status: 'completed',
        result: '1→literal\n2→also literal', resultFormat: 'plain',
      }))).toEqual(['1→literal', '2→also literal']);
    });

    it.each([
      [{ kind: 'file' as const, path: '/Users/me/out dir/a#1.png' }, 'app://local/Users/me/out%20dir/a%231.png', 'a#1.png'],
      [{ kind: 'file' as const, path: 'C:\\out\\b.png', alt: 'B' }, 'app://local/C:/out/b.png', 'B'],
      [{ kind: 'data' as const, mediaType: 'image/png', data: 'AAAA' }, 'data:image/png;base64,AAAA', 'image/png'],
    ])('renders result images from %j', (image, src, alt) => {
      const toolEl = renderStoredToolCall(document.createElement('div'), createToolCall({
        name: 'GenerateImage', status: 'completed', input: { prompt: 'p' }, result: 'done', resultImages: [image],
      }));
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));

      const img = toolEl.querySelector('.claudian-tool-result-image');
      expect(img?.getAttribute('src')).toBe(src);
      expect(img?.getAttribute('alt')).toBe(alt);
    });
  });

});
