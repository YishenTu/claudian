import { appendMarkdownSnippet } from '@/utils/markdown';

describe('appendMarkdownSnippet', () => {
  it('returns existing prompt when snippet is empty', () => {
    expect(appendMarkdownSnippet('Hello', '')).toBe('Hello');
  });

  it('returns existing prompt when snippet is whitespace only', () => {
    expect(appendMarkdownSnippet('Hello', '   \n  ')).toBe('Hello');
  });

  it('returns trimmed snippet when existing prompt is empty', () => {
    expect(appendMarkdownSnippet('', '  Hello  ')).toBe('Hello');
  });

  it('returns trimmed snippet when existing prompt is whitespace only', () => {
    expect(appendMarkdownSnippet('   ', '  Hello  ')).toBe('Hello');
  });

  it('adds double newline separator when prompt does not end with newline', () => {
    expect(appendMarkdownSnippet('First', 'Second')).toBe('First\n\nSecond');
  });

  it('adds single newline when prompt ends with one newline', () => {
    expect(appendMarkdownSnippet('First\n', 'Second')).toBe('First\n\nSecond');
  });

  it('adds no separator when prompt ends with double newline', () => {
    expect(appendMarkdownSnippet('First\n\n', 'Second')).toBe('First\n\nSecond');
  });

  it('trims the snippet before appending', () => {
    expect(appendMarkdownSnippet('First', '  Second  ')).toBe('First\n\nSecond');
  });
});
