/** @jest-environment jsdom */

import { EditorView } from '@codemirror/view';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { type App, type Component, MarkdownRenderer, Platform, TFile } from 'obsidian';

import { createCatalogCommandDiscoveryStore } from '@/core/providers/commands/catalogCommandDiscovery';
import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import type { ProviderCommandDiscoverySnapshot } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';
import { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import { ComposerPromptSuggestion } from '@/features/chat/composer/ComposerPromptSuggestion';
import { formatComposerSessionMention } from '@/features/chat/composer/composerSessionMentions';
import { FileContextManager } from '@/features/chat/composer/FileContextManager';
import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import { MainChatComposerDropdown } from '@/features/chat/composer/MainChatComposerDropdown';
import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import { LinkedContentChip } from '@/features/chat/linked-content/LinkedContentChip';
import { sendTabInputMessageFromExplicitEnterShortcut } from '@/features/chat/tabs/TabInputEvents';
import { setLocale } from '@/i18n/i18n';
import type { Locale } from '@/i18n/types';
import { CodexCommandCatalog } from '@/providers/codex/commands/CodexCommandCatalog';
import type { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';
import { ResumeSessionDropdown } from '@/shared/components/ResumeSessionDropdown';
import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

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
    path: 'Notes/A note.md', name: 'A note.md', basename: 'A note', stat: { mtime: testDate().getTime() },
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

it.each<[string, Locale, string]>([
  ['click', 'en', 'Input suggestions'],
  ['Enter', 'en', 'Input suggestions'],
  ['Tab', 'en', 'Input suggestions'],
  ['click', 'de', 'Eingabevorschl\u00e4ge'],
])('inserts and renders a picker wikilink using %s in %s', async (method, locale, menuName) => {
  setLocale(locale);
  const parent = document.body.createDiv();
  const app = createApp();
  const editor = new ComposerEditor(parent, app, {} as Component);
  const files = new FileContextManager(new VaultMentionDataProvider(app));
  const dropdown = new ComposerDropdownController(parent, editor.element, [files.getMentionSource()]);
  try {
    editor.element.value = 'Read @A today';
    editor.element.selectionStart = editor.element.selectionEnd = 7;
    dropdown.handleInputChange();
    await waitFor(() => within(parent).getByRole('option', { name: 'Notes/A note.md' }));
    expect(within(parent).getAllByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' })).toEqual([editor.element]);
    expect(within(parent).getByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' }).getAttribute('aria-multiline')).toBe('true');
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
    editor.element.focus();
    expect(within(parent).getAllByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' })).toHaveLength(1);
    expect(within(parent).getByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' }).getAttribute('aria-multiline')).toBe('true');
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
    dropdown.hide();
    dropdown.handleInputChange();
    const option = await waitFor(() => within(parent).getByRole('option', { name: 'Notes/A note.md' }));
    const listbox = within(parent).getByRole('listbox');
    expect(within(parent).getAllByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' })).toHaveLength(1);
    expect(within(parent).getByRole('textbox', { name: locale === 'de' ? 'Nachricht' : 'Message' }).getAttribute('aria-multiline')).toBe('true');
    expect(await axe(listbox)).toHaveNoViolations();
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
    expect(within(parent).getByRole('listbox', { name: menuName })).toBe(listbox);
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
    setLocale('en');
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

it('allows input listeners to update composer modes', async () => {
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
  editor.destroy();
  parent.remove();
});

it('leaves native spellcheck and text replacement enabled in the focused textbox', () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  editor.element.focus();
  const content = within(parent).getByRole('textbox', { name: 'Message' });
  expect(content.getAttribute('spellcheck')).toBe('true');
  expect(content.getAttribute('autocorrect')).toBe('on');
  editor.destroy();
  parent.remove();
});

it('reports whether the caret is on the first or last rendered row, including soft wraps', () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  editor.element.focus();
  editor.element.value = 'a'.repeat(30);
  // jsdom has no layout: render ten characters per 20px row; a wrap point belongs to the row the side faces.
  let measurable = true;
  jest.spyOn(EditorView.prototype, 'coordsAtPos').mockImplementation((pos: number, side = 1) => {
    if (!measurable) return null;
    const row = side < 0 && pos > 0 && pos % 10 === 0 ? pos / 10 - 1 : Math.floor(pos / 10);
    return { top: row * 20, bottom: row * 20 + 18, left: 0, right: 0 };
  });
  const caretOn = (pos: number) => {
    editor.element.selectionStart = editor.element.selectionEnd = pos;
    return [editor.element.isCaretOnEdgeRow!('up'), editor.element.isCaretOnEdgeRow!('down')];
  };
  expect(caretOn(5)).toEqual([true, false]);
  expect(caretOn(15)).toEqual([false, false]);
  expect(caretOn(30)).toEqual([false, true]);
  measurable = false;
  expect(caretOn(5)).toEqual([null, null]);
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
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const canvas = { selection: new Set([{ id: 'node-1' }]) };
  const view = { getViewType: () => 'canvas', canvas, file: { path: 'Board.canvas' } };
  const app = { workspace: { getMostRecentLeaf: () => ({ view }), getLeavesOfType: () => [{ view }] } };
  const tray = new ComposerContextTray(parent.createDiv());
  const controller = new CanvasSelectionController(app as never, tray, editor.element);
  try {
    controller.poll();
    expect(controller.getContext()).toEqual({ canvasPath: 'Board.canvas', nodeIds: ['node-1'] });
    editor.element.focus();
    expect(editor.element.contains(document.activeElement)).toBe(true);
    canvas.selection.clear();
    controller.poll();
    expect(controller.getContext()).toEqual({ canvasPath: 'Board.canvas', nodeIds: ['node-1'] });
    const outside = parent.createEl('button', { text: 'Outside', attr: { type: 'button' } });
    outside.focus();
    controller.poll();
    expect(controller.getContext()).toBeNull();
  } finally {
    controller.clear();
    tray.destroy();
    editor.destroy();
    parent.remove();
  }
});

it('upgrades to the editor when a focusin reaches the composer host', () => {
  const parent = document.body.createDiv();
  const outside = document.body.createDiv();
  outside.tabIndex = 0;
  const editor = createEditor(parent);
  try {
    // Chromium skips an element's `focusin` when its `focus` handler moves focus
    // elsewhere, so the lazy upgrade hangs off `focusin` instead; otherwise the
    // ancestors tracking the note-to-composer handoff never observe it.
    editor.element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: outside }));

    expect(document.activeElement).toBe(parent.querySelector('.cm-content'));
  } finally {
    editor.destroy();
    parent.remove();
    outside.remove();
  }
});

it.each([
  ['Draft ] \\ review', '@[Draft \\] \\\\ review](claudian-session:conv-1-abc)'],
  ['Fix `bug`', '@[Fix `bug`](claudian-session:conv-1-abc)'],
])('renders session title %s accessibly and deletes its token', async (title, token) => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    expect(formatComposerSessionMention(title, 'conv-1-abc')).toBe(token + ' ');
    editor.element.value = token;
    editor.element.focus();
    const chip = within(parent).getByRole('img', { name: `Session: ${title}` });
    expect(chip.textContent).toBe(title);
    expect(editor.element.value).toBe(token);
    expect((await axe(chip)).violations).toEqual([]);
    fireEvent.keyDown(within(parent).getByRole('textbox', { name: 'Message' }), { key: 'Backspace', code: 'Backspace' });
    expect(editor.element.value).toBe('');
  } finally { editor.destroy(); parent.remove(); }
});

it.each([
  '`@[Review](claudian-session:conv-1-abc)`',
  '```md\n@[Review](claudian-session:conv-1-abc)\n```',
  '    @[Review](claudian-session:conv-1-abc)',
  '\\@[Review](claudian-session:conv-1-abc)',
])('keeps literal session token editable: %s', source => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    editor.element.value = `${source}\n\n@[Visible](claudian-session:conv-2-abc)`;
    editor.element.focus();
    expect(within(parent).getByRole('img', { name: 'Session: Visible' })).toBeTruthy();
    expect(within(parent).queryByRole('img', { name: 'Session: Review' })).toBeNull();
    expect(within(parent).getByRole('textbox', { name: 'Message' }).textContent).toContain(source.replace(/\n/g, ''));
  } finally { editor.destroy(); parent.remove(); }
});

it('renders known commands and skills as chips while unknown tokens stay text', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const entry = (kind: 'command' | 'skill', name: string, prefix: string): ProviderCommandEntry => ({
    content: '', id: `codex:${kind}:${name}`, providerId: 'codex', kind, name, scope: 'runtime',
    source: 'sdk', isEditable: false, isDeletable: false, displayPrefix: prefix, insertPrefix: prefix,
  });
  const listeners = new Set<() => void>();
  let snapshot: ProviderCommandDiscoveryResult<ProviderCommandEntry> = {
    status: 'ready', items: [entry('command', 'review', '/')],
  };
  const files = new FileContextManager(new VaultMentionDataProvider(createApp()));
  const dropdown = new MainChatComposerDropdown(parent, editor.element, files, {
    providerId: 'codex',
    providerDiscovery: {
      getSnapshot: () => snapshot,
      load: async () => snapshot,
      retry: async () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  });
  try {
    editor.element.value = '/clear /review $plan /unknown /clear /review';
    editor.element.focus();
    const command = within(parent).getByRole('img', { name: 'Command: /review' });
    expect(command.textContent).toBe('/review');
    expect(within(parent).getAllByRole('img', { name: 'Command: /clear' })).toHaveLength(1);
    expect(within(parent).queryByRole('img', { name: /plan|unknown/ })).toBeNull();
    expect(within(parent).getAllByRole('img', { name: 'Command: /review' })).toHaveLength(1);
    expect((await axe(command)).violations).toEqual([]);

    snapshot = { status: 'ready', items: [entry('command', 'review', '/'), entry('skill', 'plan', '$')] };
    for (const listener of listeners) listener();
    const skill = within(parent).getByRole('img', { name: 'Skill: plan' });
    expect(skill.textContent).toBe('plan');
    expect(editor.element.value).toBe('/clear /review $plan /unknown /clear /review');

    editor.element.selectionStart = editor.element.selectionEnd = '/clear /review'.length;
    fireEvent.keyDown(within(parent).getByRole('textbox', { name: 'Message' }), { key: 'Backspace', code: 'Backspace' });
    expect(editor.element.value).toBe('/clear  $plan /unknown /clear /review');

    editor.element.value = 'Run /review ';
    const textbox = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(textbox, { key: 'Backspace', code: 'Backspace' });
    expect(editor.element.value).toBe('Run /review');
    expect(within(parent).getByRole('img', { name: 'Command: /review' })).toBeTruthy();
    fireEvent.keyDown(textbox, { key: 'Backspace', code: 'Backspace' });
    expect(editor.element.value).toBe('Run ');
  } finally { dropdown.destroy(); editor.destroy(); parent.remove(); }
});

it('reloads Codex skills for typed tokens while keeping completed chips atomic', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  let name = 'first-skill';
  const nativeRequest = jest.fn(async () => ({ data: [{ cwd: '/vault', skills: [{
    name, path: '/skills/SKILL.md', scope: 'user', enabled: true,
  }] }] }));
  const skills = new CodexSkillListingService({
    onSkillsChanged: () => () => undefined,
    acquire: async () => ({
      connection: {
        launchSpec: { targetCwd: '/vault', pathMapper: { toHostPath: (path: string) => path } },
        transport: { request: nativeRequest }, refreshPlugins: async () => undefined,
      },
      release: async () => undefined,
    }),
  } as unknown as CodexAppServerRuntime);
  const catalog = new CodexCommandCatalog(skills);
  const dropdown = new MainChatComposerDropdown(parent, editor.element, new FileContextManager(new VaultMentionDataProvider(createApp())), {
    providerId: 'codex', providerConfig: catalog.getDropdownConfig(),
    providerDiscovery: createCatalogCommandDiscoveryStore(catalog),
  });
  const handleInput = jest.fn(() => dropdown.handleInputChange());
  editor.element.addEventListener('input', handleInput);
  try {
    editor.element.value = '$';
    editor.element.selectionStart = editor.element.selectionEnd = 1;
    dropdown.handleInputChange();
    await waitFor(() => within(parent).getByRole('option', { name: '$first-skill' }));
    editor.element.value = '$first';
    editor.element.selectionStart = editor.element.selectionEnd = 6;
    dropdown.handleInputChange();
    await waitFor(() => within(parent).getByRole('option', { name: '$first-skill' }));
    expect(nativeRequest).toHaveBeenCalledTimes(1);
    dropdown.hide();
    name = 'second-skill';
    editor.element.value = '$';
    editor.element.selectionStart = editor.element.selectionEnd = 1;
    dropdown.handleInputChange();
    await waitFor(() => within(parent).getByRole('option', { name: '$second-skill' }));
    expect(within(parent).queryByRole('option', { name: '$first-skill' })).toBeNull();
    expect(nativeRequest).toHaveBeenCalledTimes(2);
    expect((await axe(within(parent).getByRole('option', { name: '$second-skill' }))).violations).toEqual([]);

    fireEvent.click(within(parent).getByRole('option', { name: '$second-skill' }));
    expect(editor.element.value).toBe('$second-skill ');
    expect((await axe(within(parent).getByRole('img', { name: 'Skill: second-skill' }))).violations).toEqual([]);
    const textbox = within(parent).getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(textbox, { key: 'Backspace', code: 'Backspace' });
    await waitFor(() => expect(handleInput).toHaveBeenCalledTimes(1));
    expect(editor.element.value).toBe('$second-skill');
    expect(within(parent).getByRole('img', { name: 'Skill: second-skill' })).toBeTruthy();
    expect(dropdown.isVisible()).toBe(false);
    fireEvent.keyDown(textbox, { key: 'Backspace', code: 'Backspace' });
    await waitFor(() => expect(handleInput).toHaveBeenCalledTimes(2));
    expect(editor.element.value).toBe('');
    expect(within(parent).queryByRole('img', { name: 'Skill: second-skill' })).toBeNull();
    expect(dropdown.isVisible()).toBe(false);
    expect(nativeRequest).toHaveBeenCalledTimes(2);
  } finally {
    editor.element.removeEventListener('input', handleInput);
    dropdown.destroy();
    editor.destroy();
    parent.remove();
    await skills.dispose();
  }
});


