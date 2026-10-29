/** @vitest-environment jsdom */
import { EditorState } from '@codemirror/state';
import { axe } from '@test/helpers/accessibility';
import {
  createInlineEditHarness as createHarness,
  disposeInlineEditHarnesses,
  instructionInput as input,
  showReplacementPreview,
  submitInstruction,
  typeInstruction,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { MarkdownRenderer, Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { buildCursorContext } from '@/core/prompt/editorContext';
import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';



afterEach(async () => {
  await disposeInlineEditHarnesses();
  vi.clearAllMocks();
});

it('removes completion menus when inline edit is rejected after selection changes', async () => {
  const h = createHarness();
  const session = h.createSession();
  session.show();
  expect(await axe(input().parentElement!)).toHaveNoViolations();
  const oldInput = input();
  typeInstruction('@');
  expect(screen.getByRole('listbox')).toBeDefined();
  h.changeSelection();
  expect(input()).not.toBe(oldInput);
  expect(screen.queryByRole('listbox')).toBeNull();
  typeInstruction('@');
  expect(screen.getByRole('listbox')).toBeDefined();
  session.reject();
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('settles inline editing and releases provider work when its editor is destroyed', async () => {
  const h = createHarness();
  h.createSession().show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.editorView.destroy();
  expect(h.backend.sessions[0].getStatus()).toBe('disposed');
  expect(h.settled.mock.calls).toEqual([[{ decision: 'reject' }]]);
});

it('mounts another inline edit after the reused editor receives a fresh note state', () => {
  const h = createHarness();
  const first = h.createSession();
  first.show();
  expect(input()).toBeDefined();
  first.reject();

  h.editorView.setState(EditorState.create({ doc: 'hello world' }));
  const second = h.createSession();
  try {
    second.show();
    expect(input()).toBeDefined();
    typeInstruction('Improve this note');
    expect(input().value).toBe('Improve this note');
  } finally {
    second.close();
  }
});

it('retains clarification when CodeMirror releases and later recreates the input widget', async () => {
  const h = createHarness();
  const session = h.createSession();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  session.show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  // WidgetType.destroy/toDOM are CodeMirror's viewport resource callbacks.
  const oldContainer = input().closest<HTMLElement>('.claudian-inline-input-container')!;
  session.destroyInputDOM(oldContainer);
  oldContainer.remove();
  h.backend.sessions[0].emitText('Which tone?');
  h.backend.sessions[0].complete();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  const restored = document.body.appendChild(session.createInputDOM());
  await within(restored).findByText('Which tone?');
  const restoredInput = within(restored).getByRole('textbox', { name: 'Edit instructions' }) as HTMLInputElement;
  expect(restoredInput.value).toBe('');
  expect(restoredInput.placeholder).toBe('Reply to continue...');
  expect(h.settled.mock.calls).toEqual([]);
  fireEvent.input(restoredInput, { target: { value: 'Formal' } });
  fireEvent.keyDown(restoredInput, { key: 'Enter' });
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
});

it('restarts from the editor context after a clarification reply fails', async () => {
  const h = createHarness();
  h.createSession().show();
  submitInstruction('Improve');
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.backend.sessions[0].emitText('Which tone?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(input().placeholder).toBe('Reply to continue...'));

  submitInstruction('Formal');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
  h.backend.sessions[0].fail('provider crashed');
  await waitFor(() => expect(input().disabled).toBe(false));

  // The failed conversation is gone, so the retry carries the selection again.
  submitInstruction('Formal');
  await waitFor(() => expect(h.backend.sessions[1]?.requests).toHaveLength(1));
  expect(h.backend.sessions[1].requests[0].input[0]).toMatchObject({ text: expect.stringContaining('<editor_selection') });
  expect(h.settled).not.toHaveBeenCalled();
});

it.each(['plugin unload', 'editor destruction', 'second invocation'] as const)(
  'settles pending initialization on %s and never publishes a late input', async reason => {
    const h = createHarness();
    let initialized = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    ProviderWorkspaceRegistry.setServices('claude', undefined);
    ProviderWorkspaceRegistry.register('claude', {
      async initialize() { initialized = true; await gate; return {}; },
    });
    const result = h.createModal().openAndWait();
    await waitFor(() => expect(initialized).toBe(true));
    if (reason === 'plugin unload') h.owner.dispose();
    else if (reason === 'editor destruction') h.editorView.destroy();
    else await h.createModal().openAndWait();
    await expect(result).resolves.toEqual({ decision: 'reject' });
    release();
    await ProviderWorkspaceRegistry.ensureInitialized(h.plugin.providerHost, 'claude', 'test-settlement');
    expect(screen.queryByRole('textbox', { name: 'Edit instructions' })).toBeNull();
    expect(h.backend.sessions).toHaveLength(0);
  },
);

it.each(['cursor', 'selection'] as const)('rejects changed %s context during provider startup', async mode => {
  const h = createHarness();
  const sourceDoc = h.editorView.state.doc;
  const context = mode === 'cursor'
    ? { mode, cursorContext: buildCursorContext(line => sourceDoc.line(line + 1).text, sourceDoc.lines, 0, 5) }
    : { mode, selectedText: 'hello' };
  let initialized = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  ProviderWorkspaceRegistry.setServices('claude', undefined);
  ProviderWorkspaceRegistry.register('claude', {
    async initialize() { initialized = true; await gate; return {}; },
  });
  const modal = new InlineEditModal(
    h.app, h.plugin, h.plugin, h.editor, { editor: h.editor } as any, context, h.notePath, h.owner,
  );
  const settled = vi.fn();
  const result = modal.openAndWait().then(settled);
  await waitFor(() => expect(initialized).toBe(true));
  h.editorView.dispatch({ changes: { from: 0, insert: 'PREFIX ' } });
  release();
  await waitFor(() => expect(settled).toHaveBeenCalledWith({ decision: 'reject' }));
  await result;
  expect(Notice).toHaveBeenCalledWith(STALE_SOURCE_NOTICE);
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.editorView.state.doc.toString()).toBe('PREFIX hello world');
  // Establish the same modal still opens a usable editor when its source stays unchanged.
  const retry = h.createModal().openAndWait();
  const field = await screen.findByRole('textbox', { name: 'Edit instructions' });
  expect(await axe(field.closest('.claudian-inline-input-container')!)).toHaveNoViolations();
  h.owner.dispose();
  await expect(retry).resolves.toEqual({ decision: 'reject' });
});

it('closes a visible edit on plugin unload without refocusing its editor', async () => {
  const h = createHarness();
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  const outside = document.body.appendChild(document.createElement('button'));
  outside.focus();
  h.owner.dispose();
  await expect(result).resolves.toEqual({ decision: 'reject' });
  expect(h.backend.sessions[0].getStatus()).toBe('disposed');
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByRole('textbox', { name: 'Edit instructions' })).toBeNull();
  await expect(h.createModal().openAndWait()).resolves.toEqual({ decision: 'reject' });
});

it.each([
  { action: 'Accept', keyboard: false },
  { action: 'Accept', keyboard: true },
  { action: 'Reject', keyboard: true },
] as const)('settles the preview through $action (keyboard: $keyboard)', async ({ action, keyboard }) => {
  const h = createHarness();
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('<replacement>Hi</replacement>');
  h.backend.sessions[0].complete();
  const control = await screen.findByRole('button', { name: `${action} inline edit` });
  expect(h.editorView.state.doc.toString()).toBe('hello world');
  expect(screen.getByRole('toolbar', { name: 'Inline edit actions' }).textContent).toContain('−1+1lines');
  expect(await axe(screen.getByRole('toolbar', { name: 'Inline edit actions' }))).toHaveNoViolations();
  let nativeActivationAllowed = true;
  if (keyboard) {
    control.focus();
    // jsdom does not synthesize a native button's click after Enter.
    nativeActivationAllowed = fireEvent.keyDown(control, { key: 'Enter' });
  }
  expect(nativeActivationAllowed).toBe(true);
  fireEvent.click(control);
  await expect(result).resolves.toEqual(action === 'Accept'
    ? { decision: 'accept', editedText: 'Hi' }
    : { decision: 'reject' });
  expect(h.editorView.state.doc.toString()).toBe(action === 'Accept' ? 'Hi world' : 'hello world');
  expect(h.backend.sessions[0].getStatus()).toBe('disposed');
});

it('opens the model menu outside the clipped editor widget, above its chip, and removes it with the edit', async () => {
  const h = createHarness();
  const session = h.createSession();
  session.show();
  const chip = screen.getByRole('button', { name: 'Model: Sonnet, effort High' });
  chip.getBoundingClientRect = () => DOMRect.fromRect({ x: 300, y: 200, width: 120, height: 24 });
  fireEvent.click(chip);
  const menu = screen.getByRole('dialog', { name: 'Model options' });
  // Obsidian gives editor widgets paint containment, which clips anything inside them that overflows.
  expect(input().closest('.claudian-inline-input-container')!.contains(menu)).toBe(false);
  // Fixed above the chip: the menu's bottom edge sits 8px over the chip's top.
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-bottom')).toBe(`${window.innerHeight - 200 + 8}px`);
  expect(await axe(menu)).toHaveNoViolations();
  // The composer focuses its input shortly after mounting; that must not pull focus out of an open menu.
  await new Promise(resolve => window.setTimeout(resolve, 80));
  expect(screen.getByRole('dialog', { name: 'Model options' })).toBe(menu);

  // Escape closes the menu first and leaves the edit open.
  fireEvent.keyDown(screen.getByRole('option', { name: 'Sonnet' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Model options' })).toBeNull();
  expect(h.settled).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(chip);

  fireEvent.click(chip);
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort High' });
  expect(screen.getByRole('dialog', { name: 'Model options' })).toBeDefined();
  session.reject();
  // Closing the edit with the menu open must not leave it behind outside the editor.
  expect(menu.isConnected).toBe(false);
  expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull();
});

it('saves the model and effort chosen on its composer chip as the inline edit default', async () => {
  const h = createHarness();
  h.createSession().show();
  expect(await axe(input().closest('.claudian-inline-input-container')!)).toHaveNoViolations();
  fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort High' });
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Low' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort Low' });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.sessions[0].requests[0].configuration).toMatchObject({ model: 'opus', reasoning: 'low' });
  // A running request hides the chip, so its choices cannot change mid-request.
  expect(screen.getByRole('button', { name: 'Model: Opus, effort Low' }).closest('.claudian-hidden')).not.toBeNull();
  // The chat's own selection is untouched.
  expect(h.plugin.settings).toEqual({
    model: 'sonnet',
    effortLevel: 'high',
    inlineEditModel: { providerId: 'claude', model: 'opus', reasoning: 'low' },
  });
});

it('runs a new edit with the model and effort its chip shows when nothing is chosen or saved', async () => {
  const h = createHarness();
  void h.createModal().openAndWait();
  // The chip resolves the provider's saved model and effort; the request must use exactly those.
  await screen.findByRole('button', { name: 'Model: Sonnet, effort High' });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.sessions[0].requests[0].configuration).toMatchObject({ model: 'sonnet', reasoning: 'high' });
});

it.each([
  { saved: { providerId: 'claude', model: 'opus', reasoning: 'low' }, chip: 'Model: Opus, effort Low', model: 'opus', reasoning: 'low' },
  // An unavailable saved model falls back to the chat selection. The provider's saved effort, not its
  // default, is what the chip shows, and it is sent explicitly: some providers omit an unset effort.
  { saved: { providerId: 'claude', model: 'retired' }, chip: 'Model: Sonnet, effort Low', model: 'sonnet', reasoning: 'low' },
])('starts a new edit from the saved inline default ($saved.model) or else the chat selection', async ({ saved, chip, model, reasoning }) => {
  const h = createHarness();
  h.plugin.settings.effortLevel = 'low';
  h.plugin.settings.inlineEditModel = saved;
  h.plugin.getActiveModelSelection = () => ({ providerId: 'claude', model: 'sonnet' });
  void h.createModal().openAndWait();
  await screen.findByRole('button', { name: chip });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const { configuration } = h.backend.sessions[0].requests[0];
  expect(configuration.model).toBe(model);
  expect(configuration.reasoning).toBe(reasoning);
});

it.each([
  { key: 'Enter', from: 'where focus lands after generation' },
  { key: 'Escape', from: 'where focus lands after generation' },
  { key: 'Enter', from: 'the note editor' },
  { key: 'Escape', from: 'the note editor' },
] as const)('settles the preview with $key pressed in $from', async ({ key, from }) => {
  const h = createHarness();
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  await showReplacementPreview(h);
  if (from === 'the note editor') h.editorView.contentDOM.focus();
  // CodeMirror would insert a newline on Enter, so the decision must be taken before it sees the key.
  const reachedEditor = vi.fn();
  h.editorView.contentDOM.addEventListener('keydown', reachedEditor);
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
  expect(reachedEditor).not.toHaveBeenCalled();
  await expect(result).resolves.toEqual(key === 'Enter'
    ? { decision: 'accept', editedText: 'Hi' }
    : { decision: 'reject' });
  expect(h.editorView.state.doc.toString()).toBe(key === 'Enter' ? 'Hi world' : 'hello world');
});

it('continues provider execution when vault mentions cannot load and reports one notice', async () => {
  const h = createHarness();
  h.app.vault.getFiles = () => { throw new Error('vault unavailable'); };
  h.createSession().show();
  submitInstruction('Improve @missing');
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  expect((Notice as unknown as Mock).mock.calls).toEqual([
    ['Failed to load vault files. Vault @-mentions may be unavailable.'],
  ]);
});

describe('Vault paths that resemble environment variables', () => {
  const variable = 'CLAUDIAN_INLINE_MENTION_VAR';
  const percentPath = `notes/a%${variable}%b.md`;
  const dollarPath = `notes/$${variable}.md`;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[variable];
    process.env[variable] = 'expanded';
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });

  function withVaultFiles(h: ReturnType<typeof createHarness>): void {
    h.app.vault.getFiles = () => [percentPath, dollarPath].map(filePath => {
      const name = filePath.split('/').pop()!;
      return { basename: name.replace(/\.md$/, ''), extension: 'md', name, path: filePath, stat: { ctime: 1, mtime: 1, size: 1 } };
    });
  }

  it('attaches mentioned files by their literal Vault paths', async () => {
    const h = createHarness();
    withVaultFiles(h);
    h.createSession().show();
    typeInstruction(`Improve @${percentPath} using @${dollarPath}`);
    // The trailing mention is still an open trigger, so Enter first accepts its suggestion.
    fireEvent.click(await screen.findByRole('option', { name: dollarPath }));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    const prompt = h.backend.sessions[0].requests[0].input
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n');
    expect(prompt).toContain(`<context_files>\n<context_file path="${percentPath}" />\n<context_file path="${dollarPath}" />\n</context_files>`);
  });

  it('inserts the literal Vault path of a selected suggestion', async () => {
    const h = createHarness();
    withVaultFiles(h);
    h.createSession().show();
    typeInstruction(`@a%${variable}`);
    const option = await screen.findByRole('option', { name: percentPath });
    const listbox = screen.getByRole('listbox');
    expect(await axe(listbox)).toHaveNoViolations();
    expect(screen.getByRole('listbox', { name: 'Input suggestions' })).toBe(listbox);
    fireEvent.click(option);
    expect(input().value).toBe(`@${percentPath} `);
  });
});

