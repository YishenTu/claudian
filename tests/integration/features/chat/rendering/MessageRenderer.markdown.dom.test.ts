/** @vitest-environment jsdom */

import '@/providers';

import { parser } from '@lezer/markdown';
import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { renderObsidianHTML } from '@test/helpers/ObsidianMarkdownRenderer';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component, MarkdownRenderer, type TFile } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/rendering/subagents/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { StreamController } from '@/features/chat/turns/StreamController';
import * as fileLinks from '@/utils/fileLink';

let renderer: MessageRenderer;
let host: HTMLElement;
let app: App;
let settings: { mediaFolder: string };

beforeEach(async () => {
  host = document.body.createDiv();
  const image = { path: 'Media/photo.png', basename: 'photo' } as TFile;
  const note = { path: 'note.md', basename: 'note' } as TFile;
  app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === image.path ? image : null,
      getResourcePath: (file: TFile) => `app://local/${file.path}`,
    },
    metadataCache: {
      getFirstLinkpathDest: (path: string) => path === note.path ? note : null,
    },
    keymap: new App().keymap,
  } as unknown as App;
  const plugin = await createChatFeatureHost({ app, settings: { mediaFolder: '' } });
  settings = plugin.settings;
  renderer = new MessageRenderer(plugin, new Component(), host);
});

afterEach(() => {
  renderer.dispose();
  host.remove();
  vi.restoreAllMocks();
});

it.each([true, false])('prepares streamed math once without a separate detection parse (defer=%s)', async deferMath => {
  vi.useFakeTimers();
  const state = new ChatState();
  state.currentContentEl = host;
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin: await createChatFeatureHost({ app, settings: { ...settings, deferMathRenderingDuringStreaming: deferMath } }),
    state, renderer, subagentManager: subagents, getMessagesEl: () => host, updateQueueIndicator: () => undefined,
  });
  const parse = vi.spyOn(parser, 'parse');
  try {
    const message = { id: 'streamed', role: 'assistant' as const, timestamp: testDate().getTime(), content: '' };
    await stream.handleStreamChunk({ type: 'text', content: 'Math $x$' }, message);
    await vi.advanceTimersByTimeAsync(20);
    expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, deferMath ? 'Math \\$x\\$' : 'Math $x$', expect.anything(), '', expect.any(Component));
    expect(parse).toHaveBeenCalledTimes(deferMath ? 1 : 0);
    await stream.handleStreamChunk({ type: 'text', content: ' and \\(y\\)' }, message);
    await vi.advanceTimersByTimeAsync(200);
    expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app,
      deferMath ? 'Math \\$x\\$ and \\$y\\$' : 'Math $x$ and $y$', expect.anything(), '', expect.any(Component));
  } finally {
    stream.dispose();
    subagents.clear();
    state.dispose();
    vi.useRealTimers();
  }
});

it('keeps finalized collapsed thinking lazy and renders its final math on expansion', async () => {
  vi.mocked(MarkdownRenderer.render).mockClear();
  vi.useFakeTimers();
  const state = new ChatState();
  state.currentContentEl = host;
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin: await createChatFeatureHost({ app, settings: { ...settings, deferMathRenderingDuringStreaming: true, enableAutoScroll: true } }),
    state, renderer, subagentManager: subagents, getMessagesEl: () => host, updateQueueIndicator: () => undefined,
  });
  const readHeight = vi.fn(() => 1000);
  Object.defineProperty(host, 'scrollHeight', { get: readHeight, configurable: true });
  try {
    const message = { id: 'thinking', role: 'assistant' as const, timestamp: testDate().getTime(), content: '' };
    for (let index = 0; index < 60; index += 1) {
      await stream.handleStreamChunk({ type: 'thinking', content: '$x$ ' }, message);
      await vi.advanceTimersByTimeAsync(20);
    }
    const header = within(host).getByRole('button', { name: /Thinking/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // Streaming reads no layout; following belongs to the transcript's resize observation.
    expect(readHeight).not.toHaveBeenCalled();
    await stream.finalizeCurrentThinkingBlock(message);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    expect(message).toMatchObject({ contentBlocks: [{ type: 'thinking', content: '$x$ '.repeat(60) }] });
    fireEvent.click(header);
    await vi.advanceTimersByTimeAsync(20);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, '$x$ '.repeat(60), expect.anything(), '', expect.any(Component));
    fireEvent.click(header);
    fireEvent.click(header);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    await stream.handleStreamChunk({ type: 'thinking', content: 'Next block' }, message);
    expect(within(host).getAllByRole('button', { name: /Thought|Thinking/ })).toHaveLength(2);
  } finally {
    stream.dispose();
    subagents.clear();
    state.dispose();
    vi.useRealTimers();
  }
});