it('accepts a visible prompt suggestion with Tab only, without sending', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const suggestion = new ComposerPromptSuggestion(editor.element, () => true, parent);
  const send = jest.fn();
  editor.element.addEventListener('keydown', event => {
    if (suggestion.handleKeydown(event)) return;
    if (event.key === 'Enter') send();
  }, true);
  try {
    editor.element.focus();
    suggestion.beginTurn();
    suggestion.bindTurn('turn', () => true);
    suggestion.receive('turn', 'Add regression tests');
    const input = within(parent).getByRole('textbox', { name: 'Message' });
    expect(within(parent).getByText('Add regression tests')).toBeDefined();
    expect(within(parent).getByText('(Tab to accept)')).toBeDefined();
    expect(editor.element.value).toBe('');
    expect(input.getAttribute('aria-description')).toBe('Add regression tests. Tab to accept');
    expect(editor.element.getAttribute('aria-description')).toBeNull();
    expect(await axe(parent)).toHaveNoViolations();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(editor.element.value).toBe('');
    expect(within(parent).getByText('Add regression tests')).toBeDefined();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(editor.element.value).toBe('Add regression tests');
    expect(send).not.toHaveBeenCalled();
    editor.element.value = '';
    fireEvent.input(editor.element);
    expect(within(parent).queryByText('Add regression tests')).toBeNull();
    expect(within(parent).queryByText('(Tab to accept)')).toBeNull();
    expect(within(parent).getByText('Ask to make changes, @mention files, run /commands')).toBeDefined();
  } finally { suggestion.destroy(); editor.destroy(); parent.remove(); }
});

