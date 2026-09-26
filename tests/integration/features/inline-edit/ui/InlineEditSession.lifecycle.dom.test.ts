/** @jest-environment jsdom */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FakeAuxiliaryBackend } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer, Notice } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderRegistration } from '@/core/providers/types';
import { InlineEditSessionOwner } from '@/features/inline-edit/InlineEditSessionOwner';
import { InlineEditModal, InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';

Object.assign(HTMLElement.prototype, {
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  setCssProps(this: HTMLElement, props: Record<string, string>) {
    for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
  },
  scrollIntoView() {},
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await ProviderWorkspaceRegistry.disposeInitialized();
  document.body.replaceChildren();
  jest.clearAllMocks();
});

function createHarness() {
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeAuxiliaryBackend();
  const owner = new InlineEditSessionOwner();
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.setServices('claude', {});
  ProviderRegistry.register('claude', {
    capabilities: { supportsEphemeralSessions: true },
    createExecutionBackend: () => backend,
    isEnabled: () => true,
  } as unknown as ProviderRegistration);
  const app: any = {
    vault: { adapter: { basePath: '/vault' }, getFiles: () => [], getAllLoadedFiles: () => [] },
  };
  const plugin: any = {
    settings: {},
    providerHost: {
      app,
      storage: { getAdapter: () => ({}) },
      executionLifecycleRegistry: lifecycle,
      runProviderExecutionTransition: lifecycle.runTransition.bind(lifecycle),
    },
  };
  const editorView = new EditorView({
    state: EditorState.create({ doc: 'hello world' }),
    parent: document.body,
    extensions: EditorView.contentAttributes.of({ 'aria-label': 'Note editor' }),
  });
  let end = 5;
  const editor: any = {
    cm: editorView,
    getCursor: (which: string) => ({ line: 0, ch: which === 'from' ? 0 : end }),
    getSelection: () => 'hello world'.slice(0, end),
    replaceRange: (text: string) => editorView.dispatch({ changes: { from: 0, to: end, insert: text } }),
  };
  const context = { mode: 'selection' as const, selectedText: 'hello' };
  const settled = jest.fn();
  const createSession = () => new InlineEditSession(
    app, plugin, editorView, editor, context, 'note.md', settled, { providerId: 'claude' },
  );
  const createModal = () => new InlineEditModal(app, plugin, editor, { editor } as any, context, 'note.md', owner);
  cleanups.push(async () => {
    owner.dispose();
    editorView.destroy();
    await lifecycle.dispose();
  });
  return {
    app, backend, createModal, createSession, editorView, owner, plugin, settled,
    changeSelection() { end = 11; fireEvent.mouseUp(editorView.dom); },
  };
}

function input(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Edit instructions' }) as HTMLInputElement;
}

function typeInstruction(text: string): void {
  fireEvent.input(input(), { target: { value: text } });
}

function submitInstruction(text = 'Make this clearer'): void {
  typeInstruction(text);
  fireEvent.keyDown(input(), { key: 'Enter' });
}

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

it('retains clarification when CodeMirror releases and later recreates the input widget', async () => {
  const h = createHarness();
  const session = h.createSession();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  session.show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  // WidgetType.destroy/toDOM are CodeMirror's viewport resource callbacks.
  const oldContainer = input().parentElement!.parentElement!;
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

it('keeps the edit alive across preview replacement and applies only explicit acceptance', async () => {
  const h = createHarness();
  const result = h.createModal().openAndWait();
  await screen.findByRole('textbox', { name: 'Edit instructions' });
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('<replacement>Hi</replacement>');
  h.backend.sessions[0].complete();
  const accept = await screen.findByRole('button', { name: 'Accept inline edit' });
  expect(h.editorView.state.doc.toString()).toBe('hello world');
  expect(await axe(screen.getByRole('toolbar', { name: 'Inline edit actions' }))).toHaveNoViolations();
  fireEvent.click(accept);
  await expect(result).resolves.toEqual({ decision: 'accept', editedText: 'Hi' });
  expect(h.editorView.state.doc.toString()).toBe('Hi world');
  expect(h.backend.sessions[0].getStatus()).toBe('disposed');
});

it('continues provider execution when vault mentions cannot load and reports one notice', async () => {
  const h = createHarness();
  h.app.vault.getFiles = () => { throw new Error('vault unavailable'); };
  h.createSession().show();
  submitInstruction('Improve @missing');
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  expect((Notice as unknown as jest.Mock).mock.calls).toEqual([
    ['Failed to load vault files. Vault @-mentions may be unavailable.'],
  ]);
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
    setCommandSnapshot: () => {},
    refresh: async () => {},
  };
  ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog });
  h.plugin.settings.hiddenProviderCommands = { claude: ['analyze'], codex: ['visible'] };
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