it('settles an in-flight thinking render before finalizing a newly collapsed block', async () => {
  vi.useFakeTimers();
  const state = new ChatState();
  state.currentContentEl = host;
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin: await createChatFeatureHost({ app, settings: { ...settings, deferMathRenderingDuringStreaming: true } }),
    state, renderer, subagentManager: subagents, getMessagesEl: () => host, updateQueueIndicator: () => undefined,
  });
  let finish!: () => void;
  vi.mocked(MarkdownRenderer.render).mockClear().mockImplementationOnce(async (_app, markdown, target) => {
    await new Promise<void>(resolve => { finish = resolve; });
    target.textContent = markdown;
  });
  try {
    await stream.appendThinking('Reasoning $x$');
    const header = within(host).getByRole('button', { name: /Thinking/ });
    fireEvent.click(header);
    await vi.advanceTimersByTimeAsync(20);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(header.textContent).toBe('Thinking 5s...');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    let finalized = false;
    const finalization = stream.finalizeCurrentThinkingBlock().then(() => { finalized = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(finalized).toBe(false);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    finish();
    await finalization;
    expect(header.textContent).toBe('Thought for 5s');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(header.textContent).toBe('Thought for 5s');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Reasoning $x$');
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(2);
  } finally {
    stream.dispose();
    subagents.clear();
    state.dispose();
    vi.useRealTimers();
  }
});

it.each([
  [false, 'Use <meta_name>.', 'Use &lt;meta_name&gt;.'],
  [false, String.raw`Math \(a<b, c>d\) and <placeholder>.`, 'Math $a<b, c>d$ and &lt;placeholder&gt;.'],
  [true, String.raw`Math \(a<b, c>d\) and <placeholder>.`, String.raw`Math \$a<b, c>d\$ and &lt;placeholder&gt;.`],
  [false, String.raw`Math \[a<b, c>d\] and <placeholder>.`, 'Math $$a<b, c>d$$ and &lt;placeholder&gt;.'],
  [true, String.raw`Math \[a<b, c>d\] and <placeholder>.`, String.raw`Math \$\$a<b, c>d\$\$ and &lt;placeholder&gt;.`],
  [false, '\\[\na<b,\nc>d\n\\]', '$$\na<b,\nc>d\n$$'],
  [true, '\\[\na<b,\nc>d\n\\]', '\\$\\$\na<b,\nc>d\n\\$\\$'],
  [false, 'Inline \\(x<y\\).\n\\[y^2\\]\n`echo $PATH`', 'Inline $x<y$.\n$$y^2$$\n`echo $PATH`'],
  [true, 'Inline \\(x<y\\).\n\\[y^2\\]\n`echo $PATH`', 'Inline \\$x<y\\$.\n\\$\\$y^2\\$\\$\n`echo $PATH`'],
  [false, 'Padded \\(  x + y  \\).', 'Padded $x + y$.'],
  [true, 'Padded \\(  x + y  \\).', 'Padded \\$x + y\\$.'],
])('normalizes math before rendering and defers it only when requested (%s)', async (deferMath, markdown, expected) => {
  await renderer.renderContent(host, markdown, { deferMath });

  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, expected, host, '', expect.any(Component));
});

it.each([false, true])('preserves reference-link definitions through the Markdown pipeline (deferMath=%s)', async deferMath => {
  const markdown = [
    '[Price][cost] and \\(visible\\).',
    '',
    '[cost]: https://host/$price "Cost $5"',
    '[next]:',
    '  <https://host/$next>',
    '  "Price $8"',
  ].join('\n');
  const expected = markdown.replace('\\(visible\\)', deferMath ? '\\$visible\\$' : '$visible$');

  await renderer.renderContent(host, markdown, { deferMath });

  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, expected, host, '', expect.any(Component));
});