describe('Vault mentions whose literal path ends in punctuation', () => {
  function withVaultFiles(h: ReturnType<typeof createHarness>, paths: readonly string[]): void {
    const timestamp = testDate().getTime();
    h.app.vault.getFiles = () => paths.map(path => {
      const name = path.split('/').pop()!;
      return {
        basename: name.replace(/\.[^.]+$/, ''),
        extension: name.includes('.') ? name.split('.').pop()! : '',
        name,
        path,
        stat: { ctime: timestamp, mtime: timestamp, size: 1 },
      };
    });
  }

  it.each([
    {
      name: 'only the punctuation-ended file is known',
      vault: ['Report!'],
      instruction: 'Improve @Report!',
      openSuggestion: 'Report!',
      contextBlock: '<context_files>\n<context_file path="Report!" />\n</context_files>',
    },
    {
      name: 'a shorter stem is known as well',
      vault: ['Report', 'Report!'],
      instruction: 'Improve @Report!',
      openSuggestion: 'Report!',
      contextBlock: '<context_files>\n<context_file path="Report!" />\n</context_files>',
    },
    {
      name: 'sentence punctuation follows the punctuation-ended file',
      vault: ['Report', 'Report!'],
      instruction: 'Improve @Report!,please',
      contextBlock: '<context_files>\n<context_file path="Report!" />\n</context_files>',
    },
    {
      name: 'sentence punctuation follows a normal file',
      vault: ['note.md'],
      instruction: 'Improve @note.md, please',
      contextBlock: '<context_files>\n<context_file path="note.md" />\n</context_files>',
    },
    {
      name: 'a sentence period follows a spaced file',
      vault: ['src/my', 'src/my file.md'],
      instruction: 'Check @src/my file.md. then continue',
      contextBlock: '<context_files>\n<context_file path="src/my file.md" />\n</context_files>',
    },
    {
      name: 'a repeated period follows a period-ended file',
      vault: ['Report', 'Report.'],
      instruction: 'Improve @Report..',
      contextBlock: '<context_files>\n<context_file path="Report." />\n</context_files>',
    },
  ])('attaches the literal file for $name and keeps the complete instruction', async ({
    vault, instruction, openSuggestion, contextBlock,
  }) => {
    const h = createHarness();
    withVaultFiles(h, vault);
    const result = h.createModal().openAndWait();
    await screen.findByRole('textbox', { name: 'Edit instructions' });
    typeInstruction(instruction);
    // A trailing mention that names a file is still an open trigger; accepting it keeps the literal path.
    if (openSuggestion) fireEvent.click(await screen.findByRole('option', { name: openSuggestion }));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    const prompt = h.backend.sessions[0].requests[0].input
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n');
    expect(prompt).toContain(instruction);
    expect(prompt).toContain(contextBlock);
    h.owner.dispose();
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });
});

