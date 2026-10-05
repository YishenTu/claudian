import { createMockEl } from '@test/helpers/MockElement';

import type { ToolCallInfo } from '@/core/types';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';

jest.mock('obsidian', () => ({
  Platform: { resourcePathPrefix: 'app://local/' },
  setIcon: jest.fn(),
}));

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
    jest.clearAllMocks();
  });

  describe('result presentation contracts', () => {
    const expandedLines = (toolCall: ToolCallInfo) => {
      const toolEl = renderStoredToolCall(createMockEl(), toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      return Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);
    };

    it.each([
      ['Read', '     1→alpha\n     2→beta', ['alpha', 'beta']],
      ['Read', 'alpha\n2→ literal arrow', ['alpha', '2→ literal arrow']],
      ['Read', '1→alpha\n7→ literal', ['1→alpha', '7→ literal']],
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
      const toolEl = renderStoredToolCall(createMockEl(), createToolCall({
        name: 'GenerateImage', status: 'completed', input: { prompt: 'p' }, result: 'done', resultImages: [image],
      }));
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();

      const img = toolEl.querySelector('.claudian-tool-result-image');
      expect(img?.getAttribute('src')).toBe(src);
      expect(img?.getAttribute('alt')).toBe(alt);
    });
  });

});