it('escapes authored HTML before injecting trusted images and then activates remaining wikilinks', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(renderObsidianHTML);
  settings.mediaFolder = 'Media';
  await renderer.renderContent(host, 'Use <meta-name> ![[photo.png]] [[note.md|Note]]');

  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(
    app,
    expect.stringContaining('Use &lt;meta-name&gt; '),
    host,
    '',
    expect.any(Component),
  );
  expect(host.querySelector('meta-name')).toBeNull();
  expect(host.textContent).toContain('Use <meta-name>');
  expect(within(host).getByRole('img', { name: 'photo' }).getAttribute('src')).toBe('app://local/Media/photo.png');
  expect(within(host).getByRole('link', { name: 'Note' }).getAttribute('data-href')).toBe('note.md');
});

it('opens an image embedded in a reply in the zoomable preview from a native button', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(renderObsidianHTML);
  settings.mediaFolder = 'Media';
  await renderer.renderContent(host, 'Diagram: ![[photo.png]]');

  const trigger = within(host).getByRole('button', { name: 'Preview photo' });
  expect(trigger.getAttribute('type')).toBe('button');
  expect(within(trigger).getByRole('img', { name: 'photo' }).getAttribute('src')).toBe('app://local/Media/photo.png');
  expect(await axe(host)).toHaveNoViolations();
  trigger.focus();
  fireEvent.click(within(trigger).getByRole('img', { name: 'photo' }));

  const dialog = within(document.body).getByRole('dialog', { name: 'Image preview: photo' });
  expect(within(dialog).getByRole('img', { name: 'photo' }).getAttribute('src')).toBe('app://local/Media/photo.png');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }));
  expect(within(document.body).queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('opens standard Markdown images, including embeds Obsidian loads after rendering', async () => {
  // Obsidian's output for `![diagram](fixture.png) and ![chart](https://example.org/chart.png)`:
  // the external image renders at once, and the vault embed receives its image when it loads.
  vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(async (_app, _markdown, el) => {
    el.innerHTML = '<p><span class="internal-embed" src="fixture.png" alt="diagram"></span>'
      + ' and <img alt="chart" src="https://example.org/chart.png"></p>';
  });
  await renderer.renderContent(host, '![diagram](fixture.png) and ![chart](https://example.org/chart.png)');

  fireEvent.click(within(host).getByRole('button', { name: 'Preview chart' }));
  expect(within(within(document.body).getByRole('dialog', { name: 'Image preview: chart' }))
    .getByRole('img', { name: 'chart' }).getAttribute('src')).toBe('https://example.org/chart.png');
  fireEvent.click(within(document.body).getByRole('button', { name: 'Close image preview' }));

  host.querySelector('.internal-embed')!.createEl('img', { attr: { alt: 'diagram', src: 'app://local/fixture.png' } });
  const trigger = await waitFor(() => within(host).getByRole('button', { name: 'Preview diagram' }));
  fireEvent.click(trigger);
  expect(within(within(document.body).getByRole('dialog', { name: 'Image preview: diagram' }))
    .getByRole('img', { name: 'diagram' }).getAttribute('src')).toBe('app://local/fixture.png');
  expect(await axe(host)).toHaveNoViolations();
});

it('leaves an embedded image inside an authored link to the link', async () => {
  // Obsidian renders `[![[photo.png]]](https://example.org)` as a link around the injected image.
  vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(async (_app, markdown, el) => {
    el.innerHTML = `<a href="https://example.org/">${markdown}</a>`;
  });
  settings.mediaFolder = 'Media';
  await renderer.renderContent(host, '![[photo.png]]');

  const link = within(host).getByRole('link');
  expect(within(link).getByRole('img', { name: 'photo' })).toBeDefined();
  expect(within(host).queryByRole('button')).toBeNull();
  fireEvent.click(within(link).getByRole('img', { name: 'photo' }));
  expect(within(document.body).queryByRole('dialog')).toBeNull();
});

it('skips the file-link DOM pass for content without wikilinks', async () => {
  const processLinks = vi.spyOn(fileLinks, 'processFileLinks');
  await renderer.renderContent(host, 'Plain text without links');

  expect(host.textContent).toBe('Plain text without links');
  expect(processLinks).not.toHaveBeenCalled();
});

it('replaces earlier content before Obsidian renders the new Markdown', async () => {
  host.createDiv({ text: 'previous render' });
  let contentWhenRendering: string | undefined;
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, target) => {
    contentWhenRendering = target.textContent ?? undefined;
  });

  await renderer.renderContent(host, 'new content');

  expect(contentWhenRendering).toBe('');
  expect(host.textContent).toBe('');
});

