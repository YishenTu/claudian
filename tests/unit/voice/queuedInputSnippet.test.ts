import {
  QUEUED_SNIPPET_MAX_LEN,
  queuedInputSnippet,
} from '../../../src/features/voice/queuedInputSnippet';

describe('queuedInputSnippet', () => {
  it('returns empty string for null/undefined/blank input', () => {
    expect(queuedInputSnippet(null)).toBe('');
    expect(queuedInputSnippet(undefined)).toBe('');
    expect(queuedInputSnippet('   ')).toBe('');
    expect(queuedInputSnippet('\n\t  \n')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(queuedInputSnippet('  hello world  ')).toBe('hello world');
  });

  it('collapses internal whitespace and newlines to single spaces', () => {
    expect(queuedInputSnippet('add\n\na    new   test')).toBe('add a new test');
  });

  it('returns short content unchanged', () => {
    expect(queuedInputSnippet('short message')).toBe('short message');
  });

  it('truncates long content with an ellipsis at the max length', () => {
    const long = 'a'.repeat(QUEUED_SNIPPET_MAX_LEN + 20);
    const result = queuedInputSnippet(long);
    expect(result).toBe('a'.repeat(QUEUED_SNIPPET_MAX_LEN) + '…');
    // Ellipsis is a single char beyond the cap.
    expect(result.length).toBe(QUEUED_SNIPPET_MAX_LEN + 1);
  });

  it('does not truncate content exactly at the max length', () => {
    const exact = 'b'.repeat(QUEUED_SNIPPET_MAX_LEN);
    expect(queuedInputSnippet(exact)).toBe(exact);
  });

  it('honors a custom max length', () => {
    expect(queuedInputSnippet('abcdefgh', 3)).toBe('abc…');
  });
});
