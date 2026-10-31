// @test-ci {"inputs":["src/style/**"]}
/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parser } from '@lezer/markdown';
import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

let renderer: MessageRenderer;
let host: HTMLElement;
let style: HTMLStyleElement;

beforeEach(async () => {
  document.body.replaceChildren();
  style = document.head.appendChild(document.createElement('style'));
  style.textContent = readFileSync(path.resolve('src/style/components/code.css'), 'utf8');
  host = document.body.createDiv();
  renderer = new MessageRenderer(
    await createChatFeatureHost({ settings: { mediaFolder: '' } }),
    new Component(),
    host,
  );
});

afterEach(() => {
  renderer.dispose();
  style.remove();
});

it.each([
  { language: '', expectedClass: '', expectedLabel: null, hasLanguage: false, accessibleName: 'Copy' },
  {
    language: '', decoyClass: 'not-language-decoy', expectedClass: 'not-language-decoy',
    expectedLabel: null, hasLanguage: false, accessibleName: 'Copy',
  },
  {
    language: '', decoyClass: 'decoy\u00a0language-c++', expectedClass: 'decoy\u00a0language-c++',
    expectedLabel: null, hasLanguage: false, accessibleName: 'Copy',
  },
  {
    language: 'c++', decoyClass: 'not-language-decoy', expectedClass: 'not-language-decoy language-c++',
    expectedLabel: 'c++', hasLanguage: true, accessibleName: 'Copy c++ code',
  },
  {
    language: 'c#', expectedClass: 'language-c#', expectedLabel: 'c#',
    hasLanguage: true, accessibleName: 'Copy c# code',
  },
  {
    language: 'typescript', expectedClass: 'language-typescript', expectedLabel: 'typescript',
    hasLanguage: true, accessibleName: 'Copy typescript code',
  },
  {
    language: 'objective-c', expectedClass: 'language-objective-c', expectedLabel: 'objective-c',
    hasLanguage: true, accessibleName: 'Copy objective-c code',
  },
  {
    language: 'css-extras', expectedClass: 'language-css-extras', expectedLabel: 'css-extras',
    hasLanguage: true, accessibleName: 'Copy css-extras code',
  },
])('adopts a fresh $language fence with an accessible copy control', async ({
  language, decoyClass, expectedClass, expectedLabel, hasLanguage, accessibleName,
}) => {
  let pre!: HTMLPreElement;
  let code!: HTMLElement;
  let copyButton!: HTMLButtonElement;
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown, target) => {
    const renderedLanguage = markdown.match(/^```([^\n]*)/)?.[1] ?? '';
    pre = (target as HTMLElement).createEl('pre');
    code = pre.createEl('code', {
      text: 'const x = 1;',
    });
    code.className = [decoyClass, renderedLanguage ? `language-${renderedLanguage}` : ''].filter(Boolean).join(' ');
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
  const accessibleCopy = within(host).getByRole('button', { name: accessibleName });
  expect(accessibleCopy.getAttribute('type')).toBe('button');
  accessibleCopy.focus();
  expect(document.activeElement).toBe(accessibleCopy);
  expect(accessibleCopy === copyButton).toBe(!hasLanguage);
  expect(copyButton.getAttribute('type')).toBe('button');
  expect(copyButton.parentElement).toBe(wrapper);
  expect(pre.contains(copyButton)).toBe(false);
  expect(code.className).toBe(expectedClass);
  expect(wrapper.classList.contains('has-language')).toBe(hasLanguage);
  expect(wrapper.querySelector('.claudian-code-lang-label')?.textContent ?? null).toBe(expectedLabel);
  expect((await axe(host)).violations).toEqual([]);
});

it.each([
  { language: 'typescript', code: 'const x = 1;' },
  { language: 'objective-c', code: '@implementation Thing\n@end' },
  { language: 'c++', code: 'int main() { return 0; }' },
  { language: 'c#', code: 'Console.WriteLine("Hello");' },
])('copies $language code through its language label and exposes the copied feedback accessibly', async ({
  language, code,
}) => {
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown, target) => {
    const renderedLanguage = markdown.match(/^```([^\n]*)/)?.[1] ?? '';
    const pre = (target as HTMLElement).createEl('pre');
    pre.createEl('code', {
      cls: renderedLanguage ? `language-${renderedLanguage}` : undefined,
      text: code,
    });
  });
  await renderer.renderContent(host, `\`\`\`${language}\n${code}\n\`\`\``);

  // WCAG 2.5.3: the accessible name contains the visible language label and names the action.
  const idleName = `Copy ${language} code`;
  const label = within(host).getByRole('button', { name: idleName });
  expect(label.textContent).toBe(language);
  const status = within(host).getByRole('status');
  expect(status.textContent).toBe('');
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.useFakeTimers();
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    label.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(code);
    expect(label.textContent).toBe('Copied!');
    expect(within(host).getByRole('button', { name: 'Copied!' })).toBe(label);
    expect(status.textContent).toBe('Copied!');

    vi.advanceTimersByTime(1_500);
    expect(label.textContent).toBe(language);
    expect(within(host).getByRole('button', { name: idleName })).toBe(label);
    expect(status.textContent).toBe('');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  }
});

