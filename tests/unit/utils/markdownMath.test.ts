import {
  escapeMathDelimitersForStreaming,
  hasStreamingMathDelimiters,
  normalizeLatexMathDelimiters,
} from '@/utils/markdownMath';

describe('markdownMath', () => {
  describe('normalizeLatexMathDelimiters', () => {
    it('normalizes inline and display LaTeX delimiters', () => {
      const markdown = [
        'Inline \\(x<y\\).',
        '\\[',
        'y^2',
        '\\]',
      ].join('\n');

      expect(normalizeLatexMathDelimiters(markdown)).toBe([
        'Inline $x<y$.',
        '$$',
        'y^2',
        '$$',
      ].join('\n'));
    });

    it('preserves existing dollars and unmatched or escaped LaTeX delimiters', () => {
      expect(
        normalizeLatexMathDelimiters('Keep $x$ and $$y$$. Unmatched \\(z. Escaped \\\\(x\\\\).')
      ).toBe(
        'Keep $x$ and $$y$$. Unmatched \\(z. Escaped \\\\(x\\\\).'
      );
    });

    it('preserves delimiters in inline, fenced, and indented code', () => {
      const markdown = [
        '`inline \\(code\\)` and \\(math\\)',
        '```tex',
        '\\[fenced\\]',
        '```',
        '    \\(indented\\)',
      ].join('\n');

      expect(normalizeLatexMathDelimiters(markdown)).toBe([
        '`inline \\(code\\)` and $math$',
        '```tex',
        '\\[fenced\\]',
        '```',
        '    \\(indented\\)',
      ].join('\n'));
    });

    it('preserves link destinations, autolinks, wikilinks, and HTML tags', () => {
      const markdown = [
        '[\\(label\\)](https://host/a\\(b\\))',
        '<https://host/a\\(b\\)>',
        '[[page\\(id\\)]]',
        '<span title="\\(raw\\)">\\(visible\\)</span>',
      ].join('\n');

      expect(normalizeLatexMathDelimiters(markdown)).toBe([
        '[$label$](https://host/a\\(b\\))',
        '<https://host/a\\(b\\)>',
        '[[page\\(id\\)]]',
        '<span title="\\(raw\\)">$visible$</span>',
      ].join('\n'));
    });

    it('preserves raw HTML bodies', () => {
      const markdown = '<pre>\n\\(literal\\)\n</pre>\n\\(visible\\)';
      expect(normalizeLatexMathDelimiters(markdown)).toBe(
        '<pre>\n\\(literal\\)\n</pre>\n$visible$'
      );
    });
  });

  describe('escapeMathDelimitersForStreaming', () => {
    it('escapes inline and display math outside code', () => {
      expect(escapeMathDelimitersForStreaming('Use $x + y$ and $$z^2$$.')).toBe(
        'Use \\$x + y\\$ and \\$\\$z^2\\$\\$.'
      );
    });

    it('preserves inline and fenced code dollars', () => {
      const markdown = [
        'Text $x$',
        '`echo $PATH`',
        '```bash',
        'echo "$HOME"',
        '```',
      ].join('\n');

      expect(escapeMathDelimitersForStreaming(markdown)).toBe([
        'Text \\$x\\$',
        '`echo $PATH`',
        '```bash',
        'echo "$HOME"',
        '```',
      ].join('\n'));
    });

    it('keeps odd-backslash dollar escapes and escapes after even runs', () => {
      expect(escapeMathDelimitersForStreaming(String.raw`\$5 \\$x$`)).toBe(
        String.raw`\$5 \\\$x\$`
      );
    });

    it('does not alter dollars inside HTML attributes', () => {
      expect(escapeMathDelimitersForStreaming('<span title="$x$">value $y$</span>')).toBe(
        '<span title="$x$">value \\$y\\$</span>'
      );
    });
  });

  describe('hasStreamingMathDelimiters', () => {
    it('detects dollar and LaTeX math outside code', () => {
      expect(hasStreamingMathDelimiters('math $x$')).toBe(true);
      expect(hasStreamingMathDelimiters('math \\(x<y\\)')).toBe(true);
      expect(hasStreamingMathDelimiters('math \\[x\\]')).toBe(true);
      expect(hasStreamingMathDelimiters('`echo $PATH`')).toBe(false);
      expect(hasStreamingMathDelimiters('`raw \\(x\\)`')).toBe(false);
      expect(hasStreamingMathDelimiters('\\$5')).toBe(false);
    });
  });
});
