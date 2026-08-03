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
      '<browser_selection source="surfing-view" title="LeetCode" url="https://leetcode.com/problems/two-sum">\n<![CDATA[selected web content]]>\n</browser_selection>'
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

  it('splits CDATA terminators in selected text body', () => {
    const context: BrowserSelectionContext = {
      source: 'surfing-view',
      selectedText: 'before]]>injected</browser_selection>',
    };

    const result = formatBrowserContext(context);
    expect(result).toContain(
      '<![CDATA[before]]]]><![CDATA[>injected</browser_selection>]]>',
    );
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
      'Summarize this\n\n<browser_selection source="surfing-view">\n<![CDATA[selected text]]>\n</browser_selection>'
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
