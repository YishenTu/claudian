/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import {
  createInlineEditHarness as createHarness,
  disposeInlineEditHarnesses,
  instructionInput as input,
  registerFakeInlineEditProvider,
  showReplacementPreview,
  submitInstruction,
  typeInstruction,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { Component, type Editor, type MarkdownFileInfo, MarkdownRenderer, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { createInlineEditCommand } from '@/features/inline-edit/inlineEditCommand';
import { InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';
import { setLocale } from '@/i18n/i18n';

afterEach(async () => {
  await disposeInlineEditHarnesses();
  setLocale('en');
  vi.mocked(MarkdownRenderer.render).mockReset();
  vi.clearAllMocks();
  // Held provider starts must not outlive their test.
  vi.restoreAllMocks();
});

const englishControls = {
  locale: 'en', command: 'Inline edit', toolbar: 'Inline edit actions',
  accept: 'Accept', reject: 'Reject', acceptLabel: 'Accept inline edit', rejectLabel: 'Reject inline edit',
  insertion: { field: 'Insert instructions', placeholder: 'Insert instructions...', notice: 'Inserted', stats: '+1line' },
  selection: { field: 'Edit instructions', placeholder: 'Edit instructions...', notice: 'Edit applied', stats: '−1+1lines' },
} as const;

const chineseControls = {
  locale: 'zh-CN', command: '行内编辑', toolbar: '行内编辑操作',
  accept: '接受', reject: '拒绝', acceptLabel: '接受行内编辑', rejectLabel: '拒绝行内编辑',
  insertion: { field: '插入指令', placeholder: '插入指令…', notice: '已插入', stats: '+1行' },
  selection: { field: '编辑指令', placeholder: '编辑指令…', notice: '已应用编辑', stats: '−1+1行' },
} as const;

it.each([
  { mode: 'insertion', anchor: 5, response: '<insertion>X</insertion>', document: 'helloX world' },
  { mode: 'selection', anchor: 0, response: '<replacement>Hi</replacement>', document: 'Hi world' },
] as const)('applies $mode through the command callback across locale changes', async ({ mode, anchor, response, document }) => {
  for (const controls of [englishControls, chineseControls, englishControls]) {
    setLocale(controls.locale);
    const h = await createHarness();
    h.editorView.dispatch({ selection: { anchor, head: 5 } });
    const view = new MarkdownView(new WorkspaceLeaf());
    view.editor = h.editor;
    view.file = Object.assign(new TFile(), { path: h.notePath });
    const command = createInlineEditCommand({ host: h.plugin, component: h.component, sessions: h.owner });
    const completion = command.editorCallback!(h.editor, view);
    try {
      expect(command).toMatchObject({ id: 'inline-edit', name: controls.command });
      const expected = controls[mode];
      const instruction = await screen.findByRole<HTMLInputElement>('textbox', { name: expected.field });
      expect(instruction.placeholder).toBe(expected.placeholder);
      expect(await axe(instruction.parentElement!)).toHaveNoViolations();
      fireEvent.input(instruction, { target: { value: 'Make this clearer' } });
      fireEvent.keyDown(instruction, { key: 'Enter' });
      await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
      const [request] = h.backend.sessions[0].requests;
      expect(request.configuration).toMatchObject({ model: 'sonnet', reasoning: 'high' });
      expect(request.input[0]).toMatchObject({ text: expect.stringContaining('Make this clearer') });
      h.backend.sessions[0].emitText(response);
      h.backend.sessions[0].complete();
      const toolbar = await screen.findByRole('toolbar', { name: controls.toolbar });
      expect(toolbar.querySelector('.claudian-inline-diff-stats')?.textContent).toBe(expected.stats);
      const accept = within(toolbar).getByRole('button', { name: controls.acceptLabel });
      const reject = within(toolbar).getByRole('button', { name: controls.rejectLabel });
      expect(within(accept).getByText(controls.accept)).toBe(accept);
      expect(within(reject).getByText(controls.reject)).toBe(reject);
      expect(await axe(toolbar)).toHaveNoViolations();
      expect(h.editor.getValue()).toBe('hello world');
      fireEvent.click(accept);
      await completion;
      expect(h.editor.getValue()).toBe(document);
      expect(Notice).toHaveBeenLastCalledWith(expected.notice);
    } finally {
      h.owner.dispose();
      await completion;
      await disposeInlineEditHarnesses();
    }
  }
});

it('shows the localized zero-change preview and keeps the note on rejection', async () => {
  setLocale('zh-CN');
  const h = await createHarness();
  const session = h.createSession();
  try {
    session.show();
    const field = screen.getByRole('textbox', { name: '编辑指令' });
    fireEvent.input(field, { target: { value: 'Leave the selection as it is' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    h.backend.sessions[0].emitText('<replacement>hello</replacement>');
    h.backend.sessions[0].complete();
    const toolbar = await screen.findByRole('toolbar', { name: '行内编辑操作' });
    expect(toolbar.querySelector('.claudian-inline-diff-stats')?.textContent).toBe('行');
    fireEvent.click(within(toolbar).getByRole('button', { name: '拒绝行内编辑' }));
    expect(h.settled).toHaveBeenCalledWith({ decision: 'reject' });
    expect(h.editor.getValue()).toBe('hello world');
  } finally {
    session.close();
  }
});

it('reports a missing active Markdown view in the selected language', async () => {
  setLocale('zh-CN');
  const h = await createHarness();
  h.plugin.app.workspace.getActiveViewOfType = () => null;
  const context: MarkdownFileInfo = { app: h.plugin.app, editor: h.editor, file: null, hoverPopover: null };
  const command = createInlineEditCommand({ host: h.plugin, component: h.component, sessions: h.owner });
  await command.editorCallback!(h.editor, context);
  expect(Notice).toHaveBeenCalledWith('行内编辑不可用：无法访问当前 Markdown 视图。');
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.editor.getValue()).toBe('hello world');
});

it('replaces a nonzero-line editor range and inserts when the end is omitted', async () => {
  const h = await createHarness();
  h.editorView.dispatch({ changes: { from: 0, to: 11, insert: 'top\nhello world\nend' } });
  h.editor.replaceRange('Hi', { line: 1, ch: 0 }, { line: 1, ch: 5 });
  expect(h.editor.getValue()).toBe('top\nHi world\nend');
  h.editor.replaceRange('!', { line: 1, ch: 2 });
  expect(h.editor.getValue()).toBe('top\nHi! world\nend');
});

describe('editor resolution', () => {
  it('opens on the view editor when the callback editor has no CodeMirror view', async () => {
    const h = await createHarness();
    const result = h.createModal({} as Editor, h.editor).openAndWait();
    expect(await screen.findByRole('textbox', { name: 'Edit instructions' })).toBeDefined();
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });

  it.each([
    ['en', 'Inline edit unavailable: could not access the active editor. Try reopening the note.'],
    ['zh-CN', '行内编辑不可用：无法访问当前编辑器。请尝试重新打开笔记。'],
  ] as const)('rejects with a %s notice when neither editor exposes a CodeMirror view', async (locale, notice) => {
    setLocale(locale);
    const h = await createHarness();
    await expect(h.createModal({} as Editor, {} as Editor).openAndWait()).resolves.toEqual({ decision: 'reject' });
    expect(Notice).toHaveBeenCalledWith(notice);
    expect(screen.queryByRole('textbox', { name: /Edit instructions|编辑指令/ })).toBeNull();
    expect(h.backend.sessions).toHaveLength(0);
    expect(h.editor.getValue()).toBe('hello world');
  });
});

describe('provider and model resolution', () => {
  it.each([
    {
      name: 'uses the enabled settings provider when nothing is selected',
      selection: null,
      settings: { settingsProvider: 'claude', providerConfigs: { claude: { enabled: false } } },
      expectedModel: 'sonnet',
      expectedChip: 'Model: Sonnet, effort High',
    },
    {
      name: 'falls back to the settings provider without the model of a disabled selection',
      selection: { providerId: 'claude', model: 'sonnet' },
      settings: { settingsProvider: 'codex', providerConfigs: { claude: { enabled: false } } },
      expectedModel: 'sonnet',
      expectedChip: 'Model: Sonnet, effort High',
    },
    {
      name: 'uses the selected provider and model',
      selection: { providerId: 'codex', model: 'opus' },
      settings: { settingsProvider: 'claude' },
      expectedModel: 'opus',
      expectedChip: 'Model: Opus, effort High',
    },
  ])('$name', async ({ selection, settings, expectedModel, expectedChip }) => {
    const h = await createHarness();
    const codex = registerFakeInlineEditProvider('codex');
    Object.assign(h.plugin.settings, settings);
    h.plugin.getActiveModelSelection = () => selection;
    const result = h.createModal().openAndWait();
    await screen.findByRole('textbox', { name: 'Edit instructions' });
    // Without a saved model the provider's default is resolved once, shown on the chip and sent.
    expect(screen.getByRole('button', { name: expectedChip })).toBeDefined();
    submitInstruction();
    await waitFor(() => expect(codex.sessions[0]?.requests).toHaveLength(1));
    expect(h.backend.sessions).toHaveLength(0);
    expect(codex.sessions[0].requests[0].configuration.model).toBe(expectedModel);
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });
});

/**
 * Holds a provider's start until the test settles it. Like the provider registry, callers share the
 * start in flight, and a call after a failed start begins a new one.
 */
function holdProviderStart(heldProviderId: string) {
  let pending: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
  const ensureInitialized = ProviderWorkspaceRegistry.ensureInitialized.bind(ProviderWorkspaceRegistry);
  vi.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockImplementation((host, providerId, reason) => {
    if (providerId !== heldProviderId) return ensureInitialized(host, providerId, reason);
    if (!pending) {
      let resolve = (): void => {};
      let reject = (_error: Error): void => {};
      const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      pending = { promise, resolve, reject };
    }
    return pending.promise;
  });
  return {
    finish: () => pending?.resolve(),
    fail: (error: Error) => {
      const failed = pending;
      pending = null;
      failed?.reject(error);
    },
  };
}

it('switches provider from the model picker until the first request, then keeps it', async () => {
  const h = await createHarness();
  const saves: Array<() => Promise<void>> = [];
  const mutateSettings = h.plugin.mutateSettings;
  h.plugin.mutateSettings = (mutation) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const saving = held.then(() => mutateSettings(mutation));
    saves.push(() => { release(); return saving; });
    return saving;
  };
  // GPT's Max effort is known only once the provider has fetched the picked model's metadata.
  let gptMetadataReady = false;
  const codex = registerFakeInlineEditProvider('codex', [{ value: 'gpt', label: 'GPT' }], {
    getReasoningOptions: () => [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      ...(gptMetadataReady ? [{ value: 'max', label: 'Max' }] : []),
    ],
    prepareModelMetadata: async (model) => { gptMetadataReady ||= model === 'gpt'; },
  });
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  typeInstruction('Make it formal');
  const codexStart = holdProviderStart('codex');

  try {
    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
    const providers = within(screen.getByRole('dialog', { name: 'Model options' })).getAllByRole('tab');
    expect(providers.map(tab => tab.getAttribute('aria-label'))).toEqual(['claude', 'codex']);
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'codex' }));
    fireEvent.click(screen.getByRole('option', { name: 'GPT' }));
    // The chip shows the pick while its provider starts, and an effort chosen meanwhile is kept.
    await screen.findByRole('button', { name: 'Model: GPT, effort High' });
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Low' }));
    await screen.findByRole('button', { name: 'Model: GPT, effort Low' });
    // Enter while the provider starts sends nothing until the edit runs on it.
    fireEvent.keyDown(input(), { key: 'Enter' });
    // Request admission is independent of remembering the low selection.
    await saves[0]();
    expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'codex', model: 'gpt', reasoning: 'high' });
    expect([h.backend.sessions, codex.sessions]).toEqual([[], []]);
    codexStart.finish();

    await waitFor(() => expect(codex.sessions[0]?.requests).toHaveLength(1));
    expect(h.backend.sessions).toHaveLength(0);
    expect(codex.sessions[0].requests[0].configuration).toMatchObject({ model: 'gpt', reasoning: 'low' });
    // The instruction typed before the switch survives the composer's rebuild.
    expect(codex.sessions[0].requests[0].input[0]).toMatchObject({ text: expect.stringContaining('Make it formal') });
    // Sending the local low pick does not wait for its default to become durable.
    expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'codex', model: 'gpt', reasoning: 'high' });
    await saves[1]();
    await waitFor(() => expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'codex', model: 'gpt', reasoning: 'low' }));

    // A clarification continues the conversation on its provider, so the picker offers only its models.
    codex.sessions[0].emitText('Which tone?');
    codex.sessions[0].complete();
    await waitFor(() => expect(input().placeholder).toBe('Reply to continue...'));
    fireEvent.click(screen.getByRole('button', { name: 'Model: GPT, effort Low' }));
    const menu = screen.getByRole('dialog', { name: 'Model options' });
    expect(within(menu).getAllByRole('option').map(option => option.textContent)).toContain('GPT');
    expect(within(menu).queryAllByRole('tab')).toEqual([]);
    expect(within(within(menu).getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Max' })).toBeDefined();
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  } finally {
    codexStart.finish();
    await Promise.all(saves.map(save => save()));
  }
});

