import { normalizeInsertionText } from '@/utils/inlineEdit';

describe('normalizeInsertionText', () => {
  it.each([
    ['newline-only content', '\n\n', ''],
    ['spaces', '  Content  ', '  Content  '],
    ['markdown blocks', '\n\n# Title\n\nParagraph\n\n', '# Title\n\nParagraph'],
    ['code blocks', '\n```js\nconst x = 1;\n```\n', '```js\nconst x = 1;\n```'],
  ])('preserves %s while trimming surrounding newlines', (_name, input, expected) => {
    expect(normalizeInsertionText(input)).toBe(expected);
  });

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
