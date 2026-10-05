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

describe('webSearchContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('WebSearch expanded rendering', () => {
    it('renders Codex search actions instead of the placeholder result text', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'WebSearch',
        status: 'completed',
        input: {
          actionType: 'search',
          query: 'obsidian plugin API',
          queries: ['obsidian plugin API', 'obsidian docs'],
        },
        result: 'Search complete',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      const lines = Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Query: obsidian plugin API');
      expect(lines).toContain('Alt query: obsidian docs');
      expect(lines).not.toContain('Search complete');
    });

    it('renders Codex open_page actions from tool input even without a rich result body', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'WebSearch',
        status: 'completed',
        input: {
          actionType: 'open_page',
          url: 'https://example.com/docs',
        },
        result: 'Search complete',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      const links = toolEl.querySelectorAll('.claudian-tool-link');
      const lines = Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Open page');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
      expect(links[0].querySelector('.claudian-tool-link-title')?.textContent).toBe('https://example.com/docs');
    });

    it.each([
      ['structured hits', { webSearchResults: [{ title: 'Docs', url: 'https://docs.example.com/', snippet: 'Hit snippet', publishedAt: '2026-01-01' }], webSearchSummary: 'Synthesized answer', result: 'Provider result text' }, ['https://docs.example.com/']],
      ['result links', { result: 'Links: [{"title":"Docs","url":"https://docs.example.com/"}]\n\nSynthesized answer' }, ['https://docs.example.com/']],
      ['an unlinked result body', { result: 'Provider result text' }, []],
    ])('renders the request and linked titles only from %s', (_case, fields, links) => {
      const toolCall = createToolCall({ name: 'WebSearch', status: 'completed', input: { query: 'obsidian plugin API' }, ...fields });

      const toolEl = renderStoredToolCall(createMockEl(), toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();

      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent))
        .toContain('Query: obsidian plugin API');
      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-link')).map(link => link.getAttribute('href')))
        .toEqual(links);
      expect(toolEl.textContent).not.toMatch(/Synthesized answer|Provider result text|Hit snippet|2026-01-01/);
    });
  });

});