it.each([
  { name: 'blockquote', before: '> ```text\n> literal', after: '```dataviewjs\nvoid 0;\n```' },
  { name: 'list', before: '- ```text\n  literal', after: '```dataviewjs\nvoid 0;\n```' },
  { name: 'nested blockquote', before: '> > ```text\n> > literal', after: '> ```dataviewjs\n> void 0;' },
  { name: 'nested list', before: '- - ```text\n    literal', after: '  ```dataviewjs\n  void 0;' },
  { name: 'quote inside list', before: '- > ```text\n  > literal', after: '  ```dataviewjs\n  void 0;' },
  { name: 'list inside quote', before: '> - ```text\n>   literal', after: '> ```dataviewjs\n> void 0;' },
])('neutralizes blocks after an implicitly closed $name fence', async ({ before, after }) => {
  const processExecutableCode = vi.fn();
  let forwarded = '';
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown) => {
    forwarded = markdown;
    // The host boundary dispatches processors by the actual parsed block language.
    parser.parse(markdown).iterate({ enter(node) {
      if (node.name === 'CodeInfo' && markdown.slice(node.from, node.to) === 'dataviewjs') {
        processExecutableCode();
      }
    } });
  });

  await renderer.renderContent(host, `${before}\n\n${after}\n<iframe src="https://example.invalid/"></iframe>`);

  expect(host.querySelector('.claudian-render-error')).toBeNull();
  expect(vi.mocked(MarkdownRenderer.render)).toHaveBeenCalled();
  expect(processExecutableCode).not.toHaveBeenCalled();
  expect(forwarded).toContain('&lt;iframe');
  expect(forwarded).not.toContain('<iframe');
});

it('preserves an existing wrapper without nesting a second wrapper', async () => {
  let wrapper!: HTMLElement;
  let pre!: HTMLPreElement;
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, target) => {
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

it.each([
  ['comment', '<!--'],
  ['CDATA section', '<![CDATA['],
  ['processing instruction', '<?target'],
  ['declaration', '<!DOCTYPE'],
].flatMap(([name, opener]) => ['\n', '\r\n'].map(newline => ({ name, opener, newline }))))(
  'neutralizes executable blocks after an indented unterminated $name ($newline)', async ({ opener, newline }) => {
    const processExecutableCode = vi.fn();
    let forwarded = '';
    vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown) => {
      forwarded = markdown;
      parser.parse(markdown).iterate({ enter(node) {
        if (node.name === 'CodeInfo' && markdown.slice(node.from, node.to) === 'dataviewjs') {
          processExecutableCode();
        }
      } });
    });
    const source = ['> <div>', `    ${opener}`, '> ~~~dataviewjs', '> void 0;', '> ~~~'].join(newline);

    await renderer.renderContent(host, source);

    expect(host.querySelector('.claudian-render-error')).toBeNull();
    expect(vi.mocked(MarkdownRenderer.render)).toHaveBeenCalled();
    expect(processExecutableCode).not.toHaveBeenCalled();
    expect(forwarded).toContain('claudian-display-only-fence-');
  },
);

describe('plugin-rendered fence languages', () => {
  const dispatchedLanguages = (markdown: string): string[] => {
    // The host boundary dispatches processors by the actual parsed block language.
    const languages: string[] = [];
    parser.parse(markdown).iterate({ enter(node) {
      if (node.name === 'CodeInfo') languages.push(markdown.slice(node.from, node.to));
    } });
    return languages;
  };
  const source = '```Vega-Lite\n{"mark": "bar"}\n```\n\n```dataviewjs\nvoid 0;\n```';

  beforeEach(async () => {
    renderer.dispose();
    renderer = new MessageRenderer(
      await createChatFeatureHost({ settings: { mediaFolder: '', pluginRenderedFenceLanguages: ['vega-lite'] } }),
      new Component(),
      host,
    );
  });

  it('dispatches listed languages to their processors and keeps others inert', async () => {
    let dispatched: string[] = [];
    vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown, target) => {
      dispatched = dispatchedLanguages(markdown);
      (target as HTMLElement).createDiv({ cls: 'block-language-Vega-Lite', text: 'chart' });
    });

    await renderer.renderContent(host, source);

    expect(dispatched).toEqual(['Vega-Lite', expect.stringMatching(/^claudian-display-only-fence-/)]);
    expect(host.querySelector('.claudian-render-error')).toBeNull();
    expect(host.querySelector('.block-language-Vega-Lite')?.textContent).toBe('chart');
  });

  it('keeps listed languages inert while diagrams are deferred', async () => {
    let dispatched: string[] = [];
    vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown) => {
      dispatched = dispatchedLanguages(markdown);
    });

    await renderer.renderContent(host, source, { deferDiagrams: true });

    expect(dispatched).toHaveLength(2);
    expect(dispatched.every(language => language.startsWith('claudian-display-only-fence-'))).toBe(true);
  });
});
