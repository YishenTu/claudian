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

function collectRenderedText(toolEl: HTMLElement): string {
  return [
    ...Array.from(toolEl.querySelectorAll('.claudian-tool-line')),
    ...Array.from(toolEl.querySelectorAll('.claudian-tool-link-title')),
  ].map(el => el.textContent ?? '').join('\n');
}

describe('webSearchContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('WebSearch expanded rendering', () => {
    it('renders Codex search actions instead of the placeholder result text', () => {
      const parentEl = document.createElement('div');
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
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));
      const lines = Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Query: obsidian plugin API');
      expect(lines).toContain('Alt query: obsidian docs');
      expect(lines).not.toContain('Search complete');
    });

    it('renders Codex open_page actions from tool input even without a rich result body', () => {
      const parentEl = document.createElement('div');
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
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));
      const links = toolEl.querySelectorAll('.claudian-tool-link');
      const lines = Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Open page');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
      expect(links[0].querySelector('.claudian-tool-link-title')?.textContent).toBe('https://example.com/docs');
    });

    it.each([
      ['structured hits', { webSearchResults: [{ title: 'Docs', url: 'https://docs.example.com/', snippet: 'Hit snippet', publishedAt: '2026-01-01' }], webSearchSummary: 'Synthesized answer', result: 'Links: [{"title":"FallbackSource","url":"https://fallback.example.com/"}]\n\nProvider result text' }, ['https://docs.example.com/']],
      ['result links', { result: 'Links: [{"title":"Docs","url":"https://docs.example.com/"}]\n\nSynthesized answer' }, ['https://docs.example.com/']],
      ['a mixed null and valid link list', { result: 'Links: [null,{"title":"Docs","url":"https://docs.example.com/"}]\n' }, ['https://docs.example.com/']],
      ['a malformed whole link list', { result: 'Links: [not-json]\n' }, []],
      ['an unlinked result body', { result: 'Provider result text' }, []],
    ])('renders the request and linked titles only from %s', (_case, fields, links) => {
      const toolCall = createToolCall({ name: 'WebSearch', status: 'completed', input: { query: 'obsidian plugin API' }, ...fields });

      const toolEl = renderStoredToolCall(document.createElement('div'), toolCall);
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));

      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent))
        .toContain('Query: obsidian plugin API');
      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-link')).map(link => link.getAttribute('href')))
        .toEqual(links);
      expect(collectRenderedText(toolEl)).not.toMatch(/Synthesized answer|Provider result text|Hit snippet|2026-01-01|FallbackSource/);
    });

    it('skips malformed link entries without rendering them beside valid neighbors', () => {
      const toolCall = createToolCall({
        name: 'WebSearch',
        status: 'completed',
        input: { query: 'docs' },
        result: `Links: ${JSON.stringify([
          null, 42, 'scalar', ['KeepArr', 'https://arr.example.com/'],
          { title: 'KeepFirst', url: 'https://first.example.com/' },
          { title: 'BadUrlMarker7f3a', url: 424242 },
          { url: 'https://missingtitle.example.com/' },
          { title: '', url: 'https://emptytitle.example.com/' },
          { title: 7, url: 'https://badtitle.example.com/' },
          { title: 'KeepSecond', url: 'https://second.example.com/' },
        ])}\n`,
      });

      const toolEl = renderStoredToolCall(document.createElement('div'), toolCall);
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));

      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(line => line.textContent))
        .toContain('Query: docs');
      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-link')).map(link => link.getAttribute('href')))
        .toEqual(['https://first.example.com/', 'https://second.example.com/']);
      const renderedText = collectRenderedText(toolEl);
      expect(renderedText).not.toContain('BadUrlMarker7f3a');
      expect(renderedText).not.toContain('https://missingtitle.example.com/');
    });
  });

});
