import { createMockEl } from '@test/helpers/MockElement';
import { loadPrism } from 'obsidian';

import {
  DIAGRAM_SOURCE_CLASS,
  hasDiagramFence,
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

  it('neutralizes diagram fences too and only flags them for Claudian rendering', () => {
    const markdown = [
      '```dataview',
      'TABLE file.name',
      '```',
      '```Mermaid title="sample"',
      'flowchart TB',
      '```',
      '```dataviewjs',
      'dv.list([])',
      '```',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown, {
      diagramLanguages: ['mermaid'],
    });

    expect(prepared.markdown).toBe([
      '```claudian-display-only-fence-0',
      'TABLE file.name',
      '```',
      '```claudian-display-only-fence-1 title="sample"',
      'flowchart TB',
      '```',
      '```claudian-display-only-fence-2',
      'dv.list([])',
      '```',
    ].join('\n'));
    expect(prepared.markdown).not.toContain('mermaid');
    expect(prepared.fences).toEqual([
      {
        placeholderLanguage: 'claudian-display-only-fence-0',
        originalLanguage: 'dataview',
      },
      {
        placeholderLanguage: 'claudian-display-only-fence-1',
        originalLanguage: 'Mermaid',
        diagram: true,
      },
      {
        placeholderLanguage: 'claudian-display-only-fence-2',
        originalLanguage: 'dataviewjs',
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

  it('restores the nested code element when Prism copies the placeholder class to pre', async () => {
    const highlightElement = jest.fn((element: { tagName: string; empty: () => void }) => {
      if (element.tagName === 'PRE') {
        element.empty();
      }
    });
    (loadPrism as jest.Mock).mockResolvedValueOnce({ highlightElement });
    const container = createMockEl();
    const placeholderClass = 'language-claudian-display-only-fence-0';
    const pre = container.createEl('pre', { cls: placeholderClass });
    const code = pre.createEl('code', {
      cls: placeholderClass,
      text: 'const value = 1;',
    });
    const copyButton = pre.createEl('button', { cls: 'copy-code-button' });

    await restoreDisplayOnlyCodeFences(container, [{
      placeholderLanguage: 'claudian-display-only-fence-0',
      originalLanguage: 'typescript',
    }]);

    expect(code.hasClass(placeholderClass)).toBe(false);
    expect(code.hasClass('language-typescript')).toBe(true);
    expect(highlightElement).toHaveBeenCalledWith(code);
    expect(pre.querySelector('.copy-code-button')).toBe(copyButton);
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

  it('marks diagram fences for Claudian rendering instead of highlighting them', async () => {
    const highlightElement = jest.fn();
    (loadPrism as jest.Mock).mockResolvedValue({ highlightElement });
    const container = createMockEl();
    const diagram = container.createEl('code', {
      cls: 'language-claudian-display-only-fence-0',
      text: 'flowchart TB',
    });
    const source = container.createEl('code', {
      cls: 'language-claudian-display-only-fence-1',
      text: 'const value = 1;',
    });

    await restoreDisplayOnlyCodeFences(container, [
      {
        placeholderLanguage: 'claudian-display-only-fence-0',
        originalLanguage: 'mermaid',
        diagram: true,
      },
      {
        placeholderLanguage: 'claudian-display-only-fence-1',
        originalLanguage: 'typescript',
      },
    ]);

    expect(diagram.hasClass('language-mermaid')).toBe(true);
    expect(diagram.hasClass(DIAGRAM_SOURCE_CLASS)).toBe(true);
    expect(highlightElement).not.toHaveBeenCalledWith(diagram);
    expect(highlightElement).toHaveBeenCalledWith(source);
  });

  describe('hasDiagramFence', () => {
    it.each([
      ['plain fence', '```mermaid\nflowchart TB\n'],
      ['uppercase language', '```Mermaid\nflowchart TB\n'],
      ['blockquoted fence', '> ```mermaid\n> flowchart TB\n'],
      ['list-nested fence', '- ```mermaid\n  flowchart TB\n'],
      ['attributed fence', '```mermaid title="sample"\nflowchart TB\n'],
      ['tilde fence', '~~~mermaid\nflowchart TB\n'],
    ])('detects a %s', (_label, content) => {
      expect(hasDiagramFence(content)).toBe(true);
    });

    it.each([
      ['inner fence of an outer code block', '````markdown\n```mermaid\nflowchart TB\n```\n````'],
      ['inline code mentioning a fence', 'Use ` ```mermaid ` to draw a diagram.'],
      ['a different language', '```dataview\nTABLE file.name\n```'],
      ['a language that only starts with mermaid', '```mermaidjs\nflowchart TB\n```'],
      ['prose', 'Mermaid diagrams are nice.'],
    ])('does not report %s', (_label, content) => {
      expect(hasDiagramFence(content)).toBe(false);
    });
  });
});
