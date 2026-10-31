import '@/providers';

import { createHarness as createExecutionHarness, createSubmission, type FakeRun, FakeSession, type UnscopedExecutionEvent } from '@test/helpers/ChatExecutionHarness';
import { createConversationPorts, createTestSession } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { App, Component } from 'obsidian';
import type { Mock } from 'vitest';

import type { ProviderExecutionEvent } from '@/core/execution';
import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { BuiltInCommandController, type BuiltInCommandControllerDeps } from '@/features/chat/input/BuiltInCommandController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { InputController, type InputControllerDeps } from '@/features/chat/input/InputController';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { LinkedContentController } from '@/features/chat/linked-content';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController } from '@/features/chat/turns/StreamController';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';



function createInput(): ComposerInputElement {
  const input = document.createElement('textarea');
  vi.spyOn(input, 'focus');
  vi.spyOn(input, 'dispatchEvent');
  return input;
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export async function waitForCall(mock: Mock): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length === 0; attempt++) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

export function requestedUserMessageStarted(
  content: string,
  sequence: number,
  nativeUserMessageId?: string,
): ProviderExecutionEvent {
  return {
    content,
    ...(nativeUserMessageId ? { nativeUserMessageId } : {}),
    scope: {
      executionId: 'execution-1',
      kind: 'requested',
      sequence,
      sessionInstanceId: 'session-1',
      turnId: 'turn-1',
    },
    type: 'user_message_started',
  };
}

/** Selection sources whose captured context a test sets through `getContext`. */
function createSelectionSources() {
  const source = () => ({
    clear: vi.fn(),
    getContext: vi.fn().mockReturnValue(null),
    poll: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  });
  return { browser: source(), canvas: source(), editor: source() };
}

type ChatInputFixtureOptions = Partial<Omit<InputControllerDeps, 'session' | 'renderer'>> & {
  session?: ChatSessionRuntime;
  renderer?: MessageRenderer;
  getInputContainerEl?: () => HTMLElement;
  getImageContextManager?: () => ImageContextManager | null;
  onReviewableSettlement?: () => void;
  nativeSession?: FakeSession;
  workingDirectory?: string;
} & Partial<Pick<BuiltInCommandControllerDeps, 'openConversation' | 'startNewConversation' | 'toggleFastMode'>>;