describe('a submit waiting for a picked provider to start', () => {
  /** Opens an edit with codex registered, whose start is held until the returned controls settle it. */
  async function openWithHeldCodexStart() {
    const h = await createHarness();
    const codex = registerFakeInlineEditProvider('codex', [{ value: 'gpt', label: 'GPT' }]);
    const result = h.createModal().openAndWait();
    await screen.findByRole('textbox', { name: 'Edit instructions' });
    const start = holdProviderStart('codex');
    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'codex' }));
    fireEvent.click(screen.getByRole('option', { name: 'GPT' }));
    return { h, codex, result, start };
  }

  it('sends nothing when the picked provider fails to start, and retries it on the next submit', async () => {
    const { h, codex, result, start } = await openWithHeldCodexStart();
    submitInstruction('Make it formal');
    start.fail(new Error('no CLI'));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to start the codex provider.'));
    await waitFor(() => expect(input().disabled).toBe(false));
    expect([h.backend.sessions, codex.sessions]).toEqual([[], []]);
    expect(input().value).toBe('Make it formal');

    // The chip keeps the pick, so the retry starts its provider again and runs there.
    expect(screen.getByRole('button', { name: 'Model: GPT, effort High' })).toBeDefined();
    fireEvent.keyDown(input(), { key: 'Enter' });
    start.finish();
    await waitFor(() => expect(codex.sessions[0]?.requests).toHaveLength(1));
    expect(codex.sessions[0].requests[0].configuration).toMatchObject({ model: 'gpt' });
    expect(h.backend.sessions).toHaveLength(0);
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });

  it('sends at once on the current provider when a later pick returns to it', async () => {
    const { h, codex, result } = await openWithHeldCodexStart();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'claude' }));
    fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
    await screen.findByRole('button', { name: 'Model: Opus, effort High' });
    submitInstruction();
    // The codex start never settles; the edit no longer waits for it.
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    expect(h.backend.sessions[0].requests[0].configuration).toMatchObject({ model: 'opus' });
    expect(codex.sessions).toHaveLength(0);
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });
});

