import { escapeHtml, normalizeInsertionText } from '@/utils/inlineEdit';

describe('normalizeInsertionText', () => {
  it('removes leading blank lines', () => {
    expect(normalizeInsertionText('\n\nHello')).toBe('Hello');
  });

  it('removes trailing blank lines', () => {
    expect(normalizeInsertionText('Hello\n\n')).toBe('Hello');
  });

  it('removes both leading and trailing blank lines', () => {
    expect(normalizeInsertionText('\n\nHello\n\n')).toBe('Hello');
  });

  it('handles \\r\\n line endings', () => {
    expect(normalizeInsertionText('\r\n\r\nHello\r\n\r\n')).toBe('Hello');
  });

  it('preserves internal newlines', () => {
    expect(normalizeInsertionText('\nLine 1\nLine 2\n')).toBe('Line 1\nLine 2');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeInsertionText('')).toBe('');
  });

  it('returns text unchanged when no leading/trailing newlines', () => {
    expect(normalizeInsertionText('Hello World')).toBe('Hello World');
  });
});

describe('escapeHtml', () => {
  it('escapes < to &lt;', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes > to &gt;', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes both angle brackets in HTML tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('returns text unchanged when no angle brackets', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});