it('describes a suggestion on the unfocused host textbox and hands the description to the editor on focus', () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const suggestion = new ComposerPromptSuggestion(editor.element, () => true, parent);
  try {
    suggestion.beginTurn();
    suggestion.bindTurn('turn', () => true);
    suggestion.receive('turn', 'Add regression tests');
    const host = within(parent).getByRole('textbox', { name: 'Message' });
    expect(host).toBe(editor.element);
    expect(host.getAttribute('aria-description')).toBe('Add regression tests. Tab to accept');
    // A restored draft hides the suggestion without an input event.
    editor.element.value = 'Restored draft';
    expect(host.getAttribute('aria-description')).toBeNull();
    editor.element.value = '';
    expect(host.getAttribute('aria-description')).toBe('Add regression tests. Tab to accept');
    editor.element.focus();
    const input = within(parent).getByRole('textbox', { name: 'Message' });
    expect(input).not.toBe(editor.element);
    expect(input.getAttribute('aria-description')).toBe('Add regression tests. Tab to accept');
    expect(editor.element.getAttribute('aria-description')).toBeNull();
  } finally { suggestion.destroy(); editor.destroy(); parent.remove(); }
});

it('retains a hidden suggestion through text, attachments, expanded popups and IME composition', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  let attachments = false;
  const suggestion = new ComposerPromptSuggestion(editor.element, () => !attachments, parent);
  try {
    editor.element.value = 'My draft';
    editor.element.focus();
    suggestion.beginTurn();
    suggestion.bindTurn('turn', () => true);
    suggestion.receive('turn', 'Add regression tests');
    const input = within(parent).getByRole('textbox', { name: 'Message' });
    expect(within(parent).queryByText('Add regression tests')).toBeNull();
    expect(editor.element.value).toBe('My draft');
    for (const text of ['', 'Typing', '/command', '$skill', '']) {
      editor.element.value = text;
      fireEvent.input(editor.element);
      expect(within(parent).queryByText('Add regression tests') !== null).toBe(text === '');
    }
    attachments = true;
    suggestion.refresh();
    expect(within(parent).queryByText('Add regression tests')).toBeNull();
    attachments = false;
    suggestion.refresh();
    expect(within(parent).getByText('Add regression tests')).toBeDefined();
    // Disclosures are not always native buttons.
    const disclosure = parent.createDiv({ text: 'Details', attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' } });
    disclosure.setAttribute('aria-expanded', 'true');
    await waitFor(() => expect(within(parent).queryByText('Add regression tests')).toBeNull());
    disclosure.setAttribute('aria-expanded', 'false');
    await waitFor(() => expect(within(parent).getByText('Add regression tests')).toBeDefined());
    fireEvent.compositionStart(input);
    expect(suggestion.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(false);
    fireEvent.compositionEnd(input);
    expect(suggestion.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', isComposing: true }))).toBe(false);
    expect(suggestion.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(false);
    expect(editor.element.value).toBe('');
    expect(within(parent).getByText('Add regression tests')).toBeDefined();
  } finally { suggestion.destroy(); editor.destroy(); parent.remove(); }
});

it('keeps completion relationships on the current textbox through mount and editing, then releases them', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const app = createApp();
  const originalFiles = app.vault.getFiles();
  app.vault.getFiles = () => [...originalFiles, Object.assign(new TFile(), {
    path: 'Notes/B.md', name: 'B.md', basename: 'B', stat: { mtime: testDate().getTime() },
  })];
  const files = new FileContextManager(new VaultMentionDataProvider(app));
  const input = editor.element;
  // Another tab's composer menu shares the document, so option ids must not collide.
  const otherParent = document.body.createDiv();
  const otherEditor = createEditor(otherParent);
  const otherDropdown = new ComposerDropdownController(otherParent, otherEditor.element, [files.getMentionSource()]);
  const dropdown = new ComposerDropdownController(parent, input, [files.getMentionSource()]);
  try {
    otherEditor.element.value = '@';
    otherEditor.element.selectionStart = otherEditor.element.selectionEnd = 1;
    otherDropdown.handleInputChange();
    await waitFor(() => within(otherParent).getByRole('option', { name: 'Notes/A note.md' }));
    input.value = '@';
    input.selectionStart = input.selectionEnd = 1;
    dropdown.handleInputChange();
    const option = await waitFor(() => within(parent).getByRole('option', { name: 'Notes/A note.md' }));
    const listbox = within(parent).getByRole('listbox');
    const expectRelationships = (textbox: HTMLElement, active: HTMLElement | null) => {
      const activeId = textbox.getAttribute('aria-activedescendant');
      expect(activeId === null ? null : document.getElementById(activeId)).toBe(active);
      expect(document.getElementById(textbox.getAttribute('aria-controls') ?? '')).toBe(listbox);
      expect(textbox.getAttribute('aria-autocomplete')).toBe('list');
    };
    expectRelationships(within(parent).getByRole('textbox', { name: 'Message' }), option);
    input.focus();
    expect(within(parent).getAllByRole('textbox', { name: 'Message' })).toHaveLength(1);
    const textbox = within(parent).getByRole('textbox', { name: 'Message' });
    expect(textbox).not.toBe(input);
    expectRelationships(textbox, option);
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
    const second = within(parent).getByRole('option', { name: 'Notes/B.md' });
    dropdown.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(second.getAttribute('aria-selected')).toBe('true');
    expectRelationships(textbox, second);
    fireEvent.mouseEnter(option);
    expect(option.getAttribute('aria-selected')).toBe('true');
    expectRelationships(textbox, option);
    // Editor updates must not strip relationships written by the menu.
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(input.value).toBe('@\n'));
    expectRelationships(textbox, option);
    input.value = '@nonexistent';
    input.selectionStart = input.selectionEnd = input.value.length;
    dropdown.handleInputChange();
    expect(textbox.getAttribute('aria-activedescendant')).toBeNull();
    await waitFor(() => within(parent).getByRole('option', { name: 'No matches' }));
    expectRelationships(textbox, null);
    expect(dropdown.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(textbox.getAttribute('aria-activedescendant')).toBeNull();
    expect(textbox.getAttribute('aria-controls')).toBeNull();
    dropdown.destroy();
    expect(textbox.getAttribute('aria-autocomplete')).toBeNull();
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
  } finally {
    dropdown.destroy(); otherDropdown.destroy(); files.destroy();
    editor.destroy(); otherEditor.destroy(); parent.remove(); otherParent.remove();
  }
});

it('leaves Resume picker relationships intact when an inactive completion controller is destroyed', async () => {
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const files = new FileContextManager(new VaultMentionDataProvider(createApp()));
  const dropdown = new ComposerDropdownController(parent, editor.element, [files.getMentionSource()]);
  let resume: ResumeSessionDropdown | undefined;
  try {
    editor.element.value = '@A';
    editor.element.selectionStart = editor.element.selectionEnd = 2;
    dropdown.handleInputChange();
    await waitFor(() => within(parent).getByRole('option', { name: 'Notes/A note.md' }));
    dropdown.hide();
    editor.element.focus();
    const textbox = within(parent).getByRole('textbox', { name: 'Message' });
    resume = new ResumeSessionDropdown(parent, editor.element, [{
      id: 'previous', providerId: 'claude', title: 'Previous conversation',
      createdAt: testDate({ minutes: -2 }).getTime(), lastActivityAt: testDate({ minutes: -1 }).getTime(),
      messageCount: 1, preview: 'Previous prompt',
    }], null, {
      onSelect: () => undefined, onDismiss: () => resume?.destroy(),
    });
    const listbox = within(parent).getByRole('listbox', { name: 'Resume conversation' });
    const option = within(listbox).getByRole('option', { name: /Previous conversation/ });
    expect(textbox.getAttribute('aria-activedescendant')).toBe(option.id);
    expect(textbox.getAttribute('aria-controls')).toBe(listbox.id);
    dropdown.destroy();
    expect(textbox.getAttribute('aria-activedescendant')).toBe(option.id);
    expect(textbox.getAttribute('aria-controls')).toBe(listbox.id);
    expect(textbox.getAttribute('aria-haspopup')).toBe('listbox');
    expect(resume.isVisible()).toBe(true);
    expect(await axe(parent, { runOnly: ['aria-allowed-attr'] })).toHaveNoViolations();
    resume.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(textbox.getAttribute('aria-activedescendant')).toBeNull();
    expect(textbox.getAttribute('aria-controls')).toBeNull();
    expect(textbox.getAttribute('aria-haspopup')).toBeNull();
    expect(textbox.getAttribute('aria-autocomplete')).toBeNull();
  } finally { resume?.destroy(); dropdown.destroy(); files.destroy(); editor.destroy(); parent.remove(); }
});


it('localizes the default composer hint before and after CodeMirror mounts', () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  try {
    const hint = '请求修改、@提及文件、运行 /命令';
    expect(editor.element.placeholder).toBe(hint);
    expect(within(parent).getByRole('textbox', { name: '消息' }).getAttribute('data-placeholder')).toBe(hint);
    editor.element.focus();
    expect(within(parent).getByRole('textbox', { name: '消息' })).toBeDefined();
    expect(within(parent).getByText(hint)).toBeDefined();
  } finally {
    editor.destroy();
    parent.remove();
    setLocale('en');
  }
});


it('localizes the linked content removal button through the info row', async () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const row = new ComposerInfoRow(parent);
  const remove = jest.fn();
  const chip = new LinkedContentChip(row, jest.fn(), remove);
  try {
    chip.render({ path: 'Notes/A.md', kind: 'file', label: 'A', icon: 'file-text', missing: false, target: null }, true);
    const button = within(parent).getByRole('button', { name: '移除关联内容：Notes/A.md' });
    expect(await axe(parent)).toHaveNoViolations();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    chip.destroy();
    row.destroy();
    parent.remove();
    setLocale('en');
  }
});


it('localizes image attachment labels and removal controls', async () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const images = new ImageContextManager(parent, editor.element, {});
  try {
    images.setImages([{ id: 'image', name: 'photo.png', mediaType: 'image/png', data: 'dGVzdA==', size: 500, source: 'paste' }]);
    fireEvent.click(within(parent).getByRole('button', { name: '图片附件：photo.png · 500 B' }));
    const preview = within(document.body).getByRole('dialog', { name: '图片预览：photo.png' });
    expect(within(preview).getByRole('img', { name: 'photo.png' })).toBeDefined();
    expect(await axe(preview)).toHaveNoViolations();
    fireEvent.click(within(preview).getByRole('button', { name: '关闭图片预览' }));
    expect(within(parent).getByText('图片')).toBeDefined();
    const remove = within(parent).getByRole('button', { name: '移除图片附件：photo.png · 500 B' });
    expect(await axe(remove)).toHaveNoViolations();
    fireEvent.click(remove);
    expect(images.getAttachedImages()).toEqual([]);
  } finally {
    images.destroy();
    editor.destroy();
    parent.remove();
    setLocale('en');
  }
});