export async function createFixture(overrides: ChatInputFixtureOptions = {}) {
  const {
    onReviewableSettlement,
    nativeSession,
    workingDirectory,
    getInputContainerEl: inputContainerOverride,
    ...dependencyOverrides
  } = overrides;
  const defaultInputContainerEl = document.createElement('div');
  const getInputContainerEl = inputContainerOverride
    ?? (() => defaultInputContainerEl);
  const selectionSources = createSelectionSources();
  // The real turn owner, unless a test supplies the session it drains or closes.
  const session: ChatSessionRuntime = dependencyOverrides.session ?? createTestSession({
    getState: () => state,
    coordinator: { cancel: () => deps.getExecutionCoordinator()?.cancel() },
    dismissInteractions: () => controller.dismissPendingApproval(),
  });
  const state: ChatState = dependencyOverrides.state ?? new ChatState({}, undefined, session.turns);
  state.currentConversationId = 'conversation-1';
  const input = createInput();
  const images = new ImageContextManager(new App().keymap, document.createElement('div'), input, {});
  for (const method of ['clearImages', 'getAttachedImages', 'hasImages', 'setImages'] as const) vi.spyOn(images, method);
  const queueIndicator = document.createElement('div');
  state.queueIndicatorEl = queueIndicator;
  let id = 0;
  const providerId = dependencyOverrides.getTabProviderId?.() ?? 'claude';
  const native = nativeSession ?? new FakeSession(providerId, 'session-1');
  native.respond.mockImplementation(run => {
    run.emit({ type: 'turn_started', accepted: true });
    run.complete();
  });
  const nativeSteer = native.steerResponse;
  const plugin = vi.mocked(await createChatFeatureHost({
    createConversation: vi.fn(),
    getConversationById: vi.fn().mockResolvedValue(null),
    getConversationList: vi.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getConversationSync!(id); },
    getConversationSync: vi.fn().mockReturnValue(conversationRecord('conversation-1', { title: 'Conversation' })),
    projects: createProjectsFake([]),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    settings: {
      enableAutoTitleGeneration: false,
      titleGenerationModel: '',
      permissionMode: 'normal',
    },
    updateConversation: vi.fn().mockResolvedValue(undefined),
  }));
  const execution = createExecutionHarness({
    workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : plugin.providerHost.workingDirectory ?? undefined,
    resolveBackend: id => ({ providerId: id, createSession: () => native }),
    onRequestedEvent: event => controller.handleExecutionEvent(event),
  });
  const coordinator = Object.assign(execution.coordinator, {
    execute: vi.spyOn(execution.coordinator, 'execute'),
    steer: vi.spyOn(execution.coordinator, 'steer'),
    cancel: vi.spyOn(execution.coordinator, 'cancel'),
    acceptSteerFromProviderEvent: vi.spyOn(execution.coordinator, 'acceptSteerFromProviderEvent'),
    releaseSteerCorrelation: vi.spyOn(execution.coordinator, 'releaseSteerCorrelation'),
  });
  const linkedContentController = new LinkedContentController({
    app: plugin.app, getExcludedTags: () => [], getCachedVaultFiles: () => [], getCachedVaultFolders: () => [],
  });
  for (const method of ['beginSubmission', 'commitSubmission', 'getSnapshot', 'resetAutoDraft', 'rollbackSubmission'] as const) vi.spyOn(linkedContentController, method);
  onTestFinished(() => { images.destroy(); linkedContentController.destroy(); });
  const messagesEl = document.createElement('div');
  const subagents = new SubagentManager(() => undefined);
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  for (const method of ['addMessage', 'appendInterruptIndicator', 'refreshActionButtons', 'finalizeResponse', 'removeMessage'] as const) vi.spyOn(renderer, method);
  const streamController = new StreamController({
    plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => controller.queue.updateIndicator(),
  });
  for (const method of ['beginResponse', 'appendText', 'appendError', 'finalizeCurrentTextBlock', 'finalizeCurrentThinkingBlock', 'handleStreamChunk'] as const) vi.spyOn(streamController, method);
  const deps: Omit<InputControllerDeps, 'conversationController' | 'drafts' | 'session' | 'builtInCommands' | 'inlinePrompts'> & {
    renderer: MessageRenderer; getImageContextManager: () => ImageContextManager | null;
  } = {
    plugin,
    state,
    renderer,
    streamController,
    selections: new ComposerSelections(selectionSources),
    getInputEl: () => input,
    getWelcomeEl: () => null,
    getMessagesEl: () => messagesEl,
    getLinkedContentController: () => linkedContentController,
    getImageContextManager: () => images,
    getTitleGenerationService: () => null,
    generateId: () => `id-${++id}`,
    getSettings: () => ({ model: 'claude-model', reasoning: 'high', permissionMode: 'normal', serviceTier: 'standard' }),
    getExecutionCoordinator: () => coordinator,
    getTabProviderId: () => 'claude',
    ensureExecutionInitialized: vi.fn(async () => {
      await coordinator.bindConversation(state.currentConversationId
        ? { conversationId: state.currentConversationId, providerId } : null);
      return true;
    }),
    canStartTurn: () => true,
    isClosing: () => false,
    ...dependencyOverrides,
    ...(typeof onReviewableSettlement === 'function'
      ? {
          captureReviewableSettlement: vi.fn(
            () => onReviewableSettlement,
          ),
        }
      : {}),
  };
  const ports = createConversationPorts({ state, getInputEl: () => deps.getInputEl()!, getImageContextManager: deps.getImageContextManager, session });
  // Conversation creation stays real; persistence and reset are observed at their boundary.
  const conversationController = new ConversationController({
    plugin, state, renderer: deps.renderer, drafts: ports.drafts, session,
    subagentManager: new SubagentManager(() => undefined),
    getWelcomeEl: () => null, setWelcomeEl: () => undefined, getMessagesEl: deps.getMessagesEl,
    getLinkedContentController: () => deps.getLinkedContentController(),
    ensureExecutionInitialized: () => deps.ensureExecutionInitialized(),
    getExecutionCoordinator: () => deps.getExecutionCoordinator(),
  });
  vi.spyOn(conversationController, 'save');
  const commandOverrides = Object.fromEntries(
    (['openConversation', 'startNewConversation', 'toggleFastMode'] as const)
      .filter(key => key in dependencyOverrides)
      .map(key => [key, dependencyOverrides[key]]),
  ) as Partial<BuiltInCommandControllerDeps>;
  const openConversation = vi.fn().mockResolvedValue(undefined);
  const startNewConversation = vi.fn().mockResolvedValue(undefined);
  const builtInCommands = new BuiltInCommandController({
    plugin,
    getCurrentConversationId: () => state.currentConversationId,
    openConversation, startNewConversation,
    getInputContainerEl,
    getInputEl: () => deps.getInputEl()!,
    getSideChatController: () => deps.getSideChatController?.() ?? null,
    ...commandOverrides,
  });
  const completeDeps: InputControllerDeps & typeof deps = Object.assign(deps, {
    drafts: ports.drafts, session, builtInCommands, conversationController,
    inlinePrompts: new SessionInteractions({
      getPromptParentEl: () => getInputContainerEl().parentElement,
      getSuppressedEl: getInputContainerEl,
    }),
  }, dependencyOverrides);
  const controller = new InputController(completeDeps);
  await coordinator.bindConversation({ conversationId: 'conversation-1', providerId });
  coordinator.cancel.mockClear();
  onTestFinished(async () => {
    controller.queue.cancelScheduled();
    coordinator.cancel();
    await coordinator.dispose();
    await execution.registry.dispose();
    streamController.dispose();
    renderer.dispose();
    subagents.clear();
  });
  return {
    openConversation, startNewConversation,
    builtInCommands,
    images,
    controller,
    coordinator,
    deps: completeDeps,
    execution, native, nativeSteer,
    emit: async (run: FakeRun, event: UnscopedExecutionEvent) => {
      const sent = run.emit(event);
      await execution.waitForRequestedEvent(delivered =>
        delivered.scope.executionId === sent.scope.executionId && delivered.scope.sequence === sent.scope.sequence);
      return sent;
    },
    holdNextAuthority: () => {
      const started = deferred<void>();
      const result = deferred<void>();
      execution.repository.assertConversationExecutionAuthority.mockImplementationOnce(() => {
        started.resolve();
        return result.promise;
      });
      return { started: started.promise, resolve: result.resolve, reject: result.reject };
    },
    holdNextResponse: () => {
      const started = native.waitForRun(native.runs.length);
      native.respond.mockImplementationOnce(run => run.emit({ type: 'turn_started', accepted: true }));
      return { started };
    },
    /** Holds a running provider turn open until the returned release settles it. */
    holdResponse: async () => {
      const index = native.runs.length;
      native.respond.mockImplementationOnce(() => undefined);
      const running = session.turns.run(async signal => {
        session.turns.beginResponse();
        await coordinator.execute(createSubmission(), signal);
      });
      const run = await native.waitForRun(index);
      coordinator.execute.mockClear();
      return async () => { run.complete(); await running; };
    },
    input,
    linkedContentController,
    plugin,
    selectionSources,
    session,
    state,
  };
}
