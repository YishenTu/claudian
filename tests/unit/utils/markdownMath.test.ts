import {
  escapeMathDelimitersForStreaming,
  hasStreamingMathDelimiters,
} from '@/utils/markdownMath';

describe('markdownMath', () => {
  describe('escapeMathDelimitersForStreaming', () => {
    it('escapes inline and display math delimiters outside code', () => {
      expect(escapeMathDelimitersForStreaming('Use $x + y$ and $$z^2$$.')).toBe(
        'Use \\$x + y\\$ and \\$\\$z^2\\$\\$.'
      );
    });

    it('preserves inline code and fenced code dollars', () => {
      const markdown = [
        'Text $x$',
        '`echo $PATH`',
        '```bash',
        'echo "$HOME"',
        '```',
        'Done $$y$$',
      ].join('\n');

      expect(escapeMathDelimitersForStreaming(markdown)).toBe([
        'Text \\$x\\$',
        '`echo $PATH`',
        '```bash',
        'echo "$HOME"',
        '```',
        'Done \\$\\$y\\$\\$',
      ].join('\n'));
    });

    it('keeps already escaped dollars unchanged', () => {
      expect(escapeMathDelimitersForStreaming('Cost is \\$5, math is $x$.')).toBe(
        'Cost is \\$5, math is \\$x\\$.'
      );
    });

    it('does not alter dollars inside raw html tag attributes', () => {
      expect(escapeMathDelimitersForStreaming('<span title="$x$">value $y$</span>')).toBe(
        '<span title="$x$">value \\$y\\$</span>'
      );
    });
  });

  describe('hasStreamingMathDelimiters', () => {
    it('detects unescaped dollars outside code', () => {
      expect(hasStreamingMathDelimiters('math $x$')).toBe(true);
      expect(hasStreamingMathDelimiters('`echo $PATH`')).toBe(false);
      expect(hasStreamingMathDelimiters('\\$5')).toBe(false);
    });
  });
});
