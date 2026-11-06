/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { fireEvent, within } from '@testing-library/dom';
import { Component, loadMermaid, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { setLocale } from '@/i18n/i18n';

const source = 'graph TD\nA --> B\n';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Show diagram source</text><path d="M0 0L100 50"/></svg>';
const render = vi.fn();
let renderer: MessageRenderer;
let host: HTMLElement;

beforeEach(async () => {
  setLocale('en');
  document.body.replaceChildren();
  host = document.body.createDiv();
  renderer = new MessageRenderer(await createChatFeatureHost({ settings: { mediaFolder: '' } }),
    new Component(), host);
  render.mockReset().mockResolvedValue({ svg });
  vi.mocked(loadMermaid).mockResolvedValue({ render });
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    // Obsidian boundary fixture: preserve the neutralized language and native copy control.
    const language = markdown.match(/claudian-display-only-fence-\d+/)?.[0];
    const pre = (target as HTMLElement).createEl('pre');
    pre.createEl('code', { cls: `language-${language}`, text: source });
    pre.createEl('button', { text: 'Copy', cls: 'copy-code-button', attr: { type: 'button' } });
  });
});
afterEach(() => {
  renderer.dispose();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  setLocale('en');
});

it('renders diagrams and retains accessible source in the selected interface language', async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let clipboardWrite = Promise.resolve();
  const writeText = vi.fn((_text: string) => {
    clipboardWrite = Promise.resolve();
    return clipboardWrite;
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    // Fresh renders on the same imported modules catch a cached first-locale label.
    for (const { locale, language, diagramName, sourceName, copyName, copied } of [
      { locale: 'en', language: 'mermaid', diagramName: 'Mermaid diagram', sourceName: 'Show diagram source', copyName: 'Copy mermaid code', copied: 'Copied!' },
      { locale: 'zh-CN', language: 'mermaid', diagramName: 'Mermaid 图表', sourceName: '显示图表源码', copyName: '复制 mermaid 代码', copied: '已复制！' },
      { locale: 'en', language: 'mermaid', diagramName: 'Mermaid diagram', sourceName: 'Show diagram source', copyName: 'Copy mermaid code', copied: 'Copied!' },
      { locale: 'en', language: 'Mermaid', diagramName: 'Mermaid diagram', sourceName: 'Show diagram source', copyName: 'Copy Mermaid code', copied: 'Copied!' },
      { locale: 'en', language: 'MERMAID', diagramName: 'Mermaid diagram', sourceName: 'Show diagram source', copyName: 'Copy MERMAID code', copied: 'Copied!' },
    ] as const) {
      setLocale(locale);
      await renderer.renderContent(host, `\`\`\`${language}\n${source}\`\`\``);
      const image = within(host).getByRole('img', { name: diagramName });
      const src = image.getAttribute('src')!;
      expect(src).toContain('data:image/svg+xml');
      expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(svg);
      expect(render).toHaveBeenLastCalledWith(expect.stringMatching(/^claudian-mermaid-\d+$/), source, expect.any(HTMLElement));
      const toggle = within(host).getByRole('button', { name: sourceName });
      expect(toggle.getAttribute('type')).toBe('button');
      expect(toggle.hasAttribute('title')).toBe(false);
      expect(within(host).queryByRole('button', { name: 'Copy' })).toBeNull();
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      fireEvent.click(toggle);
      expect(within(host).queryByRole('img')).toBeNull();
      expect(within(host).queryByRole('button', { name: 'Show diagram' })).toBeNull();
      const code = host.querySelector('code')!;
      expect(code.textContent).toBe(source);
      expect(code.classList.contains(`language-${language}`)).toBe(true);
      expect(document.activeElement?.contains(code)).toBe(true);
      expect(document.getSelection()?.toString()).toBe(source);
      // The host's native Copy fixture is labelled/focusable, with no clipboard handler.
      const hostCopy = within(host).getByRole('button', { name: 'Copy' });
      hostCopy.focus();
      expect(document.activeElement).toBe(hostCopy);
      expect(within(host).queryByRole('img')).toBeNull();
      const copy = within(host).getByRole('button', { name: copyName });
      expect(copy.textContent).toBe(language);
      copy.focus();
      vi.useFakeTimers();
      try {
        fireEvent.click(copy);
        await clipboardWrite;
        expect(writeText).toHaveBeenLastCalledWith(source);
        expect(within(host).getByRole('button', { name: copied })).toBe(copy);
        expect(within(host).getByRole('status').textContent).toBe(copied);
        vi.advanceTimersByTime(1_499);
        expect(within(host).getByRole('button', { name: copied })).toBe(copy);
        vi.advanceTimersByTime(1);
        expect(within(host).getByRole('button', { name: copyName })).toBe(copy);
        expect(copy.textContent).toBe(language);
        expect(within(host).getByRole('status').textContent).toBe('');
      } finally {
        await clipboardWrite;
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
      expect((await axe(host)).violations).toEqual([]);
      const outside = document.body.createEl('button', { text: 'Outside', attr: { type: 'button' } });
      outside.focus();
      expect(within(host).getByRole('img', { name: diagramName })).toBe(image);
      expect(within(host).getByRole('button', { name: sourceName })).toBe(toggle);
      expect(within(host).queryByRole('button', { name: 'Copy' })).toBeNull();
      expect(within(host).queryByRole('button', { name: copyName })).toBeNull();
      expect(document.getSelection()?.toString()).toBe('');
      expect((await axe(host)).violations).toEqual([]);
      expect(vi.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).not.toMatch(/```mermaid/i);
      outside.remove();
    }
  } finally {
    await clipboardWrite;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('renders HTML-serialized label markup as a well-formed SVG image', async () => {
  // Mermaid serializes HTML labels with HTML rules: void `<br>` and named entities are not XML.
  render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><foreignObject width="100" height="50">'
      + '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>First line<br>Second&nbsp;line</p>'
      + '</span></div></foreignObject></svg>',
  });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const src = within(host).getByRole('img', { name: 'Mermaid diagram' }).getAttribute('src')!;
  const image = new DOMParser().parseFromString(
    decodeURIComponent(src.slice(src.indexOf(',') + 1)), 'image/svg+xml');
  expect(image.querySelector('parsererror')).toBeNull();
  expect(image.documentElement.localName).toBe('svg');
  const label = image.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'p')[0];
  expect(label.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'br')).toHaveLength(1);
  expect(label.textContent).toBe('First lineSecond\u00a0line');
});

it('passes well-formed SVG output through unchanged', async () => {
  // Valid XML that an HTML reparse would truncate: `<br/>` inside SVG `<text>` breaks out of `<svg>`.
  const wellFormed = '<svg xmlns="http://www.w3.org/2000/svg"><g><text>a<br/>b</text><rect/></g></svg>';
  render.mockResolvedValue({ svg: wellFormed });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const src = within(host).getByRole('img', { name: 'Mermaid diagram' }).getAttribute('src')!;
  expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(wellFormed);
});

it.each([undefined, '', '<svg><text>Syntax error</text><g class="error-icon"/></svg>'])('keeps source for invalid output %s', async output => {
  render.mockResolvedValue({ svg: output });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
  expect(within(host).queryByRole('button', { name: 'Show diagram' })).toBeNull();
});

it('keeps source on a rejected render and cleans temporary DOM', async () => {
  render.mockRejectedValue(new Error('invalid diagram'));
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
  expect(document.body.children).toHaveLength(1);
});

it('defers diagrams without losing code during streaming', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}`, { deferDiagrams: true });
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(within(host).getByRole('img', { name: 'Mermaid diagram' })).toBeDefined();
});

it('discards a diagram when the content is replaced before rendering completes', async () => {
  let finish!: (value: { svg: string }) => void;
  render.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  while (!finish) await Promise.resolve();
  await renderer.renderContent(host, 'Replacement');
  finish({ svg });
  await pending;
  expect(within(host).queryByRole('img')).toBeNull();
  expect(document.body.children).toHaveLength(1);
});

it('discards a diagram after renderer disposal', async () => {
  let finish!: (value: { svg: string }) => void;
  render.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  while (!finish) await Promise.resolve();
  renderer.dispose();
  finish({ svg });
  await pending;
  expect(within(host).queryByRole('img')).toBeNull();
  expect(document.body.children).toHaveLength(1);
});

it('reveals the source if the browser cannot display the diagram image', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  fireEvent.error(within(host).getByRole('img', { name: 'Mermaid diagram' }));
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
});

it.each(['```dataview\nTABLE file.name\n```', '````markdown\n```mermaid\ngraph TD\n```\n````'])('keeps ordinary and outer fences as source: %s', async markdown => {
  await renderer.renderContent(host, markdown);
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
});

it('keeps source open when focus moves to its copy control', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  fireEvent.click(within(host).getByRole('button', { name: 'Show diagram source' }));
  within(host).getByRole('button', { name: 'Copy' }).focus();
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Copy' })).toBe(document.activeElement);
});
