/** @jest-environment jsdom */
import {
  createInlineEditHarness as createHarness,
  disposeInlineEditHarnesses,
  instructionInput as input,
  registerFakeInlineEditProvider,
  showReplacementPreview,
  submitInstruction,
  typeInstruction,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, MarkdownRenderer, Notice, TFolder } from 'obsidian';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';

afterEach(async () => {
  await disposeInlineEditHarnesses();
  jest.mocked(MarkdownRenderer.render).mockReset();
  jest.clearAllMocks();
  // Held provider starts must not outlive their test.
  jest.restoreAllMocks();
});

describe('editor resolution', () => {
  it('opens on the view editor when the callback editor has no CodeMirror view', async () => {
    const h = createHarness();
    const result = h.createModal({}, h.editor).openAndWait();
    expect(await screen.findByRole('textbox', { name: 'Edit instructions' })).toBeDefined();
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });

  it('rejects with a notice when neither editor exposes a CodeMirror view', async () => {
    const h = createHarness();
    await expect(h.createModal({}, {}).openAndWait()).resolves.toEqual({ decision: 'reject' });
    expect(Notice).toHaveBeenCalledWith(
      'Inline edit unavailable: could not access the active editor. Try reopening the note.',
    );
    expect(screen.queryByRole('textbox', { name: 'Edit instructions' })).toBeNull();
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
    const h = createHarness();
    const codex = registerFakeInlineEditProvider('codex');
    h.plugin.settings = settings;
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
  jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockImplementation((host, providerId, reason) => {
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
  const h = createHarness();
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
  await new Promise(resolve => window.setTimeout(resolve, 0));
  expect([h.backend.sessions, codex.sessions]).toEqual([[], []]);
  codexStart.finish();

  await waitFor(() => expect(codex.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.sessions).toHaveLength(0);
  expect(codex.sessions[0].requests[0].configuration).toMatchObject({ model: 'gpt', reasoning: 'low' });
  // The instruction typed before the switch survives the composer's rebuild.
  expect(codex.sessions[0].requests[0].input[0]).toMatchObject({ text: expect.stringContaining('Make it formal') });
  expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'codex', model: 'gpt', reasoning: 'low' });

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
});

describe('a submit waiting for a picked provider to start', () => {
  /** Opens an edit with codex registered, whose start is held until the returned controls settle it. */
  async function openWithHeldCodexStart() {
    const h = createHarness();
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

it('shows a model or effort pick on the chip without waiting for it to save as the default', async () => {
  const h = createHarness();
  const saves: Array<() => void> = [];
  const mutateSettings = h.plugin.mutateSettings;
  h.plugin.mutateSettings = (mutation: (settings: Record<string, unknown>) => void) => new Promise<void>((resolve) => {
    saves.push(() => { void mutateSettings(mutation).then(resolve); });
  });
  h.createSession().show();
  fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort High' });
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Low' }));
  await screen.findByRole('button', { name: 'Model: Opus, effort Low' });
  expect(h.plugin.settings.inlineEditModel).toBeUndefined();
  for (const save of saves) save();
  await waitFor(() => expect(h.plugin.settings.inlineEditModel).toEqual({ providerId: 'claude', model: 'opus', reasoning: 'low' }));
});

it('keeps the provider when a picked model is not uniquely owned by one enabled provider', async () => {
  const h = createHarness();
  const codex = registerFakeInlineEditProvider('codex', [{ value: 'opus', label: 'Opus' }]);
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet, effort High' }));
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Provider' })).getByRole('tab', { name: 'codex' }));
  fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
  // Like a new chat, a model both providers own resolves to neither.
  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Select an available model in Claudian settings.'));
  expect(screen.getByRole('button', { name: 'Model: Sonnet, effort High' })).toBeDefined();
  expect(h.plugin.settings.inlineEditModel).toBeUndefined();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(codex.sessions).toHaveLength(0);
  expect(h.backend.sessions[0].requests[0].configuration).toMatchObject({ model: 'sonnet' });
  fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
  await expect(result).resolves.toEqual({ decision: 'reject' });
});

it('suggests Vault folders for @ mentions', async () => {
  const h = createHarness();
  h.app.vault.getAllLoadedFiles = () => [Object.assign(new TFolder(), { name: 'src', path: 'src' })];
  h.createSession().show();
  typeInstruction('@s');
  expect(await screen.findByRole('option', { name: /src\// })).toBeDefined();
});

it('shows only the newest clarification when an older render finishes last', async () => {
  const h = createHarness();
  const renders: Array<() => void> = [];
  jest.mocked(MarkdownRenderer.render).mockImplementation((_app, markdown, element) => {
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
  const h = createHarness();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
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
  const h = createHarness();
  const released: string[] = [];
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element, _path, component) => {
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
  const h = createHarness();
  const released = jest.fn();
  const childReleased = jest.fn();
  let finishRender!: () => void;
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, _markdown, _element, _path, component) => {
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
  const h = createHarness();
  const released: string[] = [];
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element, _path, component) => {
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
  const h = createHarness();
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
  jest.spyOn(chip, 'getBoundingClientRect').mockImplementation(() => rect(chipTop, 28));
  const measureMenu = jest.spyOn(menu, 'getBoundingClientRect').mockImplementation(() => rect(0, menu.hidden ? 0 : 196));
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
  const viewport = jest.replaceProperty(window, 'innerHeight', 120);
  try {
    chipTop = 24;
    fireEvent.resize(window);
    expect(menu.style.getPropertyValue('--claudian-toolbar-popover-max-height')).toBe('52px');
    expect(bounds().top).toBeGreaterThanOrEqual(8);
    expect(bounds().bottom).toBeLessThanOrEqual(window.innerHeight - 8);
  } finally {
    viewport.restore();
  }
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(menu.hidden).toBe(true);
  expect(document.activeElement).toBe(chip);
});

it.each([
  'Use `</replacement>` literally in XML.',
  'Document <replacement>old</replacement> and <insertion>new</insertion>.',
])('applies the complete raw replacement containing wrapper text: %s', async replacement => {
  const h = createHarness();
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


it.each([false, true])('opens inline-code file links from a clarification in the edited note context (already open: %s)', async alreadyOpen => {
  const h = createHarness();
  const sourcePath = 'Section/note.md';
  const file = { path: 'Section/target.md' };
  const leaf = { getViewState: () => ({ state: { file: file.path } }), setEphemeralState: jest.fn() };
  const unrelated = { getViewState: () => ({ state: { file: 'Elsewhere/target.md' } }), setEphemeralState: jest.fn() };
  h.app.metadataCache = { getFirstLinkpathDest: jest.fn((_path: string, source: string) => source === sourcePath ? file : { path: 'Elsewhere/target.md' }) };
  h.app.workspace = {
    iterateAllLeaves: (visit: (entry: typeof leaf) => void) => [unrelated, ...(alreadyOpen ? [leaf] : [])].forEach(visit),
    revealLeaf: jest.fn().mockResolvedValue(undefined),
    openLinkText: jest.fn().mockResolvedValue(undefined),
  };
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    expect(markdown).toBe('Check `[[target#Overview|Target]]`.');
    const code = element.createEl('code');
    code.textContent = '[[target#Overview|Target]]';
  });
  const session = new InlineEditSession(h.app, h.plugin, h.plugin, h.editorView, h.editor,
    { mode: 'selection', selectedText: 'hello' }, sourcePath, h.settled, { providerId: 'claude' });
  try {
    session.show();
    submitInstruction();
    await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
    h.backend.sessions[0].emitText('Check `[[target#Overview|Target]]`.');
    h.backend.sessions[0].complete();
    const link = await screen.findByRole('link', { name: 'Target' });
    // Keep jsdom navigation out of the host-boundary assertion.
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(alreadyOpen ? h.app.workspace.revealLeaf : h.app.workspace.openLinkText).toHaveBeenCalledTimes(1));
    expect(h.app.workspace.revealLeaf.mock.calls).toEqual(alreadyOpen ? [[leaf]] : []);
    expect(leaf.setEphemeralState.mock.calls).toEqual(alreadyOpen ? [[{ focus: true, subpath: '#Overview' }]] : []);
    expect(h.app.workspace.openLinkText.mock.calls).toEqual(alreadyOpen ? [] : [['target#Overview', sourcePath, 'tab']]);
    expect(h.app.metadataCache.getFirstLinkpathDest).toHaveBeenLastCalledWith('target', sourcePath);
    expect(await axe(link)).toHaveNoViolations();
    session.close();
    fireEvent.click(link);
    expect(alreadyOpen ? h.app.workspace.revealLeaf : h.app.workspace.openLinkText).toHaveBeenCalledTimes(1);
  } finally { session.close(); }
});
