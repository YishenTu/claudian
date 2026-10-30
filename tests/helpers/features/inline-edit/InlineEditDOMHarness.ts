import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FakeAuxiliaryBackend } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianEditor } from '@test/helpers/ObsidianEditor';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { App, Component, type Editor, MarkdownView, WorkspaceLeaf } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderChatUIConfig, ProviderId, ProviderModelPolicy, ProviderRegistration, ProviderSettingsStorageAdapter } from '@/core/providers/types';
import { InlineEditSessionOwner } from '@/features/inline-edit/InlineEditSessionOwner';
import { InlineEditModal, InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';
import { CLAUDE_PROVIDER_ICON } from '@/shared/icons';

const cleanups: Array<() => Promise<void>> = [];
/** The registry cannot unregister, so fake providers stay enabled only in the test that registered them. */
let harnessGeneration = 0;

/** Call from `afterEach` in every suite that creates Inline Edit harnesses. */
export async function disposeInlineEditHarnesses(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  harnessGeneration += 1;
  await ProviderWorkspaceRegistry.disposeInitialized();
  document.body.replaceChildren();
}

function isProviderEnabled(providerId: ProviderId, settings: Record<string, unknown>): boolean {
  const configs = settings.providerConfigs as Record<string, { enabled?: boolean }> | undefined;
  return configs?.[providerId]?.enabled !== false;
}

type FakeModel = { value: string; label: string };

/** Two efforts, and by default two models: enough to drive the composer's model chip. */
const createFakeModelPolicy = (
  models: FakeModel[] = [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
): ProviderModelPolicy => ({
  getModelOptions: () => models,
  ownsModel: model => models.some(option => option.value === model),
  supportsReasoningEffort: () => true,
  getReasoningOptions: () => [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  getDefaultReasoningValue: () => 'high',
  isDefaultModel: () => true,
  applyModelDefaults: () => {},
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
});

/**
 * Registers a provider whose auxiliary sessions are fakes; enablement follows `settings.providerConfigs`.
 * `ui` overrides its chat UI config, such as its reasoning options or model metadata hook.
 */
export function registerFakeInlineEditProvider(
  providerId: ProviderId,
  models?: FakeModel[],
  ui: Partial<ProviderChatUIConfig> = {},
): FakeAuxiliaryBackend {
  const backend = new FakeAuxiliaryBackend();
  const fakeModelPolicy = createFakeModelPolicy(models);
  const generation = harnessGeneration;
  const unsupported = (): never => { throw new Error('Inline edit provider fixture does not model history or task interpretation'); };
  ProviderWorkspaceRegistry.setServices(providerId, {});
  const registration = {
    blankTabOrder: 0,
    displayName: providerId,
    capabilities: {
      providerId, supportsEphemeralSessions: true, supportsProviderCommands: true, reasoningControl: 'effort',
      supportsNativeHistory: false, supportsRewind: false, supportsFork: false, supportsImageAttachments: false,
    },
    chatUIConfig: { ...fakeModelPolicy, getProviderIcon: () => CLAUDE_PROVIDER_ICON, ...ui },
    modelPolicy: fakeModelPolicy,
    settingsStorage: { normalizeStored: () => false },
    createExecutionBackend: () => backend,
    settingsReconciler: {
      invalidateConversationSessions: unsupported,
      reconcileModelWithEnvironment: unsupported,
    },
    historyService: {
      hydrateConversationHistory: unsupported,
      resolveSessionIdForConversation: unsupported,
      isPendingForkConversation: unsupported,
      buildForkProviderState: unsupported,
    },
    taskResultInterpreter: {
      describeTask: unsupported, interpretLaunch: unsupported,
      getOutputTaskId: unsupported, interpretResult: unsupported,
    },
    isEnabled: (settings: Record<string, unknown>) => (
      generation === harnessGeneration && isProviderEnabled(providerId, settings)
    ),
  } satisfies ProviderRegistration & { settingsStorage: ProviderSettingsStorageAdapter };
  ProviderRegistry.register(providerId, registration);
  return backend;
}

/** A real CodeMirror editor on `hello world` whose Obsidian editor selects `hello` until `changeSelection`. */
export async function createInlineEditHarness() {
  const owner = new InlineEditSessionOwner();
  ProviderWorkspaceRegistry.clear();
  const backend = registerFakeInlineEditProvider('claude');
  const app = new App();
  const fixture = await createFeatureHostFixture({
    app, settings: { model: 'sonnet', effortLevel: 'high', inlineEditModel: null, providerConfigs: {} },
  });
  const plugin = fixture.host;
  const component = new Component();
  component.load();
  const editorView = new EditorView({
    state: EditorState.create({ doc: 'hello world' }),
    parent: document.body,
    extensions: EditorView.contentAttributes.of({ 'aria-label': 'Note editor' }),
  });
  let end = 5;
  const editor: Editor & { cm: EditorView } = Object.assign(createObsidianEditor(editorView), {
    cm: editorView,
    getCursor: (which = 'head') => ({ line: 0, ch: which === 'from' ? 0 : end }),
    getSelection: () => 'hello world'.slice(0, end),
    replaceRange: (text: string) => editorView.dispatch({ changes: { from: 0, to: end, insert: text } }),
  });
  const context = { mode: 'selection' as const, selectedText: 'hello' };
  const settled = vi.fn();
  const notePath = 'note.md';
  const createSession = () => new InlineEditSession(
    app, plugin, component, editorView, editor, context, notePath, settled, { providerId: 'claude' },
  );
  /** Mirrors Obsidian's editorCallback: a callback editor plus the view that owns the current editor. */
  const createModal = (callbackEditor: Editor = editor, viewEditor: Editor = editor) => {
    const view = new MarkdownView(new WorkspaceLeaf());
    view.editor = viewEditor;
    return new InlineEditModal(app, plugin, component, callbackEditor, view, context, notePath, owner);
  };
  cleanups.push(async () => {
    owner.dispose();
    editorView.destroy();
    component.unload();
    await fixture.dispose();
  });
  return {
    app, backend, component, createModal, createSession, editor, editorView, notePath, owner, plugin, settled,
    settingsStorage: fixture.settingsStorage,
    changeSelection() { end = 11; fireEvent.mouseUp(editorView.dom); },
  };
}

export type InlineEditHarness = Awaited<ReturnType<typeof createInlineEditHarness>>;

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
