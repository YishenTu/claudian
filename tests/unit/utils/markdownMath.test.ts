import { parser } from '@lezer/markdown';

import {
  escapeMathDelimitersForStreaming,
  hasStreamingMathDelimiters,
  normalizeLatexMathDelimiters,
} from '@/utils/markdownMath';

describe('markdownMath', () => {
  describe('normalizeLatexMathDelimiters', () => {
    it.each([
      String.raw`Escaped \*punctuation\* and C:\Users\example\notes.`,
      String.raw`Unmatched closing delimiters \) and \].`,
      String.raw`An escaped price \$5 and dollar math $x$.`,
    ])('skips parsing without a LaTeX opening delimiter: %s', markdown => {
      const parse = jest.spyOn(parser, 'parse');
      try {
        expect(normalizeLatexMathDelimiters(markdown)).toBe(markdown);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });

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

    it.each([
      ['trims leading inline-boundary padding', 'Inline \\( x + y\\).', 'Inline $x + y$.'],
      ['trims trailing inline-boundary padding', 'Inline \\(x + y \\).', 'Inline $x + y$.'],
      ['trims both inline boundaries', 'Inline \\(  x + y  \\).', 'Inline $x + y$.'],
      ['trims multiple padded inline expressions', String.raw`Inline \( a \) and \( b \).`, String.raw`Inline $a$ and $b$.`],
      ['trims inline-boundary tabs', 'Inline \\(	x + y	\\).', 'Inline $x + y$.'],
      ['keeps internal expression spacing', 'Inline \\(  x   +   y  \\).', 'Inline $x   +   y$.'],
      ['keeps backslash-escaped TeX spaces at boundaries', String.raw`Inline \(\ x\ \).`, String.raw`Inline $\ x\ $.`],
      ['keeps explicit TeX spacing commands against trimmed padding', String.raw`Inline \( \,x\, \).`, String.raw`Inline $\,x\,$.`],
      ['keeps whitespace-only inline expressions', 'Inline \\(  \\).', 'Inline $  $.'],
      ['keeps whitespace-only inline expressions containing a newline', 'Inline \\( \n \\).', 'Inline $ \n $.'],
      ['keeps whitespace-only inline expressions containing NBSP', 'Inline \\( \u00a0 \\).', 'Inline $ \u00a0 $.'],
      ['keeps empty inline expressions', 'Inline \\(\\).', 'Inline $$.'],
      ['keeps unmatched inline closers with padding', 'Keep x + y \\).', 'Keep x + y \\).'],
      ['keeps unmatched inline openers with padding', 'Keep \\( x + y.', 'Keep \\( x + y.'],
      ['keeps display expression padding', 'Display \\[  x + y  \\].', 'Display $$  x + y  $$.'],
      ['keeps padded inline delimiters in protected Markdown', '`\\(  x  \\)` and [label](https://host/a\\(  x  \\)) and <span title="\\(  x  \\)">ok</span>', '`\\(  x  \\)` and [label](https://host/a\\(  x  \\)) and <span title="\\(  x  \\)">ok</span>'],
    ])('%s', (_name, markdown, expected) => {
      expect(normalizeLatexMathDelimiters(markdown)).toBe(expected);
    });

    it('preserves raw HTML bodies', () => {
      const markdown = '<pre>\n\\(literal\\)\n</pre>\n\\(visible\\)';
      expect(normalizeLatexMathDelimiters(markdown)).toBe(
        '<pre>\n\\(literal\\)\n</pre>\n$visible$'
      );
    });
  });

  describe('escapeMathDelimitersForStreaming', () => {
    it('bounds paragraph scans for currency tables followed by real math', () => {
      const rows = Array.from({ length: 400 }, (_, index) => `| Item ${index} | $${100 + index} |`);
      const markdown = `${rows.join('\n')}\n\n$x$`;
      const indexOf = String.prototype.indexOf;
      let newlineSearches = 0;
      let result: string;
      String.prototype.indexOf = function (search, position) {
        if (String(this) === markdown && search === '\n') newlineSearches += 1;
        return indexOf.call(this, search, position);
      };
      try {
        result = escapeMathDelimitersForStreaming(markdown);
      } finally {
        String.prototype.indexOf = indexOf;
      }
      expect(result).toBe(`${rows.map(row => row.replace('$', '\\$')).join('\n')}\n\n\\$x\\$`);
      expect(newlineSearches).toBeLessThan(rows.length * 10);
    });

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

    it.each([
      "[guide](https://example.com/it's/$id)",
      '[guide](https://example.com/say"hi/$id)',
      '[guide](<https://example.com/a(b/$id>)',
      '[guide](<https://example.com/a)b/$id> "title")',
      "[guide](https://example.com/it's/$id 'title with ) inside')",
      '[guide](<https://example.com/a(b/$id> "title with ) inside")',
    ])('preserves valid link destinations with quotes or angle brackets: %s', destination => {
      const markdown = `${destination} and $visible$`;
      expect(escapeMathDelimitersForStreaming(markdown)).toBe(`${destination} and \\$visible\\$`);
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