it('localizes image overflow controls and updates their accessible names on expansion', async () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  // jsdom has no layout engine or host stylesheet; supply row metrics and host visibility semantics.
  const style = parent.createEl('style', { text: '.claudian-hidden, .claudian-context-chip--overflow-hidden { display: none; }' });
  const editor = createEditor(parent);
  const trayEl = parent.createDiv();
  const tray = new ComposerContextTray(trayEl);
  const images = new ImageContextManager(parent, editor.element, {}, undefined, tray);
  try {
    images.setImages(Array.from({ length: 4 }, (_, index) => ({
      id: `image-${index}`, name: `photo-${index}.png`, mediaType: 'image/png' as const,
      data: 'dGVzdA==', size: 500, source: 'paste' as const,
    })));
    const chips = trayEl.querySelectorAll<HTMLElement>('.claudian-context-chip');
    [0, 0, 38, 76].forEach((top, index) => Object.defineProperties(chips[index], {
      offsetParent: { configurable: true, value: trayEl },
      offsetTop: { configurable: true, value: top }, offsetHeight: { configurable: true, value: 20 },
    }));
    tray.refreshLayout();
    const more = within(trayEl).getByRole('button', { name: '显示另外 2 项上下文' });
    expect(more.textContent).toBe('+2 项');
    fireEvent.click(more);
    const less = within(trayEl).getByRole('button', { name: '收起' });
    expect(less).toBe(more);
    expect(less.textContent).toBe('收起');
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(within(trayEl).getByRole('button', { name: '图片附件：photo-3.png · 500 B' })).toBeDefined();
    expect(await axe(trayEl)).toHaveNoViolations();
    fireEvent.click(less);
    expect(within(trayEl).getByRole('button', { name: '显示另外 2 项上下文' })).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(within(trayEl).queryByRole('button', { name: '图片附件：photo-3.png · 500 B' })).toBeNull();
  } finally {
    images.destroy(); tray.destroy(); editor.destroy(); style.remove(); parent.remove(); setLocale('en');
  }
});


