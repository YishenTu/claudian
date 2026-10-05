/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { type App, Component, MarkdownRenderer, type TFile } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import * as fileLinks from '@/utils/fileLink';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

let renderer: MessageRenderer;
let host: HTMLElement;
let app: App;
let settings: { mediaFolder: string };

beforeEach(() => {
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
  } as unknown as App;
  settings = { mediaFolder: '' };
  renderer = new MessageRenderer({ app, settings } as never, new Component(), host);
  // Obsidian is the external rendering boundary; all plugin transformations stay real.
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    target.innerHTML = markdown;
  });
});

afterEach(() => {
  renderer.dispose();
  host.remove();
  jest.restoreAllMocks();
});

it.each([
  [false, 'Inline $x<y$.\n$$y^2$$\n`echo $PATH`'],
  [true, 'Inline \\$x<y\\$.\n\\$\\$y^2\\$\\$\n`echo $PATH`'],
])('normalizes math before rendering and defers it only when requested (%s)', async (deferMath, expected) => {
  await renderer.renderContent(host, 'Inline \\(x<y\\).\n\\[y^2\\]\n`echo $PATH`', { deferMath });

  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, expected, host, '', expect.any(Component));
});

it('escapes authored HTML before injecting trusted images and then activates remaining wikilinks', async () => {
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

it('skips the file-link DOM pass for content without wikilinks', async () => {
  const processLinks = jest.spyOn(fileLinks, 'processFileLinks');
  await renderer.renderContent(host, 'Plain text without links');

  expect(host.textContent).toBe('Plain text without links');
  expect(processLinks).not.toHaveBeenCalled();
});

it('replaces earlier content before Obsidian renders the new Markdown', async () => {
  host.createDiv({ text: 'previous render' });
  let contentWhenRendering: string | undefined;
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, target) => {
    contentWhenRendering = target.textContent ?? undefined;
  });

  await renderer.renderContent(host, 'new content');

  expect(contentWhenRendering).toBe('');
  expect(host.textContent).toBe('');
});

it('shows a render error instead of stale content when Obsidian rejects', async () => {
  host.createDiv({ text: 'previous render' });
  jest.mocked(MarkdownRenderer.render).mockRejectedValueOnce(new Error('Render failed'));

  await expect(renderer.renderContent(host, '**broken markdown**')).resolves.toBeUndefined();

  expect(host.children).toHaveLength(1);
  expect(host.firstElementChild?.classList.contains('claudian-render-error')).toBe(true);
  expect(host.textContent).toBe('Failed to render message content.');
});

it('renders again after a failed render', async () => {
  jest.mocked(MarkdownRenderer.render).mockRejectedValueOnce(new Error('Render failed'));
  await renderer.renderContent(host, 'broken');

  await renderer.renderContent(host, 'recovered');

  expect(host.textContent).toBe('recovered');
});
