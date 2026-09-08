/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { type App, type Component, MarkdownRenderer, Platform, TFile } from 'obsidian';

import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';
import { CanvasSelectionController } from '@/features/chat/controllers/CanvasSelectionController';
import { sendTabInputMessageFromExplicitEnterShortcut } from '@/features/chat/tabs/TabInputEvents';
import { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';
import { FileContextManager } from '@/features/chat/ui/FileContext';
import { ImageContextManager } from '@/features/chat/ui/ImageContext';
import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';

const nativeLinks: Record<string, { target: string; label: string }> = {
  '[[Notes/A note.md]]': { target: 'Notes/A note.md', label: 'A note' },
  '[[Notes/A note.md|A note]]': { target: 'Notes/A note.md', label: 'A note' },
  '[[Notes/B.md]]': { target: 'Notes/B.md', label: 'B' },
  '[[Notes/A note.md#Heading|My alias]]': { target: 'Notes/A note.md#Heading', label: 'My alias' },
  '[[DEMO.md|DEMO]]': { target: 'DEMO.md', label: 'DEMO' },
  '[[- Bases/DEMO.md|DEMO]]': { target: '- Bases/DEMO.md', label: 'DEMO' },
};

function createApp(): App {
  const file = Object.assign(new TFile(), {
    path: 'Notes/A note.md', name: 'A note.md', basename: 'A note', stat: { mtime: 0 },
  });
  return {
    metadataCache: { getFirstLinkpathDest: () => file },
    vault: {
      getFiles: () => [file], getAllLoadedFiles: () => [file],
      getAbstractFileByPath: () => file, on: jest.fn(), offref: jest.fn(),
    },
    workspace: { iterateAllLeaves: jest.fn(), openLinkText: jest.fn().mockResolvedValue(undefined) },
  } as unknown as App;
}

function createEditor(parent: HTMLElement): ComposerEditor {
  return new ComposerEditor(parent, createApp(), {} as Component);
}

beforeEach(() => {
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
  HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
  HTMLElement.prototype.toggleClass = function (name, enabled) { for (const cls of Array.isArray(name) ? name : [name]) this.classList.toggle(cls, enabled); };
  HTMLElement.prototype.scrollIntoView = jest.fn();
  jest.mocked(MarkdownRenderer.render).mockReset().mockImplementation(async (_app, markdown, container) => {
    const fixture = nativeLinks[markdown];
    if (!fixture) throw new Error(`No native rendering fixture for ${markdown}`);
    (container as HTMLElement).createEl('p').createEl('a', {
      cls: 'internal-link', text: fixture.label, attr: { href: fixture.target, 'data-href': fixture.target },
    });
  });
});

it('renders a wikilink through Obsidian and opens it without changing the source text', async () => {
  const parent = document.body.createDiv();
  const openLinkText = jest.fn().mockResolvedValue(undefined);
  const app = createApp();
  app.workspace.openLinkText = openLinkText;
  const component = {} as Component;
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, markdown, container) => {
    expect(markdown).toBe('[[Notes/A note.md]]');
    (container as HTMLElement).createEl('a', {
      cls: 'internal-link', text: 'A note', attr: { href: 'Notes/A note.md', 'data-href': 'Notes/A note.md' },
    });
  });
  const editor = new ComposerEditor(parent, app, component);
  try {
    editor.element.value = 'Read [[Notes/A note.md]] today';
    editor.element.focus();
    const link = await waitFor(() => within(parent).getByRole('link', { name: 'A note' }));
    expect((await axe(link.parentElement!)).violations).toEqual([]);
    fireEvent.click(link);
    expect(openLinkText).toHaveBeenCalledWith('Notes/A note.md', '', 'tab');
    expect(editor.element.value).toBe('Read [[Notes/A note.md]] today');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it.each(['click', 'Enter', 'Tab'])('inserts and renders a picker wikilink using %s', async method => {
  const parent = document.body.createDiv();
  const app = createApp();
  const editor = new ComposerEditor(parent, app, {} as Component);
  const files = new FileContextManager(app);
  const dropdown = new ComposerDropdownController(parent, editor.element, [files.getMentionSource()]);
  try {
    editor.element.value = 'Read @A today';
    editor.element.selectionStart = editor.element.selectionEnd = 7;
    editor.element.focus();
    dropdown.handleInputChange();
    const option = await waitFor(() => within(parent).getByRole('option', { name: 'Notes/A note.md' }));
    if (method === 'click') fireEvent.click(option);
    else dropdown.handleKeydown(new KeyboardEvent('keydown', { key: method }));
    const link = await waitFor(() => within(parent).getByRole('link', { name: 'A note' }));
    fireEvent.click(link);
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('Notes/A note.md', '', 'tab');
    expect(editor.element.value).toBe('Read [[Notes/A note.md|A note]] today');
    dropdown.handleInputChange();
    expect(dropdown.isVisible()).toBe(false);
  } finally {
    dropdown.destroy();
    files.destroy();
    editor.destroy();
    parent.remove();
  }
});

it('renders identical labels while keeping each aliased link target distinct', async () => {
  const parent = document.body.createDiv();
  const app = createApp();
  const editor = new ComposerEditor(parent, app, {} as Component);
  try {
    const source = 'Compare [[DEMO.md|DEMO]] and [[- Bases/DEMO.md|DEMO]]';
    editor.element.value = source;
    editor.element.focus();
    const links = await waitFor(() => {
      const matches = within(parent).getAllByRole('link', { name: 'DEMO' });
      expect(matches).toHaveLength(2);
      return matches;
    });
    fireEvent.click(links[0]);
    fireEvent.click(links[1]);
    expect(app.workspace.openLinkText).toHaveBeenNthCalledWith(1, 'DEMO.md', '', 'tab');
    expect(app.workspace.openLinkText).toHaveBeenNthCalledWith(2, '- Bases/DEMO.md', '', 'tab');
    expect(editor.element.value).toBe(source);
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('reveals wikilink syntax when the caret enters it and renders the edited target on leaving', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const input = editor.element;
    input.value = '[[Notes/B.md]] ';
    input.focus();
    await waitFor(() => within(parent).getByRole('link', { name: 'B' }));
    input.selectionStart = input.selectionEnd = 14;
    const content = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(content, { key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(content.textContent).toBe('[[Notes/B.md]] ');
    input.selectionStart = 8;
    input.selectionEnd = 9;
    fireEvent.paste(content, { clipboardData: { getData: () => 'A note', files: [] } });
    input.selectionStart = input.selectionEnd = input.value.length;
    await waitFor(() => within(parent).getByRole('link', { name: 'A note' }));
    expect(input.value).toBe('[[Notes/A note.md]] ');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('copies wikilink source and reconstructs links through paste, undo, redo, and draft restoration', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const input = editor.element;
    input.focus();
    const content = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.paste(content, { clipboardData: { getData: () => '[[Notes/A note.md#Heading|My alias]]', files: [] } });
    await waitFor(() => within(parent).getByRole('link', { name: 'My alias' }));
    const draft = input.value;
    input.selectionStart = 0;
    input.selectionEnd = draft.length;
    const clipboardData = { clearData: jest.fn(), setData: jest.fn() };
    fireEvent.copy(content, { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '[[Notes/A note.md#Heading|My alias]]');
    fireEvent.keyDown(content, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(input.value).toBe('');
    fireEvent.keyDown(content, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(input.value).toBe(draft);
    await waitFor(() => within(parent).getByRole('link', { name: 'My alias' }));
    input.value = '';
    input.value = draft;
    await waitFor(() => within(parent).getByRole('link', { name: 'My alias' }));
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('keeps wikilink examples in code and embeds as editable source', () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const source = '`[[Notes/B.md]]`\n\n```md\n[[Notes/B.md]]\n```\n\n![[Notes/B.md]]';
    editor.element.value = source;
    editor.element.focus();
    expect(within(parent).getByRole('textbox', { name: 'Message' }).textContent).toContain('`[[Notes/B.md]]`');
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('refreshes native link resolution after vault changes', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    editor.element.value = '[[Notes/B.md]]';
    editor.element.focus();
    await waitFor(() => within(parent).getByRole('link', { name: 'B' }));
    jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, container) => {
      (container as HTMLElement).createEl('a', {
        cls: 'internal-link is-unresolved', text: 'B', attr: { href: 'Notes/B.md' },
      });
    });
    editor.refreshLinks();
    await waitFor(() => expect(within(parent).getByRole('link', { name: 'B' }).classList.contains('is-unresolved')).toBe(true));
    expect(editor.element.value).toBe('[[Notes/B.md]]');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it.each([false, true])('inserts a plain newline without rewriting draft whitespace (shift=%s)', shiftKey => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    editor.element.value = '  Keep these spaces  ';
    editor.element.focus();
    fireEvent.keyDown(within(parent).getByRole('textbox', { name: 'Message' }), {
      key: 'Enter', code: 'Enter', shiftKey,
    });
    expect(editor.element.value).toBe('  Keep these spaces  \n');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('allows input listeners to update composer modes and forwards dropdown accessibility to the focused textbox', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const input = editor.element;
  input.focus();
  input.value = 'x';
  input.addEventListener('input', () => { input.placeholder = 'Save instructions'; });
  const content = within(parent).getByRole('textbox', { name: 'Message' });
  fireEvent.keyDown(content, { key: 'Backspace', code: 'Backspace' });
  await Promise.resolve();
  expect(within(parent).getByText('Save instructions')).toBeTruthy();
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-activedescendant', 'option-1');
  await Promise.resolve();
  expect(content.getAttribute('aria-autocomplete')).toBe('list');
  expect(content.getAttribute('aria-activedescendant')).toBe('option-1');
  editor.destroy();
  parent.remove();
});

it('keeps the explicit send shortcut focused inside the editor', () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  editor.element.focus();
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  const tab = { dom: { inputEl: editor.element }, controllers: { inputController: { sendMessage } } };
  const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !Platform.isMacOS, metaKey: Platform.isMacOS, cancelable: true });
  expect(sendTabInputMessageFromExplicitEnterShortcut(tab as never, event, { requireInputFocus: true })).toBe(true);
  expect(sendMessage).toHaveBeenCalled();
  editor.destroy();
  parent.remove();
});

it('lets image attachment handling consume image paste before the rich editor inserts fallback text', () => {
  const parent = document.body.createDiv({ cls: 'claudian-input-wrapper' });
  const editor = createEditor(parent);
  const images = new ImageContextManager(parent, editor.element, {});
  editor.element.value = 'Keep this';
  editor.element.focus();
  const clipboardData = {
    items: [{ type: 'image/png', getAsFile: () => null }], files: [], getData: () => 'image fallback',
  };
  fireEvent.paste(within(parent).getByRole('textbox', { name: 'Message' }), { clipboardData });
  expect(editor.element.value).toBe('Keep this');
  images.destroy();
  editor.destroy();
  parent.remove();
});

it('focuses an already open note when its composer link is clicked', async () => {
  const parent = document.body.createDiv();
  const app = createApp();
  const leaf = {
    getViewState: () => ({ type: 'markdown', state: { file: 'Notes/A note.md' } }),
    setEphemeralState: jest.fn(),
  };
  jest.mocked(app.workspace.iterateAllLeaves).mockImplementation(visit => visit(leaf as never));
  app.workspace.revealLeaf = jest.fn().mockResolvedValue(undefined);
  const editor = new ComposerEditor(parent, app, {} as Component);
  try {
    editor.element.value = 'Read [[Notes/A note.md|A note]] today';
    editor.element.focus();
    const link = await waitFor(() => within(parent).getByRole('link', { name: 'A note' }));
    fireEvent.click(link);
    await waitFor(() => expect(leaf.setEphemeralState).toHaveBeenCalledWith({ focus: true }));
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
    expect(editor.element.value).toBe('Read [[Notes/A note.md|A note]] today');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('deletes a whole wikilink with Backspace after its trailing space and supports undo', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const input = editor.element;
    input.value = 'Read [[Notes/A note.md|A note]] ';
    input.focus();
    const content = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(content, { key: 'Backspace', code: 'Backspace' });
    expect(input.value).toBe('Read [[Notes/A note.md|A note]]');
    fireEvent.keyDown(content, { key: 'Backspace', code: 'Backspace' });
    expect(input.value).toBe('Read ');
    expect(input.selectionStart).toBe(5);
    fireEvent.keyDown(content, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(input.value).toContain('[[Notes/A note.md|A note]]');
    await waitFor(() => within(parent).getByRole('link', { name: 'A note' }));
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it.each([
  ['[[Notes/B.md', ']]', '[[Notes/B.m]]'],
  ['`[[Notes/B.md]]', '`', '`[[Notes/B.md]`'],
  ['![[Notes/B.md]]', '', '![[Notes/B.md]'],
])('keeps ordinary Backspace editing after %s', (before, after, expected) => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const input = editor.element;
    input.value = before + after;
    input.focus();
    input.selectionStart = input.selectionEnd = before.length;
    fireEvent.keyDown(within(parent).getByRole('textbox', { name: 'Message' }), {
      key: 'Backspace', code: 'Backspace',
    });
    expect(input.value).toBe(expected);
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('retains Canvas selection while typing into the composer', () => {
  jest.useFakeTimers();
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const canvas = { selection: new Set([{ id: 'node-1' }]) };
  const view = { getViewType: () => 'canvas', canvas, file: { path: 'Board.canvas' } };
  const app = { workspace: { getMostRecentLeaf: () => ({ view }), getLeavesOfType: () => [{ view }] } };
  const tray = new ComposerContextTray(parent.createDiv());
  const controller = new CanvasSelectionController(app as never, tray, editor.element);
  try {
    controller.start();
    jest.advanceTimersByTime(250);
    expect(controller.getContext()).toEqual({ canvasPath: 'Board.canvas', nodeIds: ['node-1'] });
    editor.element.focus();
    expect(editor.element.contains(document.activeElement)).toBe(true);
    canvas.selection.clear();
    jest.advanceTimersByTime(250);
    expect(controller.getContext()).toEqual({ canvasPath: 'Board.canvas', nodeIds: ['node-1'] });
    const outside = parent.createEl('button', { text: 'Outside', attr: { type: 'button' } });
    outside.focus();
    jest.advanceTimersByTime(250);
    expect(controller.getContext()).toBeNull();
  } finally {
    controller.stop();
    tray.destroy();
    editor.destroy();
    parent.remove();
    jest.useRealTimers();
  }
});