it('uses provider-scoped hidden commands and cancels widget-owned discovery on replacement', async () => {
  const h = createHarness();
  const signals: AbortSignal[] = [];
  const entries = ['analyze', 'visible'].map(name => ({
    name, id: name, providerId: 'claude', kind: 'command', scope: 'runtime', source: 'user',
    content: '', displayPrefix: '/', insertPrefix: '/', isEditable: false, isDeletable: false,
  } satisfies ProviderCommandEntry));
  const catalog: ProviderCommandCatalog = {
    getDropdownConfig: () => ({ providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' }),
    async listDropdownEntries({ signal }) { signals.push(signal!); return entries; },
    refresh: async () => {},
  };
  ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog });
  h.plugin.settings.hiddenCommands = ['analyze'];
  const session = h.createSession();
  session.show();
  typeInstruction('/');
  await screen.findByRole('option', { name: '/visible' });
  expect(screen.queryByRole('option', { name: '/analyze' })).toBeNull();
  h.changeSelection();
  expect(screen.queryByRole('listbox')).toBeNull();
  catalog.listDropdownEntries = ({ signal }) => new Promise(resolve => {
    signals.push(signal!);
    signal!.addEventListener('abort', () => resolve([]), { once: true });
  });
  typeInstruction('/');
  await waitFor(() => expect(signals.length).toBe(2));
  session.reject();
  expect(signals[1].aborted).toBe(true);
  expect(screen.queryByRole('listbox')).toBeNull();
});