it('reports initial provider startup failure in Chinese', async () => {
  setLocale('zh-CN');
  const h = await createHarness();
  ProviderWorkspaceRegistry.setServices('claude', undefined);
  ProviderWorkspaceRegistry.register('claude', {
    async initialize() { throw new Error('no CLI'); },
  });
  await expect(h.createModal().openAndWait()).resolves.toEqual({ decision: 'reject' });
  expect(Notice).toHaveBeenCalledWith('行内编辑不可用：无法启动 claude 提供商。');
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.editor.getValue()).toBe('hello world');
});

it('reports a picked provider startup failure in Chinese without sending the instruction', async () => {
  setLocale('zh-CN');
  const h = await createHarness();
  const codex = registerFakeInlineEditProvider('codex', [{ value: 'gpt', label: 'GPT' }]);
  let initialization: Promise<never> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  ProviderWorkspaceRegistry.setServices('codex', undefined);
  ProviderWorkspaceRegistry.register('codex', {
    initialize() {
      initialization = gate.then(() => { throw new Error('no CLI'); });
      return initialization;
    },
  });
  const result = h.createModal().openAndWait();
  try {
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: '编辑指令' });
    fireEvent.input(field, { target: { value: 'Make it formal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'codex' }));
    fireEvent.click(screen.getByRole('option', { name: 'GPT' }));
    await waitFor(() => expect(initialization).toBeDefined());
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.disabled).toBe(true);
    release();
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法启动 codex 提供商。'));
    await waitFor(() => expect(field.disabled).toBe(false));
    expect(field.value).toBe('Make it formal');
    expect([h.backend.sessions, codex.sessions]).toEqual([[], []]);
    expect(h.editor.getValue()).toBe('hello world');
  } finally {
    release();
    h.owner.dispose();
    await result;
    await initialization?.catch(() => {});
  }
});

