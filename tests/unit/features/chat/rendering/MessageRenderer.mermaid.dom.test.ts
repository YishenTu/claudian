/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { loadMermaid, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

const source = 'graph TD\nA --> B\n';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0L100 50"/></svg>';
const render = jest.fn();
let renderer: MessageRenderer;
let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.body.createDiv();
  renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any,
    { registerDomEvent: jest.fn(), register: jest.fn() } as any, host);
  render.mockReset().mockResolvedValue({ svg });
  jest.mocked(loadMermaid).mockResolvedValue({ render });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    // Obsidian boundary fixture: preserve the neutralized language and native copy control.
    const language = markdown.match(/claudian-display-only-fence-\d+/)?.[0];
    const pre = (target as HTMLElement).createEl('pre');
    pre.createEl('code', { cls: `language-${language}`, text: source });
    pre.createEl('button', { text: 'Copy', cls: 'copy-code-button', attr: { type: 'button' } });
  });
});
afterEach(() => renderer.dispose());

it.each(['mermaid', 'Mermaid', 'MERMAID'])('renders %s directly and retains accessible source', async language => {
  await renderer.renderContent(host, `\`\`\`${language}\n${source}\`\`\``);
  expect(within(host).getByRole('img', { name: 'Mermaid diagram' }).getAttribute('src')).toContain('data:image/svg+xml');
  expect(render).toHaveBeenCalledWith(expect.any(String), source, expect.any(HTMLElement));
  const toggle = within(host).getByRole('button', { name: 'Show diagram source' });
  expect(toggle.getAttribute('type')).toBe('button');
  expect(within(host).queryByRole('button', { name: 'Copy' })).toBeNull();
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  expect(within(host).queryByRole('img')).toBeNull();
  expect(within(host).queryByRole('button', { name: 'Show diagram' })).toBeNull();
  expect(document.getSelection()?.toString()).toBe(source);
  expect(within(host).getByRole('button', { name: 'Copy' })).toBeDefined();
  expect((await axe(host)).violations).toEqual([]);
  const outside = document.body.createEl('button', { text: 'Outside' });
  outside.focus();
  expect(within(host).getByRole('img', { name: 'Mermaid diagram' })).toBeDefined();
  expect(within(host).queryByRole('button', { name: 'Copy' })).toBeNull();
  expect((await axe(host)).violations).toEqual([]);
  expect(jest.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).not.toMatch(/```mermaid/i);
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