it('discovers commands as a blank chat tab does when the provider reports them through its loader', async () => {
  const h = createHarness();
  // A runtime catalog lists only what a session or loader reported; nothing has chatted in this run.
  const catalog = new RuntimeCommandCatalog({
    dropdownConfig: { providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' },
    projectEntry: command => ({ ...command, providerId: 'claude', kind: command.kind ?? 'command', scope: 'runtime',
      source: 'sdk', isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/' }),
  });
  const loadCommands = vi.fn(async () => ({ status: 'ready' as const, items: [
    { id: 'skill:summarize', name: 'summarize', description: 'Summarize', content: '', kind: 'skill' as const },
  ] as [ProviderCommandEntry] }));
  ProviderWorkspaceRegistry.setServices('claude', {
    commandCatalog: catalog,
    commandLoader: { getCacheFingerprint: () => 'test', isAvailable: () => true, loadCommands },
  });
  h.createSession().show();
  typeInstruction('/');
  await screen.findByRole('option', { name: /^\/summarize\b/ });
  expect(loadCommands).toHaveBeenCalledWith(expect.objectContaining({ allowIsolatedMetadataCreation: true, conversation: null }));
  expect(screen.queryByRole('option', { name: '/clear' })).toBeNull();
});

async function rejectAfterSourceChange(h: ReturnType<typeof createHarness>, expectedRequests: number): Promise<void> {
  h.editorView.dispatch({ changes: { from: 0, insert: 'XXXXX' } });
  submitInstruction('Use uppercase');
  await waitFor(() => expect(h.settled).toHaveBeenCalledWith({ decision: 'reject' }));
  expect(h.backend.sessions.flatMap(session => session.requests)).toHaveLength(expectedRequests);
  expect(screen.queryByRole('button', { name: 'Accept inline edit' })).toBeNull();
}

it('rejects changed source before first submission without sending stale edit context', async () => {
  const h = createHarness();
  h.createSession().show();
  await rejectAfterSourceChange(h, 0);
  expect(h.editorView.state.doc.toString()).toBe('XXXXXhello world');
});

it('rejects changed source before clarification reply without continuing stale edit context', async () => {
  const h = createHarness();
  h.createSession().show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('Which tone?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(input().placeholder).toBe('Reply to continue...'));
  await rejectAfterSourceChange(h, 1);
  expect(h.editorView.state.doc.toString()).toBe('XXXXXhello world');
});

const STALE_SOURCE_NOTICE = 'Inline edit was not applied because the source document or selection changed.';

it.each(['while the provider runs', 'before the preview is accepted'] as const)(
  'refuses a replacement when the source changes %s', async timing => {
    const h = createHarness();
    h.createSession().show();
    submitInstruction();
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    const changeSource = () => h.editorView.dispatch({ changes: { from: h.editorView.state.doc.length, insert: '!' } });
    if (timing === 'while the provider runs') changeSource();
    h.backend.sessions[0].emitText('<replacement>Hi</replacement>');
    h.backend.sessions[0].complete();
    if (timing === 'before the preview is accepted') {
      const accept = await screen.findByRole('button', { name: 'Accept inline edit' });
      changeSource();
      fireEvent.click(accept);
    }
    await waitFor(() => expect(h.settled.mock.calls).toEqual([[{ decision: 'reject' }]]));
    expect(Notice).toHaveBeenCalledWith(STALE_SOURCE_NOTICE);
    expect(h.editorView.state.doc.toString()).toBe('hello world!');
    expect(screen.queryByRole('toolbar', { name: 'Inline edit actions' })).toBeNull();
  },
);

it('applies an accepted replacement once and ignores later decisions', async () => {
  const h = createHarness();
  const session = h.createSession();
  session.show();
  fireEvent.click(await showReplacementPreview(h));
  session.accept();
  session.reject();
  expect(h.settled.mock.calls).toEqual([[{ decision: 'accept', editedText: 'Hi' }]]);
  expect(h.editorView.state.doc.toString()).toBe('Hi world');
  expect(h.editorView.hasFocus).toBe(true);
});

it('never previews a provider result that resolves after the edit is rejected', async () => {
  const h = createHarness();
  const session = h.createSession();
  session.show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  // The run finishes before rejection, so its result is already on its way to the session.
  h.backend.sessions[0].emitText('<replacement>Hi</replacement>');
  h.backend.sessions[0].complete();
  session.reject();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  expect(screen.queryByRole('button', { name: 'Accept inline edit' })).toBeNull();
  expect(h.settled.mock.calls).toEqual([[{ decision: 'reject' }]]);
  expect(h.editorView.state.doc.toString()).toBe('hello world');
});

it.each([
  { target: 'outside', key: 'Escape', expected: [] },
  { target: 'outside', key: 'Enter', expected: [] },
  { target: 'editor', key: 'Escape', expected: [[{ decision: 'reject' }]] },
  { target: 'editor', key: 'Enter', expected: [[{ decision: 'accept', editedText: 'Hi' }]] },
] as const)('handles $key in the $target only when it belongs to the edit', async ({ target, key, expected }) => {
  const h = createHarness();
  h.createSession().show();
  await showReplacementPreview(h);
  const outside = document.body.appendChild(document.createElement('button'));
  fireEvent.keyDown(target === 'outside' ? outside : h.editorView.contentDOM, { key });
  expect(h.settled.mock.calls).toEqual(expected);
});
