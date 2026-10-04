import { createConversationPorts, createTestTabSession, holdResponse } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';

import type { ProviderExecutionEvent } from '@/core/execution';
import { BuiltInCommandController, type BuiltInCommandControllerDeps } from '@/features/chat/controllers/BuiltInCommandController';
import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabSession } from '@/features/chat/tabs/TabSession';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

function createInput(): ComposerInputElement {
  return {
    dispatchEvent: jest.fn().mockReturnValue(true),
    focus: jest.fn(),
    value: '',
  } as unknown as ComposerInputElement;
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

export async function waitForCall(mock: jest.Mock): Promise<void> {
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

export function createFixture(overrides: Record<string, unknown> = {}) {
  const {
    onReviewableSettlement,
    ...dependencyOverrides
  } = overrides;
  // The real turn owner, unless a test supplies the tab session it drains or closes.
  const session: TabSession = (dependencyOverrides.session as TabSession | undefined) ?? createTestTabSession({
    getState: () => state,
    coordinator: { cancel: () => deps.getExecutionCoordinator()?.cancel() },
    dismissInteractions: () => controller.dismissPendingApproval(),
  });
  const state: ChatState = new ChatState({}, undefined, session.turns);
  state.currentConversationId = 'conversation-1';
  const input = createInput();
  const queueIndicator = createMockEl();
  state.queueIndicatorEl = queueIndicator as any;
  let id = 0;
  const coordinator = {
    acceptSteerFromProviderEvent: jest.fn().mockResolvedValue(true),
    cancel: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({
      accepted: true,
      status: 'completed',
    }),
    releaseSteerCorrelation: jest.fn(),
    state: 'idle',
    steer: jest.fn().mockResolvedValue(true),
  };
  const plugin = {
    getSessionSnapshotDirectory: () => '/tmp/claudian-sessions',
    createConversation: jest.fn(),
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getConversationSync(id); },
    getConversationSync: jest.fn().mockReturnValue({
      id: 'conversation-1',
      providerId: 'claude',
    }),
    renameConversation: jest.fn().mockResolvedValue(undefined),
    rewriteLinkedContentPaths: jest.fn().mockResolvedValue(undefined),
    settings: {
      enableAutoTitleGeneration: false,
      titleGenerationModel: '',
      permissionMode: 'normal',
    },
    updateConversation: jest.fn().mockResolvedValue(undefined),
  };
  const linkedContentToken = Object.freeze({}) as { readonly path?: string };
  const linkedContentController = {
    beginSubmission: jest.fn().mockReturnValue(linkedContentToken),
    commitSubmission: jest.fn().mockReturnValue({ queuedEvents: [] }),
    getSnapshot: jest.fn().mockReturnValue({
      content: null,
      mode: 'locked',
      path: null,
    }),
    resetAutoDraft: jest.fn(),
    rollbackSubmission: jest.fn(),
  };
  const deps = {
    plugin,
    state,
    renderer: {
      addMessage: jest.fn().mockImplementation(() => {
        const el = createMockEl();
        el.createDiv({ cls: 'claudian-message-content' });
        return el;
      }),
      appendInterruptIndicator: jest.fn(),
      refreshActionButtons: jest.fn(),
      finalizeResponse: jest.fn(),
      removeMessage: jest.fn(),
    },
    streamController: {
      resetSubagentStreamingState: jest.fn(),
      appendText: jest.fn(),
      appendError: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      resumeThinkingIndicator: jest.fn(),
      showThinkingIndicator: jest.fn(),
    },
    selectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    browserSelectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    canvasSelectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    getInputEl: () => input,
    getInputContainerEl: () => createMockEl() as any,
    getWelcomeEl: () => null,
    getMessagesEl: () => createMockEl() as any,
    getLinkedContentController: () => linkedContentController as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
      getAttachedImages: jest.fn().mockReturnValue([]),
      hasImages: jest.fn().mockReturnValue(false),
      setImages: jest.fn(),
    }) as any,
    getTitleGenerationService: () => null,
    generateId: () => `id-${++id}`,
    getSettings: () => ({ model: 'claude-model', reasoning: 'high', permissionMode: 'normal', serviceTier: 'standard' }),
    getExecutionCoordinator: () => coordinator,
    getSubagentManager: () => ({
      resetSpawnedCount: jest.fn(),
      resetStreamingState: jest.fn(),
    }) as any,
    getTabProviderId: () => 'claude',
    ensureExecutionInitialized: jest.fn().mockResolvedValue(true),
    ...dependencyOverrides,
    ...(typeof onReviewableSettlement === 'function'
      ? {
          captureReviewableSettlement: jest.fn(
            () => onReviewableSettlement as () => void,
          ),
        }
      : {}),
  } as unknown as InputControllerDeps;
  const ports = createConversationPorts({ ...(deps as any), session });
  // Conversation creation stays real; persistence and reset are observed at their boundary.
  const conversationController = new ConversationController({
    plugin: plugin as any, state, renderer: deps.renderer, drafts: ports.drafts, session,
    subagentManager: { orphanAllActive: jest.fn(), clear: jest.fn() } as any,
    getWelcomeEl: () => null, setWelcomeEl: () => undefined, getMessagesEl: deps.getMessagesEl,
    getLinkedContentController: () => deps.getLinkedContentController(),
    clearQueuedMessage: () => controller.clearQueuedMessage(),
    getExecutionCoordinator: () => deps.getExecutionCoordinator(),
  });
  jest.spyOn(conversationController, 'save').mockResolvedValue(undefined);
  jest.spyOn(conversationController, 'createNew').mockResolvedValue(undefined);
  const commandOverrides = Object.fromEntries(
    (['openConversation', 'handleNewConversationCommand', 'onForkAll', 'toggleFastMode'] as const)
      .filter(key => key in dependencyOverrides)
      .map(key => [key, dependencyOverrides[key]]),
  ) as Partial<BuiltInCommandControllerDeps>;
  const builtInCommands = new BuiltInCommandController({
    plugin,
    // Tests may replace the conversation owner after construction.
    get conversationController() { return deps.conversationController; },
    getLinkedContentController: () => deps.getLinkedContentController(),
    getCurrentConversationId: () => state.currentConversationId,
    getInputContainerEl: () => deps.getInputContainerEl(),
    getInputEl: () => deps.getInputEl(),
    getSideChatController: () => deps.getSideChatController?.() ?? null,
    ...commandOverrides,
  });
  Object.assign(deps, { drafts: ports.drafts, session, builtInCommands });
  if (!('conversationController' in dependencyOverrides)) Object.assign(deps, { conversationController });
  const controller = new InputController(deps);
  return {
    builtInCommands,
    controller,
    coordinator,
    deps,
    /** Holds a running provider turn open until the returned release settles it. */
    holdResponse: () => holdResponse(session.turns),
    input,
    linkedContentController,
    plugin,
    session,
    state,
  };
}
