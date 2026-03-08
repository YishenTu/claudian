import {
  appendBrowserContext,
  type BrowserSelectionContext,
  formatBrowserContext,
} from '../../../src/utils/browser';

describe('formatBrowserContext', () => {
  it('formats browser selection as XML', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: 'selected web content',
      title: 'LeetCode',
      url: 'https://leetcode.com/problems/two-sum',
    };

    expect(formatBrowserContext(context)).toBe(
      '<browser_selection source="surfing-view" title="LeetCode" url="https://leetcode.com/problems/two-sum">\nselected web content\n</browser_selection>'
    );
  });

  it('escapes XML attribute quotes', () => {
    const context: BrowserSelectionContext = {
      source: 'webview',
      selectedText: 'content',
      title: 'title "with quote"',
    };

    expect(formatBrowserContext(context)).toContain('title="title &quot;with quote&quot;"');
  });

  it('escapes closing tag in selected text body', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: 'before</browser_selection>injected',
    };

    const result = formatBrowserContext(context);
    expect(result).not.toContain('</browser_selection>injected');
    expect(result).toContain('before&lt;/browser_selection&gt;injected');
    expect(result).toMatch(/<browser_selection[^>]*>\n[\s\S]*\n<\/browser_selection>$/);
  });

  it('returns empty string for blank selection text', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: '   ',
    };

    expect(formatBrowserContext(context)).toBe('');
  });
});

describe('appendBrowserContext', () => {
  it('appends browser selection context to prompt', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: 'selected text',
    };

    expect(appendBrowserContext('Summarize this', context)).toBe(
      'Summarize this\n\n<browser_selection source="surfing-view">\nselected text\n</browser_selection>'
    );
  });

  it('returns original prompt when context is empty', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: '',
    };

    expect(appendBrowserContext('Prompt', context)).toBe('Prompt');
  });
});
