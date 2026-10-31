/** @vitest-environment jsdom */

import { loadPrism } from 'obsidian';

import { restoreDisplayOnlyCodeFences } from '@/features/chat/rendering/markdown/DisplayOnlyCodeFences';

  it('restores original language classes and reapplies Prism highlighting', async () => {
    const highlightElement = vi.fn();
    vi.mocked(loadPrism).mockResolvedValueOnce({ highlightElement });
    const container = document.createElement('div');
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
    const highlightElement = vi.fn((element: { tagName: string; empty: () => void }) => {
      if (element.tagName === 'PRE') {
        element.empty();
      }
    });
    vi.mocked(loadPrism).mockResolvedValueOnce({ highlightElement });
    const container = document.createElement('div');
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
    vi.mocked(loadPrism).mockRejectedValueOnce(new Error('Prism unavailable'));
    const container = document.createElement('div');
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