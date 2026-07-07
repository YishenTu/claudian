import { MAX_SPEAK_CHARS, speakable } from '../../../src/features/voice/speakable';

describe('speakable', () => {
  it('drops fenced code blocks entirely', () => {
    expect(speakable('before\n```\ncode here\n```\nafter')).toBe('before after');
  });

  it('keeps the words inside inline code, dropping the backticks', () => {
    expect(speakable('run `npm test` now')).toBe('run npm test now');
  });

  it('drops URLs', () => {
    expect(speakable('see https://example.com/path?q=1 now')).toBe('see now');
  });

  it('drops absolute file paths but keeps surrounding words', () => {
    expect(speakable('open /usr/local/bin here')).toBe('open here');
  });

  it('does not drop a relative path with a single segment', () => {
    // A single-slash relative reference has no leading slash boundary match.
    expect(speakable('edit main.ts please')).toBe('edit main.ts please');
  });

  it('strips markdown emphasis and heading markers', () => {
    expect(speakable('**bold** _italic_ # Heading')).toBe('bold italic Heading');
  });

  it('strips a leading list bullet', () => {
    expect(speakable('- first item')).toBe('first item');
  });

  it('collapses whitespace runs and trims', () => {
    expect(speakable('  a   b \n c  ')).toBe('a b c');
  });

  it('truncates to the length cap at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(400).trim(); // ~2000 chars, well over the cap
    const result = speakable(long);
    expect(Array.from(result).length).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
    expect(result.endsWith(' ...')).toBe(true);
  });

  it('is idempotent at the length cap (does not re-truncate)', () => {
    const long = 'word '.repeat(400).trim();
    const once = speakable(long);
    const twice = speakable(once);
    expect(twice).toBe(once);
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(speakable('   \n  ')).toBe('');
  });
});
