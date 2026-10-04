import { extractFirstParagraph } from '@/core/commands/slashCommand';

describe('extractFirstParagraph', () => {
  it('returns the first paragraph from multi-paragraph content', () => {
    expect(extractFirstParagraph('First paragraph.\n\nSecond paragraph.'))
      .toBe('First paragraph.');
  });

  it('returns single-line content as-is', () => {
    expect(extractFirstParagraph('Only one line')).toBe('Only one line');
  });

  it('collapses multi-line first paragraph into single line', () => {
    expect(extractFirstParagraph('Line one\nline two\n\nSecond paragraph'))
      .toBe('Line one line two');
  });

  it('returns undefined for empty content', () => {
    expect(extractFirstParagraph('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only content', () => {
    expect(extractFirstParagraph('   \n  \n  ')).toBeUndefined();
  });

  it('skips leading blank lines', () => {
    expect(extractFirstParagraph('\n\nActual first paragraph.\n\nSecond.'))
      .toBe('Actual first paragraph.');
  });
});
