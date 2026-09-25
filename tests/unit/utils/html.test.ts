import { escapeHTML } from '@/utils/html';

describe('escapeHTML', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHTML('<script>alert("x&y")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'
    );
  });

  it('returns plain and empty text unchanged', () => {
    expect(escapeHTML('Hello World')).toBe('Hello World');
    expect(escapeHTML('')).toBe('');
  });
});
