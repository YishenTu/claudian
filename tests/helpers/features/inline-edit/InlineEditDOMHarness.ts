import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FakeAuxiliaryBackend } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId, ProviderModelPolicy, ProviderRegistration } from '@/core/providers/types';
import { InlineEditSessionOwner } from '@/features/inline-edit/InlineEditSessionOwner';
import { InlineEditModal, InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';
import { CLAUDE_PROVIDER_ICON } from '@/shared/icons';

// Obsidian augments HTMLElement; jsdom needs the subset Inline Edit uses.
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

/** Call from `afterEach` in every suite that creates Inline Edit harnesses. */
export async function disposeInlineEditHarnesses(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await ProviderWorkspaceRegistry.disposeInitialized();
  document.body.replaceChildren();
}

function isProviderEnabled(providerId: ProviderId, settings: Record<string, unknown>): boolean {
  const configs = settings.providerConfigs as Record<string, { enabled?: boolean }> | undefined;
  return configs?.[providerId]?.enabled !== false;
}

/** Two models with two effort levels, enough to drive the composer's model chip. */
const fakeModelPolicy: ProviderModelPolicy = {
  getModelOptions: () => [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
  ownsModel: model => model === 'sonnet' || model === 'opus',
  supportsReasoningEffort: () => true,
  getReasoningOptions: () => [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  getDefaultReasoningValue: () => 'high',
  isDefaultModel: () => true,
  applyModelDefaults: () => {},
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
};

/** Registers a provider whose auxiliary sessions are fakes; enablement follows `settings.providerConfigs`. */
export function registerFakeInlineEditProvider(providerId: ProviderId): FakeAuxiliaryBackend {
  const backend = new FakeAuxiliaryBackend();
  ProviderWorkspaceRegistry.setServices(providerId, {});
  ProviderRegistry.register(providerId, {
    blankTabOrder: 0,
    capabilities: { supportsEphemeralSessions: true, supportsProviderCommands: true, reasoningControl: 'effort' },
    chatUIConfig: { ...fakeModelPolicy, getProviderIcon: () => CLAUDE_PROVIDER_ICON },
    modelPolicy: fakeModelPolicy,
    createExecutionBackend: () => backend,
    isEnabled: (settings: Record<string, unknown>) => isProviderEnabled(providerId, settings),
  } as unknown as ProviderRegistration);
  return backend;
}

/** A real CodeMirror editor on `hello world` whose Obsidian editor selects `hello` until `changeSelection`. */
export function createInlineEditHarness() {
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const owner = new InlineEditSessionOwner();
  ProviderWorkspaceRegistry.clear();
  const backend = registerFakeInlineEditProvider('claude');
  const app: any = {
    vault: { adapter: { basePath: '/vault' }, getFiles: () => [], getAllLoadedFiles: () => [] },
  };
  const plugin: any = {
    settings: { model: 'sonnet', effortLevel: 'high' },
    getActiveEnvironmentVariables: () => '',
    getActiveModelSelection: () => null,
    async mutateSettings(mutation: (settings: Record<string, unknown>) => void | Promise<void>) {
      await mutation(plugin.settings);
    },
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
  const notePath = 'note.md';
  const createSession = () => new InlineEditSession(
    app, plugin, plugin, editorView, editor, context, notePath, settled, { providerId: 'claude' },
  );
  /** Mirrors Obsidian's editorCallback: a callback editor plus the view that owns the current editor. */
  const createModal = (callbackEditor: any = editor, viewEditor: any = editor) =>
    new InlineEditModal(app, plugin, plugin, callbackEditor, { editor: viewEditor } as any, context, notePath, owner);
  cleanups.push(async () => {
    owner.dispose();
    editorView.destroy();
    await lifecycle.dispose();
  });
  return {
    app, backend, createModal, createSession, editor, editorView, notePath, owner, plugin, settled,
    changeSelection() { end = 11; fireEvent.mouseUp(editorView.dom); },
  };
}

export type InlineEditHarness = ReturnType<typeof createInlineEditHarness>;

export function instructionInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Edit instructions' }) as HTMLInputElement;
}

export function typeInstruction(text: string): void {
  fireEvent.input(instructionInput(), { target: { value: text } });
}

export function submitInstruction(text = 'Make this clearer'): void {
  typeInstruction(text);
  fireEvent.keyDown(instructionInput(), { key: 'Enter' });
}

/** Submits an instruction and completes it with a replacement, returning the preview's Accept control. */
export async function showReplacementPreview(h: InlineEditHarness, replacement = 'Hi'): Promise<HTMLElement> {
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText(`<replacement>${replacement}</replacement>`);
  h.backend.sessions[0].complete();
  return screen.findByRole('button', { name: 'Accept inline edit' });
}
