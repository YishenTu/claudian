/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

let renderer: MessageRenderer;
let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.body.createDiv();
  renderer = new MessageRenderer(
    { app: {}, settings: { mediaFolder: '' } } as any,
    { registerDomEvent: jest.fn(), register: jest.fn() } as any,
    host,
  );
});

afterEach(() => renderer.dispose());

it.each([
  { language: '', expectedClass: '', expectedLabel: null, hasLanguage: false },
  { language: 'typescript', expectedClass: 'language-typescript', expectedLabel: 'typescript', hasLanguage: true },
])('adopts a fresh $language fence while preserving its native copy control', async ({
  language, expectedClass, expectedLabel, hasLanguage,
}) => {
  let pre!: HTMLPreElement;
  let code!: HTMLElement;
  let copyButton!: HTMLButtonElement;
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown, target) => {
    const renderedLanguage = markdown.match(/^```([^\n]*)/)?.[1] ?? '';
    pre = (target as HTMLElement).createEl('pre');
    code = pre.createEl('code', {
      cls: renderedLanguage ? `language-${renderedLanguage}` : undefined,
      text: 'const x = 1;',
    });
    copyButton = pre.createEl('button', {
      cls: 'copy-code-button',
      text: 'Copy',
      attr: { type: 'button' },
    });
  });

  await renderer.renderContent(host, `\`\`\`${language}\nconst x = 1;\n\`\`\``);

  expect(host.querySelector('.claudian-render-error')).toBeNull();
  const wrappers = host.querySelectorAll('.claudian-code-wrapper');
  expect(wrappers).toHaveLength(1);
  const wrapper = wrappers[0];
  expect(pre.parentElement).toBe(wrapper);
  expect(code.parentElement).toBe(pre);
  expect(code.textContent).toBe('const x = 1;');
  expect(within(host).getByRole('button', { name: 'Copy' })).toBe(copyButton);
  expect(copyButton.getAttribute('type')).toBe('button');
  expect(copyButton.parentElement).toBe(wrapper);
  expect(pre.contains(copyButton)).toBe(false);
  expect(code.className).toBe(expectedClass);
  expect(wrapper.classList.contains('has-language')).toBe(hasLanguage);
  expect(wrapper.querySelector('.claudian-code-lang-label')?.textContent ?? null).toBe(expectedLabel);
  expect((await axe(host)).violations).toEqual([]);

});

it('copies code through its language label and restores the label after feedback', async () => {
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, target) => {
    const pre = (target as HTMLElement).createEl('pre');
    pre.createEl('code', { cls: 'language-typescript', text: 'const x = 1;' });
  });
  await renderer.renderContent(host, '```typescript\nconst x = 1;\n```');

  const label = within(host).getByText('typescript');
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = jest.fn().mockResolvedValue(undefined);
  jest.useFakeTimers();
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    label.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    expect(label.textContent).toBe('Copied!');

    jest.advanceTimersByTime(1_500);
    expect(label.textContent).toBe('typescript');
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  }
});

it('preserves an existing wrapper without nesting a second wrapper', async () => {
  let wrapper!: HTMLElement;
  let pre!: HTMLPreElement;
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, target) => {
    wrapper = (target as HTMLElement).createDiv({ cls: 'claudian-code-wrapper' });
    pre = wrapper.createEl('pre');
    pre.createEl('code', { text: 'already wrapped' });
  });

  await renderer.renderContent(host, '```\nalready wrapped\n```');

  expect(host.querySelector('.claudian-render-error')).toBeNull();
  expect(host.querySelectorAll('.claudian-code-wrapper')).toHaveLength(1);
  expect(host.firstElementChild).toBe(wrapper);
  expect(pre.parentElement).toBe(wrapper);
  expect(pre.textContent).toBe('already wrapped');
});
