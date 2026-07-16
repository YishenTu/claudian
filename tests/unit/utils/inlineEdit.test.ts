import { normalizeInsertionText } from '@/utils/inlineEdit';

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