it.each(['loading', 'error'] as const)('localizes provider command %s wrappers through the real dropdown', async status => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const editor = createEditor(parent);
  const files = new FileContextManager(new VaultMentionDataProvider(createApp()));
  const snapshot: ProviderCommandDiscoverySnapshot<ProviderCommandEntry> = status === 'loading'
    ? { status: 'loading' } : { status: 'error', message: 'Native discovery failure', retryable: true };
  const dropdown = new MainChatComposerDropdown(parent, editor.element, files, {
    providerId: 'codex', providerDiscovery: {
      getSnapshot: () => snapshot, load: async () => ({ status: 'empty' }), retry: async () => ({ status: 'empty' }), subscribe: () => () => undefined,
    },
  });
  try {
    editor.element.value = '/';
    editor.element.selectionStart = editor.element.selectionEnd = 1;
    dropdown.handleInputChange();
    const expectedTexts = status === 'loading'
      ? ['正在加载提供商命令…'] : ['重新查找提供商命令', 'Native discovery failure'];
    await waitFor(() => expect(expectedTexts.map(text => within(parent).getByText(text).textContent)).toEqual(expectedTexts));
    const optionName = status === 'loading' ? '正在加载提供商命令…' : /重试/;
    expect(within(parent).getByRole('option', { name: optionName })).toBeDefined();
  } finally {
    dropdown.destroy(); files.destroy(); editor.destroy(); parent.remove(); setLocale('en');
  }
});
