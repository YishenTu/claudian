/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { type App, Platform, TFile, TFolder } from 'obsidian';

import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';
import { isComposerPathAvailable } from '@/features/chat/composer/OpenComposerPath';
import { sendTabInputMessageFromExplicitEnterShortcut } from '@/features/chat/tabs/TabInputEvents';
import { ImageContextManager } from '@/features/chat/ui/ImageContext';
import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';

beforeEach(() => {
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
  HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
  HTMLElement.prototype.toggleClass = function (name, enabled) { for (const cls of Array.isArray(name) ? name : [name]) this.classList.toggle(cls, enabled); };
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

it('edits selected mentions as inline chips while retaining plain text, undo, and draft restoration', async () => {
  const parent = document.body.createDiv();
  let available = true;
  const editor = new ComposerEditor(parent, { isFileAvailable: () => available });
  const input = editor.element;
  input.value = 'Compare @A with B';
  input.focus();
  input.replaceText!(8, 10, '@Notes/A.md ', 'Notes/A.md');
  expect(input.value).toBe('Compare @Notes/A.md  with B');
  const mentions = input.getFileMentions!();
  expect(mentions).toEqual([{ from: 8, to: 19, path: 'Notes/A.md' }]);
  const chip = within(parent).getByRole('button', { name: 'Remove Notes/A.md' });
  expect(chip.getAttribute('type')).toBe('button');
  expect((await axe(chip.parentElement!)).violations).toEqual([]);
  available = false;
  editor.refreshMentions();
  expect(within(parent).getByText('A · Missing')).toBeTruthy();
  fireEvent.click(within(parent).getByRole('button', { name: 'Remove Notes/A.md' }));
  expect(input.value).toBe('Compare   with B');
  fireEvent.keyDown(parent.querySelector('[contenteditable]')!, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(input.value).toBe('Compare @Notes/A.md  with B');
  expect(input.getFileMentions!()).toEqual(mentions);
  const draft = input.value;
  input.value = '';
  expect(input.getFileMentions!()).toEqual([]);
  input.value = draft;
  input.setFileMentions!(mentions);
  expect(within(parent).getByRole('button', { name: 'Remove Notes/A.md' })).toBeTruthy();
  editor.destroy();
  parent.remove();
});

it('exposes missing-file feedback in the chip action name and keeps it removable', async () => {
  const parent = document.body.createDiv();
  let available = true;
  const onOpenFile = jest.fn();
  const editor = new ComposerEditor(parent, { isFileAvailable: () => available, onOpenFile });
  try {
    editor.element.focus();
    editor.element.replaceText!(0, 0, '@Notes/A.md ', 'Notes/A.md');
    available = false;
    editor.refreshMentions();
    const open = within(parent).getByRole('button', { name: 'Open Notes/A.md (Missing)' });
    expect((await axe(open.parentElement!)).violations).toEqual([]);
    fireEvent.click(open);
    expect(onOpenFile).toHaveBeenCalledWith('Notes/A.md');
    expect(editor.element.value).toBe('@Notes/A.md ');
    fireEvent.click(within(parent).getByRole('button', { name: 'Remove Notes/A.md' }));
    expect(editor.element.value).toBe(' ');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('copies paths as text and supports atomic keyboard deletion, undo, redo, and plain-text paste', () => {
  const parent = document.body.createDiv();
  const editor = new ComposerEditor(parent);
  const input = editor.element;
  input.focus();
  input.replaceText!(0, 0, '@A.md ', 'A.md');
  const content = parent.querySelector('[contenteditable]')!;
  input.selectionStart = 0;
  input.selectionEnd = 5;
  const clipboardData = { clearData: jest.fn(), setData: jest.fn(), getData: () => '@B.md', files: [] };
  fireEvent.copy(content, { clipboardData });
  expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '@A.md');
  input.selectionStart = 5;
  input.selectionEnd = 5;
  fireEvent.keyDown(content, { key: 'Backspace', code: 'Backspace' });
  expect(input.value).toBe(' ');
  fireEvent.keyDown(content, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(input.getFileMentions!()).toEqual([{ from: 0, to: 5, path: 'A.md' }]);
  fireEvent.keyDown(content, { key: 'y', code: 'KeyY', ctrlKey: true });
  expect(input.value).toBe(' ');
  input.value = '';
  fireEvent.paste(content, { clipboardData });
  expect(input.value).toBe('@B.md');
  expect(input.getFileMentions!()).toEqual([]);
  input.value = '';
  fireEvent.keyDown(content, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(input.value).toBe('');
  editor.destroy();
  parent.remove();
});

it('keeps a restored draft separate from the previous draft undo history', () => {
  const parent = document.body.createDiv();
  const editor = new ComposerEditor(parent, { onOpenFile: jest.fn() });
  const input = editor.element;
  try {
    input.focus();
    input.replaceText!(0, 0, '@A.md ', 'A.md');
    const content = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(content, { key: 'Backspace', code: 'Backspace' });
    expect(input.value).toBe('@A.md');

    input.value = '@B.md';
    input.setFileMentions!([{ from: 0, to: 5, path: 'B.md' }]);
    fireEvent.keyDown(content, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(input.value).toBe('@B.md');
    expect(input.getFileMentions!()).toEqual([{ from: 0, to: 5, path: 'B.md' }]);
    expect(within(parent).getByRole('button', { name: 'Open B.md' })).toBeTruthy();
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it.each([false, true])('inserts a plain newline without rewriting draft whitespace (shift=%s)', shiftKey => {
  const parent = document.body.createDiv();
  const editor = new ComposerEditor(parent);
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
  const editor = new ComposerEditor(parent);
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
  const editor = new ComposerEditor(parent);
  editor.element.focus();
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  const tab = { dom: { inputEl: editor.element }, controllers: { inputController: { sendMessage } } };
  const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !Platform.isMacOS, metaKey: Platform.isMacOS, cancelable: true });
  expect(sendTabInputMessageFromExplicitEnterShortcut(tab as never, event, { requireInputFocus: true })).toBe(true);
  expect(sendMessage).toHaveBeenCalled();
  editor.destroy();
  parent.remove();
});

describe.each([
  {
    kind: 'file', path: 'Notes/A note.md', label: 'A note', option: 'Notes/A note.md',
    inputText: 'Read @A today', cursor: 7, expectedText: 'Read @Notes/A note.md today', end: 21,
  },
  {
    kind: 'folder', path: 'Journals/Pages/Travel/', label: 'Travel/', option: '@Journals/Pages/Travel/',
    inputText: 'Read @Travel today', cursor: 12, expectedText: 'Read @Journals/Pages/Travel/ today', end: 28,
  },
])('$kind completion', fixture => {
  it.each(['click', 'Enter', 'Tab'])('selects an openable, removable chip using %s', async method => {
    const parent = document.body.createDiv();
    const onOpenFile = jest.fn();
    const editor = new ComposerEditor(parent, { onOpenFile });
    const file = Object.assign(new TFile(), { path: 'Notes/A note.md', name: 'A note.md', stat: { mtime: 0 } });
    const source = new MentionSource({
      getCachedVaultFiles: () => [file],
      getCachedVaultFolders: () => [{ name: 'Travel', path: 'Journals/Pages/Travel' }],
      getExternalContexts: () => [],
      normalizePathForVault: path => path ?? null,
      onAttachFile: () => {},
    });
    const dropdown = new ComposerDropdownController(parent, editor.element, [source]);
    try {
      editor.element.value = fixture.inputText;
      editor.element.selectionStart = editor.element.selectionEnd = fixture.cursor;
      editor.element.focus();
      dropdown.handleInputChange();
      const option = await waitFor(() => within(parent).getByRole('option', { name: fixture.option }));
      if (method === 'click') fireEvent.click(option);
      else dropdown.handleKeydown(new KeyboardEvent('keydown', { key: method }));

      const open = within(parent).getByRole('button', { name: `Open ${fixture.path}` });
      expect(open.textContent).toBe(fixture.label);
      expect(open.getAttribute('type')).toBe('button');
      expect((await axe(open.parentElement!)).violations).toEqual([]);
      fireEvent.click(open);
      expect(onOpenFile).toHaveBeenCalledWith(fixture.path);
      expect(editor.element.value).toBe(fixture.expectedText);
      expect(editor.element.getFileMentions!()).toEqual([
        { from: 5, to: fixture.end, path: fixture.path },
      ]);
      onOpenFile.mockClear();
      fireEvent.click(within(parent).getByRole('button', { name: `Remove ${fixture.path}` }));
      expect(editor.element.value).toBe('Read  today');
      expect(onOpenFile).not.toHaveBeenCalled();
    } finally {
      dropdown.destroy();
      source.destroy();
      editor.destroy();
      parent.remove();
    }
  });
});

it.each(['Journals/Pages/Travel/', 'Journals/Pages/Travel plan.md'])(
  'ends matching after selecting %s and allows a new mention after the chip',
  async path => {
    const parent = document.body.createDiv();
    const editor = new ComposerEditor(parent);
    const file = Object.assign(new TFile(), {
      path: 'Journals/Pages/Travel plan.md', name: 'Travel plan.md', stat: { mtime: 0 },
    });
    const source = new MentionSource({
      getCachedVaultFiles: () => [file],
      getCachedVaultFolders: () => [{ name: 'Travel', path: 'Journals/Pages/Travel' }],
      getExternalContexts: () => [],
      normalizePathForVault: value => value ?? null,
      onAttachFile: () => {},
    });
    const input = editor.element;
    const dropdown = new ComposerDropdownController(parent, input, [source]);
    input.addEventListener('input', () => dropdown.handleInputChange());
    try {
      input.value = '@Travel';
      input.focus();
      fireEvent.input(input);
      const optionName = path.endsWith('/') ? `@${path}` : path;
      fireEvent.click(await waitFor(() => within(parent).getByRole('option', { name: optionName })));
      expect(within(parent).getByRole('button', { name: `Remove ${path}` })).toBeTruthy();
      expect(dropdown.isVisible()).toBe(false);

      // An input notification after completion must not restart its finished search.
      fireEvent.input(input);
      expect(dropdown.isVisible()).toBe(false);

      const content = within(parent).getByRole('textbox', { name: 'Message' });
      fireEvent.paste(content, { clipboardData: { getData: () => 'Plan a trip ', files: [] } });
      await Promise.resolve();
      expect(input.value).toBe(`@${path} Plan a trip `);
      expect(dropdown.isVisible()).toBe(false);
      expect(input.getAttribute('aria-expanded')).toBe('false');

      fireEvent.paste(content, { clipboardData: { getData: () => '@Travel', files: [] } });
      await Promise.resolve();
      fireEvent.click(await waitFor(() => within(parent).getByRole('option', { name: '@Journals/Pages/Travel/' })));
      expect(input.value).toBe(`@${path} Plan a trip @Journals/Pages/Travel/ `);
      expect(input.getFileMentions!()).toHaveLength(2);
      expect(dropdown.isVisible()).toBe(false);
    } finally {
      dropdown.destroy();
      source.destroy();
      editor.destroy();
      parent.remove();
    }
  },
);

it('keeps folder identity and missing feedback through removal, undo, and draft restoration', () => {
  const parent = document.body.createDiv();
  const folder = Object.assign(new TFolder(), { path: 'Journals/Travel.md' });
  let target: TFolder | TFile | null = folder;
  const app = {
    vault: { getAbstractFileByPath: (path: string) => path === 'Journals/Travel.md' ? target : null },
  } as unknown as App;
  const editor = new ComposerEditor(parent, {
    isFileAvailable: path => isComposerPathAvailable(app, path),
    onOpenFile: () => {},
  });
  const input = editor.element;
  try {
    input.focus();
    input.replaceText!(0, 0, '@Journals/Travel.md/ ', 'Journals/Travel.md/');
    expect(within(parent).getByRole('button', { name: 'Open Journals/Travel.md/' }).textContent).toBe('Travel.md/');
    input.selectionStart = 0;
    input.selectionEnd = 20;
    const clipboardData = { clearData: jest.fn(), setData: jest.fn() };
    fireEvent.copy(within(parent).getByRole('textbox', { name: 'Message' }), { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '@Journals/Travel.md/');
    target = null;
    editor.refreshMentions();
    expect(within(parent).getByRole('button', { name: 'Open Journals/Travel.md/ (Missing)' }).textContent).toBe('Travel.md/ · Missing');
    fireEvent.click(within(parent).getByRole('button', { name: 'Remove Journals/Travel.md/' }));
    expect(input.value).toBe(' ');
    fireEvent.keyDown(within(parent).getByRole('textbox', { name: 'Message' }), {
      key: 'z', code: 'KeyZ', ctrlKey: true,
    });
    expect(input.value).toBe('@Journals/Travel.md/ ');
    const mentions = input.getFileMentions!();
    expect(mentions).toEqual([{ from: 0, to: 20, path: 'Journals/Travel.md/' }]);
    input.value = '';
    input.value = '@Journals/Travel.md/ ';
    input.setFileMentions!(mentions);
    expect(within(parent).getByRole('button', { name: 'Open Journals/Travel.md/ (Missing)' })).toBeTruthy();

    target = new TFile();
    editor.refreshMentions();
    expect(within(parent).getByRole('button', { name: 'Open Journals/Travel.md/ (Missing)' })).toBeTruthy();
    target = folder;
    editor.refreshMentions();
    expect(within(parent).getByRole('button', { name: 'Open Journals/Travel.md/' }).textContent).toBe('Travel.md/');
  } finally {
    editor.destroy();
    parent.remove();
  }
});

it('lets image attachment handling consume image paste before the rich editor inserts fallback text', () => {
  const parent = document.body.createDiv({ cls: 'claudian-input-wrapper' });
  const editor = new ComposerEditor(parent);
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
