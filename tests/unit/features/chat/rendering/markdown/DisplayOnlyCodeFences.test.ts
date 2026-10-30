import { parser } from '@lezer/markdown';

import {
  hasDeferredDiagramFence,
  prepareDisplayOnlyCodeFences,
} from '@/features/chat/rendering/markdown/DisplayOnlyCodeFences';

describe('DisplayOnlyCodeFences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    '# Summary\n\nOrdinary **Markdown** with [a link](https://example.com).',
    'Inline `code` and ``two backticks`` with ~ and ~~strikethrough~~.',
    '    indented code\n\nMore prose.',
  ])('skips full parsing when fence preparation cannot change the source: %s', markdown => {
    const parse = vi.spyOn(parser, 'parse');
    try {
      expect(prepareDisplayOnlyCodeFences(markdown)).toEqual({ markdown, fences: [] });
      expect(hasDeferredDiagramFence(markdown, new Set(['dataview']))).toBe(false);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('replaces every fenced language while preserving fence structure and metadata', () => {
    const markdown = [
      '> ```dataview',
      '> TABLE file.name',
      '> ```',
      '- ~~~typescript title="sample"',
      '  const value = 1;',
      '  ~~~',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '> ```claudian-display-only-fence-0',
      '> TABLE file.name',
      '> ```',
      '- ~~~claudian-display-only-fence-1 title="sample"',
      '  const value = 1;',
      '  ~~~',
    ].join('\n'));
    expect(prepared.fences).toEqual([
      {
        placeholderLanguage: 'claudian-display-only-fence-0',
        originalLanguage: 'dataview',
      },
      {
        placeholderLanguage: 'claudian-display-only-fence-1',
        originalLanguage: 'typescript',
      },
    ]);
  });

  it('does not treat fence-like content inside an outer fence as a new block', () => {
    const markdown = [
      '````markdown',
      '```dataview',
      'TABLE file.name',
      '```',
      '````',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '````claudian-display-only-fence-0',
      '```dataview',
      'TABLE file.name',
      '```',
      '````',
    ].join('\n'));
    expect(prepared.fences).toHaveLength(1);
    expect(prepared.fences[0].originalLanguage).toBe('markdown');
  });

  it('protects unclosed streaming fences and leaves non-language syntax unchanged', () => {
    const markdown = [
      '` ```dataview`',
      '```',
      'plain code',
      '```',
      '```dataview',
      'TABLE file.name',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '` ```dataview`',
      '```',
      'plain code',
      '```',
      '```claudian-display-only-fence-0',
      'TABLE file.name',
    ].join('\n'));
    expect(prepared.fences).toHaveLength(1);
  });


});
