import { createMockEl } from '@test/helpers/MockElement';
import { loadPrism } from 'obsidian';

import {
  prepareDisplayOnlyCodeFences,
  restoreDisplayOnlyCodeFences,
} from '@/features/chat/rendering/DisplayOnlyCodeFences';

describe('DisplayOnlyCodeFences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('restores original language classes and reapplies Prism highlighting', async () => {
    const highlightElement = jest.fn();
    (loadPrism as jest.Mock).mockResolvedValueOnce({ highlightElement });
    const container = createMockEl();
    const code = container.createEl('code', {
      cls: 'language-claudian-display-only-fence-0 extra-class',
      text: 'const value = 1;',
    });

    await restoreDisplayOnlyCodeFences(container, [{
      placeholderLanguage: 'claudian-display-only-fence-0',
      originalLanguage: 'typescript',
    }]);

    expect(code.hasClass('language-claudian-display-only-fence-0')).toBe(false);
    expect(code.hasClass('language-typescript')).toBe(true);
    expect(code.hasClass('extra-class')).toBe(true);
    expect(highlightElement).toHaveBeenCalledWith(code);
  });

  it('restores language classes even when Prism loading fails', async () => {
    (loadPrism as jest.Mock).mockRejectedValueOnce(new Error('Prism unavailable'));
    const container = createMockEl();
    const code = container.createEl('code', {
      cls: 'language-claudian-display-only-fence-0',
      text: 'TABLE file.name',
    });

    await expect(restoreDisplayOnlyCodeFences(container, [{
      placeholderLanguage: 'claudian-display-only-fence-0',
      originalLanguage: 'dataview',
    }])).resolves.toBeUndefined();

    expect(code.hasClass('language-dataview')).toBe(true);
  });
});