it('shows a render error instead of stale content when Obsidian rejects', async () => {
  host.createDiv({ text: 'previous render' });
  vi.mocked(MarkdownRenderer.render).mockRejectedValueOnce(new Error('Render failed'));

  await expect(renderer.renderContent(host, '**broken markdown**')).resolves.toBeUndefined();

  expect(host.children).toHaveLength(1);
  expect(host.firstElementChild?.classList.contains('claudian-render-error')).toBe(true);
  expect(host.textContent).toBe('Failed to render message content.');
});

it('renders again after a failed render', async () => {
  vi.mocked(MarkdownRenderer.render).mockRejectedValueOnce(new Error('Render failed'));
  await renderer.renderContent(host, 'broken');

  await renderer.renderContent(host, 'recovered');

  expect(host.textContent).toBe('recovered');
});

it.each([
  [false, '<https://en.wikipedia.org/wiki/Foo_(bar)>'],
  [true, '<https://en.wikipedia.org/wiki/Foo_(bar)>'],
  [false, '<https://[2001:db8::1]/guide>'],
  [true, '<https://[2001:db8::1]/guide>'],
] as const)('retains valid angle autolinks through the Markdown pipeline (deferMath=%s, %s)', async (deferMath, link) => {
  await renderer.renderContent(host, `${link} and $visible$ <meta-name>`, { deferMath });

  const visible = deferMath ? '\\$visible\\$' : '$visible$';
  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app,
    `${link} and ${visible} &lt;meta-name&gt;`, host, '', expect.any(Component));
});

describe.each([false, true])('complete multiline link boundaries with deferMath=%s', deferMath => {
  it.each([
    '[Price](\nhttps://host/$price\n)',
    '[Price](https://host/$price\n  "Price $10")',
    '[Price](<https://host/$price>\n  "Price $10 with <meta-name>")',
  ])('preserves the destination and title while transforming visible prose: %s', async link => {
    await renderer.renderContent(host, `${link} and $visible$ <placeholder>`, { deferMath });

    const visible = deferMath ? '\\$visible\\$' : '$visible$';
    expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app,
      `${link} and ${visible} &lt;placeholder&gt;`, host, '', expect.any(Component));
  });
});

it.each([false, true])('coalesces expanded thinking and finalizes math before the next text block (rendered: %s)', async rendered => {
  vi.useFakeTimers();
  const state = new ChatState();
  state.currentContentEl = host;
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin: await createChatFeatureHost({ app, settings: { ...settings, deferMathRenderingDuringStreaming: true } }),
    state, renderer, subagentManager: subagents, getMessagesEl: () => host, updateQueueIndicator: () => undefined,
  });
  vi.mocked(MarkdownRenderer.render).mockClear();
  try {
    const message = { id: 'thinking', role: 'assistant' as const, timestamp: testDate().getTime(), content: '' };
    await stream.handleStreamChunk({ type: 'thinking', content: 'Reasoning ' }, message);
    await vi.advanceTimersByTimeAsync(500);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    const header = within(host).getByRole('button', { name: /Thinking/ });
    fireEvent.click(header);
    await stream.handleStreamChunk({ type: 'thinking', content: '$x$' }, message);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    if (rendered) await vi.advanceTimersByTimeAsync(20);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls.map(call => call[1])).toEqual(rendered ? ['Reasoning \\$x\\$'] : []);
    await stream.handleStreamChunk({ type: 'text', content: 'Answer' }, message);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls.map(call => call[1]))
      .toEqual(rendered ? ['Reasoning \\$x\\$', 'Reasoning $x$'] : ['Reasoning $x$']);
    expect(message).toMatchObject({ contentBlocks: [{ type: 'thinking', content: 'Reasoning $x$', durationSeconds: 0 }] });
    expect(state.currentThinkingState).toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(within(host).getByText('Reasoning $x$')).toBeDefined();
  } finally {
    stream.dispose();
    subagents.clear();
    state.dispose();
    vi.useRealTimers();
  }
});
