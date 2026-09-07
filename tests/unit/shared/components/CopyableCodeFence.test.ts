import { createMockEl } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import {
  enhanceRenderedCodeFence,
  renderCopyableCodeFence,
} from '@/shared/components/CopyableCodeFence';

describe('CopyableCodeFence', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(setIcon).mockClear();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => createMockEl(tag),
      },
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  });

  it('renders a standard code fence and shows transient copy feedback', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      const container = createMockEl();
      const prompt = 'Line one\n1. Line two';

      const wrapper = renderCopyableCodeFence(container, prompt, {
        copyLabel: 'Copy prompt',
      });

      expect((wrapper as any).hasClass('claudian-code-wrapper')).toBe(true);
      expect((wrapper as any).children[0]?.children[0]?.textContent).toBe(prompt);
      const copyButton = (wrapper as any).querySelector('.copy-code-button');
      expect(copyButton.getAttribute('aria-label')).toBe('Copy prompt');

      copyButton.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(prompt);
      expect(copyButton.textContent).toBe('Copied!');
      expect(copyButton.hasClass('copied')).toBe(true);

      jest.advanceTimersByTime(1_500);
      expect(copyButton.textContent).toBe('');
      expect(copyButton.hasClass('copied')).toBe(false);
      expect(setIcon).toHaveBeenLastCalledWith(copyButton, 'copy');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('adopts a Markdown-rendered fence without duplicating its wrapper', () => {
    const container = createMockEl();
    const pre = container.createEl('pre');
    Object.defineProperty(pre, 'parentElement', {
      configurable: true,
      value: container,
    });
    const code = pre.createEl('code', { text: 'const ready = true;' });
    code.className = 'language-typescript';
    const copyButton = pre.createEl('button', { cls: 'copy-code-button' });
    const querySelector = pre.querySelector.bind(pre);
    pre.querySelector = (selector: string) => (
      selector.startsWith('code[') ? code : querySelector(selector)
    );

    const wrapper = enhanceRenderedCodeFence(pre);
    Object.defineProperty(pre, 'parentElement', {
      configurable: true,
      value: wrapper,
    });
    const repeated = enhanceRenderedCodeFence(pre);

    expect(repeated).toBe(wrapper);
    expect((wrapper as any).hasClass('claudian-code-wrapper')).toBe(true);
    expect((wrapper as any).hasClass('has-language')).toBe(true);
    expect((wrapper as any).querySelector('.claudian-code-lang-label')?.textContent)
      .toBe('typescript');
    expect((wrapper as any).children).toContain(copyButton);
    expect(container.querySelectorAll('.claudian-code-wrapper')).toHaveLength(1);
  });
});