it('shows a model or effort pick on the chip without waiting for it to save as the default', async () => {
  const h = await createHarness();
  const saves: Array<() => void> = [];
  const mutateSettings = h.plugin.mutateSettings;
  h.plugin.mutateSettings = (mutation) => new Promise<void>((resolve) => {
    saves.push(() => { void mutateSettings(mutation).then(resolve); });
  });
  h.createSession().show();
  fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort High' });
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Low' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort Low' });
  expect(h.plugin.settings.inlineEditModel).toBeNull();
  for (const save of saves) save();
  await waitFor(() => expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'claude', model: 'opus', reasoning: 'low' }));
});

it.each([
  ['en', 'Edit instructions', 'Select an available model in Claudian settings.'],
  ['zh-CN', '编辑指令', '请在 Claudian 设置中选择可用模型。'],
] as const)('keeps the provider for an ambiguous model pick in %s', async (locale, label, notice) => {
  setLocale(locale);
  const h = await createHarness();
  const codex = registerFakeInlineEditProvider('codex', [{ value: 'opus', label: 'Opus' }]);
  const result = h.createModal().openAndWait();
  const field = await screen.findByRole('textbox', { name: label });
  fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'codex' }));
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  // Like a new chat, a model both providers own resolves to neither.
  await waitFor(() => expect(Notice).toHaveBeenCalledWith(notice));
  expect(screen.getByRole('button', { name: 'Model: Sonnet, effort High' })).toBeDefined();
  expect(h.plugin.settings.inlineEditModel).toBeNull();
  fireEvent.input(field, { target: { value: 'Make this clearer' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(codex.sessions).toHaveLength(0);
  expect(h.backend.sessions[0].requests[0].configuration).toMatchObject({ model: 'sonnet' });
  fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
  await expect(result).resolves.toEqual({ decision: 'reject' });
});

it('refreshes file and folder suggestions when the same inline session reopens its popup', async () => {
  const h = await createHarness();
  const stat = { ctime: testDate().getTime(), mtime: testDate().getTime(), size: 1 };
  const oldFile = Object.assign(new TFile(), { path: 'Old.md', name: 'Old.md', stat });
  const oldFolder = Object.assign(new TFolder(), { path: 'OldFolder', name: 'OldFolder' });
  let inventory: Array<TFile | TFolder> = [oldFile, oldFolder];
  h.app.vault.getAllLoadedFiles = () => inventory;
  const session = h.createSession();
  session.show();
  typeInstruction('@OldF');
  expect(await screen.findByRole('option', { name: '@OldFolder/' })).toBeDefined();
  typeInstruction('@');
  const labels = () => within(screen.getByRole('listbox')).getAllByRole('option').map(option => option.textContent).sort();
  expect(labels()).toEqual(['@OldFolder/', 'Old.md']);
  typeInstruction('No trigger');
  expect(screen.getByRole('listbox').hasClass('is-visible')).toBe(false);
  expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  const currentInput = input();
  const newFile = Object.assign(new TFile(), { path: 'New.md', name: 'New.md', stat });
  const newFolder = Object.assign(new TFolder(), { path: 'NewFolder', name: 'NewFolder' });
  inventory = [newFile, oldFolder, newFolder];
  h.app.vault.trigger('delete', oldFile);
  h.app.vault.trigger('create', newFile);
  h.app.vault.trigger('create', newFolder);
  typeInstruction('@');
  expect(input()).toBe(currentInput);
  expect(labels()).toEqual(['@NewFolder/', '@OldFolder/', 'New.md']);
  expect(screen.queryByRole('option', { name: 'Old.md' })).toBeNull();
  expect(h.settled).not.toHaveBeenCalled();
  session.close();
  const later = h.createSession();
  later.show(); typeInstruction('@');
  expect(labels()).toEqual(['@NewFolder/', '@OldFolder/', 'New.md']);
  later.close();
});

it('keeps open inline suggestions anchored after note scroll and viewport resize', async () => {
  const h = await createHarness();
  h.app.vault.getAllLoadedFiles = () => [Object.assign(new TFolder(), { name: 'src', path: 'src' })];
  const session = h.createSession();
  session.show();
  let top = 320;
  let left = 80;
  const measure = vi.spyOn(input(), 'getBoundingClientRect').mockImplementation(() => ({
    top, bottom: top + 28, left, right: left + 300, width: 300, height: 28,
  } as DOMRect));
  typeInstruction('@s');
  const option = await screen.findByRole('option', { name: /src\// });
  const list = screen.getByRole('listbox', { name: 'Input suggestions' });
  expect(list.style.getPropertyValue('--claudian-fixed-dropdown-bottom')).toBe(`${window.innerHeight - top + 8}px`);
  const active = input().getAttribute('aria-activedescendant');
  measure.mockClear();
  list.scrollTop = 25;
  fireEvent.scroll(list);
  expect(measure).not.toHaveBeenCalled();
  expect(list.scrollTop).toBe(25);
  top = 210;
  fireEvent.scroll(h.editorView.scrollDOM);
  expect(list.style.getPropertyValue('--claudian-fixed-dropdown-bottom')).toBe(`${window.innerHeight - top + 8}px`);
  left = 160;
  fireEvent.resize(window);
  expect(list.style.getPropertyValue('--claudian-fixed-dropdown-left')).toBe('160px');
  expect(input().getAttribute('aria-activedescendant')).toBe(active);
  expect(within(list).getByRole('option', { name: /src\// })).toBe(option);
  expect(await axe(list)).toHaveNoViolations();
  // Hiding and session teardown both release viewport listeners.
  typeInstruction('No trigger');
  measure.mockClear();
  fireEvent.scroll(h.editorView.scrollDOM);
  fireEvent.resize(window);
  expect(measure).not.toHaveBeenCalled();
  typeInstruction('@s');
  await screen.findByRole('option', { name: /src\// });
  session.close();
  measure.mockClear();
  fireEvent.scroll(h.editorView.scrollDOM);
  fireEvent.resize(window);
  expect(measure).not.toHaveBeenCalled();
});

it('shows only the newest clarification when an older render finishes last', async () => {
  const h = await createHarness();
  const renders: Array<() => void> = [];
  vi.mocked(MarkdownRenderer.render).mockImplementation((_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
    return new Promise<void>(resolve => renders.push(resolve));
  });
  h.createSession().show();
  submitInstruction('Improve');
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('First question?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(renders).toHaveLength(1));
  submitInstruction('Formal');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
  h.backend.sessions[0].emitText('Second question?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(renders).toHaveLength(2));
  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(
    h.app, 'Second question?', expect.any(HTMLElement), h.notePath, expect.any(Component),
  );

  const container = input().closest('.claudian-inline-input-container') as HTMLElement;
  renders[1]();
  await within(container).findByText('Second question?');
  renders[0]();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  expect(within(container).getByText('Second question?')).toBeDefined();
  expect(within(container).queryByText('First question?')).toBeNull();
});

it('previews the selected source as deleted and the replacement as inserted Markdown', async () => {
  const h = await createHarness();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  h.createSession().show();
  await showReplacementPreview(h, 'Hi');
  const preview = screen.getByRole('toolbar', { name: 'Inline edit actions' }).parentElement!;
  await waitFor(() => expect(Array.from(preview.querySelectorAll('.claudian-diff-block'), block => [
    block.classList.contains('claudian-diff-del') ? 'delete' : block.classList.contains('claudian-diff-ins') ? 'insert' : 'equal',
    block.textContent,
  ])).toEqual([['delete', 'hello'], ['insert', 'Hi']]));
  // The previewed source is hidden from the editor until the edit settles.
  expect(h.editorView.contentDOM.textContent).toBe(`${preview.textContent} world`);
});

it('releases Markdown resources when clarification previews are replaced and the edit closes', async () => {
  const h = await createHarness();
  const released: string[] = [];
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element, _path, component) => {
    component.register(() => released.push(markdown));
    (element as HTMLElement).textContent = markdown;
  });
  const session = h.createSession();
  session.show();
  submitInstruction('Improve');
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('First question?');
  h.backend.sessions[0].complete();
  await screen.findByText('First question?');
  expect(released).toEqual([]);
  submitInstruction('Formal');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
  h.backend.sessions[0].emitText('Second question?');
  h.backend.sessions[0].complete();
  await screen.findByText('Second question?');
  expect(released).toEqual(['First question?']);
  session.close();
  expect(released).toEqual(['First question?', 'Second question?']);
  expect(screen.queryByRole('textbox', { name: 'Edit instructions' })).toBeNull();
});

it('releases late Markdown registrations after a preview is rejected', async () => {
  const h = await createHarness();
  const released = vi.fn();
  const childReleased = vi.fn();
  let finishRender!: () => void;
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, _markdown, _element, _path, component) => {
    await new Promise<void>(resolve => { finishRender = resolve; });
    component.register(released);
    const child = new Component();
    child.register(childReleased);
    component.addChild(child);
  });
  const session = h.createSession();
  session.show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('Which tone?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(finishRender).toBeDefined());
  session.reject();
  finishRender();
  await waitFor(() => expect(released).toHaveBeenCalledTimes(1));
  expect(childReleased).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Which tone?')).toBeNull();
});

it('releases both Markdown diff documents when review is rejected', async () => {
  const h = await createHarness();
  const released: string[] = [];
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element, _path, component) => {
    component.register(() => released.push(markdown));
    (element as HTMLElement).textContent = markdown;
  });
  const session = h.createSession();
  session.show();
  await showReplacementPreview(h, 'Hi');
  await screen.findByText('Hi');
  expect(released).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Reject inline edit' }));
  expect(released).toEqual(['hello', 'Hi']);
  expect(screen.queryByRole('toolbar', { name: 'Inline edit actions' })).toBeNull();
});

it('keeps the floating model menu inside the viewport near the top and after scrolling', async () => {
  const h = await createHarness();
  h.createSession().show();
  const chip = screen.getByRole('button', { name: 'Model: Sonnet, effort High' });
  const menu = document.querySelector<HTMLElement>('.claudian-model-popover')!;
  let chipTop = 24;
  const bounds = () => {
    const cap = Number.parseFloat(menu.style.getPropertyValue('--claudian-toolbar-popover-max-height')) || 196;
    const height = Math.min(196, cap);
    const topValue = menu.style.getPropertyValue('--claudian-toolbar-popover-top');
    const top = topValue && topValue !== 'auto' ? Number.parseFloat(topValue)
      : window.innerHeight - Number.parseFloat(menu.style.getPropertyValue('--claudian-toolbar-popover-bottom')) - height;
    return { top, bottom: top + height };
  };
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 100, right: 200, width: 100, height } as DOMRect);
  vi.spyOn(chip, 'getBoundingClientRect').mockImplementation(() => rect(chipTop, 28));
  const measureMenu = vi.spyOn(menu, 'getBoundingClientRect').mockImplementation(() => rect(0, menu.hidden ? 0 : 196));
  fireEvent.click(chip);
  expect(screen.getByRole('dialog', { name: 'Model options' })).toBe(menu);
  expect(bounds().top).toBeGreaterThanOrEqual(8);
  expect(bounds().bottom).toBeLessThanOrEqual(window.innerHeight - 8);
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-top')).toBe('60px');
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-bottom')).toBe('auto');
  // The chip's chevron points toward the side the menu opened on.
  expect(chip.getAttribute('data-menu-placement')).toBe('below');
  const limitBelow = window.innerHeight - 52 - 8 - 8;
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-max-height')).toBe(`${limitBelow}px`);
  expect((await axe(menu)).violations).toEqual([]);
  fireEvent.click(within(menu).getByRole('option', { name: 'Opus' }));
  await waitFor(() => expect(h.plugin.settings.inlineEditModel?.model).toBe('opus'));
  measureMenu.mockClear();
  const placement = menu.style.cssText;
  fireEvent.scroll(within(menu).getByRole('listbox', { name: 'Model' }));
  expect(measureMenu).not.toHaveBeenCalled();
  expect(menu.style.cssText).toBe(placement);
  chipTop = window.innerHeight - 60;
  fireEvent.scroll(window);
  expect(measureMenu).toHaveBeenCalledTimes(1);
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-top')).toBe('auto');
  expect(menu.style.getPropertyValue('--claudian-toolbar-popover-bottom')).toBe('68px');
  expect(chip.hasAttribute('data-menu-placement')).toBe(false);
  const viewport = window.innerHeight;
  window.innerHeight = 120;
  try {
    chipTop = 24;
    fireEvent.resize(window);
    expect(menu.style.getPropertyValue('--claudian-toolbar-popover-max-height')).toBe('52px');
    expect(bounds().top).toBeGreaterThanOrEqual(8);
    expect(bounds().bottom).toBeLessThanOrEqual(window.innerHeight - 8);
  } finally {
    window.innerHeight = viewport;
  }
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(menu.hidden).toBe(true);
  expect(document.activeElement).toBe(chip);
});

it.each([
  'Use `</replacement>` literally in XML.',
  'Document <replacement>old</replacement> and <insertion>new</insertion>.',
])('applies the complete raw replacement containing wrapper text: %s', async replacement => {
  const h = await createHarness();
  h.createSession().show();
  const accept = await showReplacementPreview(h, replacement);
  expect(h.backend.sessions[0].requests[0].configuration.systemInstructions).toMatchObject({
    instructions: expect.stringContaining('with no explanation outside the tag'),
  });
  expect((await axe(screen.getByRole('toolbar', { name: 'Inline edit actions' }))).violations).toEqual([]);
  fireEvent.click(accept);
  expect(h.editorView.state.doc.toString()).toBe(`${replacement} world`);
  expect(h.settled).toHaveBeenCalledWith({ decision: 'accept', editedText: replacement });
});

it.each([false, true].flatMap(alreadyOpen => [
  { alreadyOpen, target: 'target#Overview', label: 'Target', path: 'target', samePage: false },
  { alreadyOpen, target: '#Overview', label: 'Overview', path: '', samePage: true },
  { alreadyOpen, target: '#^quote-of-the-day', label: 'Quote', path: '', samePage: true },
]))('opens inline-code $target from the edited note context (already open: $alreadyOpen)', async ({ alreadyOpen, target, label, path, samePage }) => {
  const h = await createHarness();
  const sourcePath = 'Section/note.md';
  const file = Object.assign(new TFile(), { path: samePage ? sourcePath : 'Section/target.md', basename: samePage ? 'note' : 'target' });
  h.app.vault.getAbstractFileByPath = vi.fn((path: string) => path === sourcePath ? file : null);
  const leaf = Object.assign(new WorkspaceLeaf(), { getViewState: () => ({ type: 'markdown', state: { file: file.path } }), setEphemeralState: vi.fn() });
  const unrelated = Object.assign(new WorkspaceLeaf(), { getViewState: () => ({ type: 'markdown', state: { file: 'Elsewhere/target.md' } }), setEphemeralState: vi.fn() });
  h.app.metadataCache.getFirstLinkpathDest = vi.fn((_path: string, source: string) => source === sourcePath ? file : Object.assign(new TFile(), { path: 'Elsewhere/target.md' }));
  Object.assign(h.app.workspace, {
    iterateAllLeaves: (visit: (entry: typeof leaf) => void) => [unrelated, ...(alreadyOpen ? [leaf] : [])].forEach(visit),
    revealLeaf: vi.fn().mockResolvedValue(undefined),
    openLinkText: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<typeof h.app.workspace>);
  const rendered: string[] = [];
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    rendered.push(markdown);
    const code = element.createEl('code');
    code.textContent = `[[${target}|${label}]]`;
  });
  const session = new InlineEditSession(h.app, h.plugin, h.component, h.editorView, h.editor,
    { mode: 'selection', selectedText: 'hello' }, sourcePath, h.settled, { providerId: 'claude' });
  try {
    session.show();
    submitInstruction();
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    h.backend.sessions[0].emitText(`Check \`[[${target}|${label}]]\`.`);
    h.backend.sessions[0].complete();
    const link = await screen.findByRole('link', { name: label });
    expect(rendered).toEqual([`Check \`[[${target}|${label}]]\`.`]);
    // Keep jsdom navigation out of the host-boundary assertion.
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(alreadyOpen ? h.app.workspace.revealLeaf : h.app.workspace.openLinkText).toHaveBeenCalledTimes(1));
    expect(vi.mocked(h.app.workspace.revealLeaf).mock.calls).toEqual(alreadyOpen ? [[leaf]] : []);
    expect(leaf.setEphemeralState.mock.calls).toEqual(alreadyOpen ? [[{ focus: true, subpath: target.slice(path.length) }]] : []);
    expect(vi.mocked(h.app.workspace.openLinkText).mock.calls).toEqual(alreadyOpen ? [] : [[target, sourcePath, 'tab']]);
    const destinationReads = samePage ? vi.mocked(h.app.vault.getAbstractFileByPath).mock.calls
      : vi.mocked(h.app.metadataCache.getFirstLinkpathDest).mock.calls;
    expect(destinationReads).toContainEqual(samePage ? [sourcePath] : [path, sourcePath]);
    expect(await axe(link)).toHaveNoViolations();
    session.close();
    fireEvent.click(link);
    expect(alreadyOpen ? h.app.workspace.revealLeaf : h.app.workspace.openLinkText).toHaveBeenCalledTimes(1);
  } finally { session.close(); }
});
