import { createConversationPorts, createTestSession, holdResponse } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import type { Mock } from 'vitest';

import type { ProviderExecutionEvent } from '@/core/execution';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { BuiltInCommandController, type BuiltInCommandControllerDeps } from '@/features/chat/input/BuiltInCommandController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { InputController, type InputControllerDeps } from '@/features/chat/input/InputController';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';
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

export async function createFixture(overrides: Record<string, unknown> = {}) {
  const {
    onReviewableSettlement,
    getInputContainerEl: inputContainerOverride,
    ...dependencyOverrides
  } = overrides;
  const defaultInputContainerEl = document.createElement('div') as unknown as HTMLElement;
  const getInputContainerEl = (inputContainerOverride as (() => HTMLElement) | undefined)
    ?? (() => defaultInputContainerEl);
  const selectionSources = createSelectionSources();
  // The real turn owner, unless a test supplies the session it drains or closes.
  const session: ChatSessionRuntime = (dependencyOverrides.session as ChatSessionRuntime | undefined) ?? createTestSession({
    getState: () => state,
    coordinator: { cancel: () => deps.getExecutionCoordinator()?.cancel() },
    dismissInteractions: () => controller.dismissPendingApproval(),
  });
  const state: ChatState = (dependencyOverrides.state as ChatState | undefined) ?? new ChatState({}, undefined, session.turns);
  state.currentConversationId = 'conversation-1';
  const input = createInput();
  const queueIndicator = document.createElement('div');
  state.queueIndicatorEl = queueIndicator as any;
  let id = 0;
  const coordinator = {
    acceptSteerFromProviderEvent: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({
      accepted: true,
      status: 'completed',
    }),
    releaseSteerCorrelation: vi.fn(),
    state: 'idle',
    steer: vi.fn().mockResolvedValue({ delivery: 'accepted' }),
  };
  const plugin = vi.mocked(await createChatFeatureHost({
    createConversation: vi.fn(),
    getConversationById: vi.fn().mockResolvedValue(null),
    getConversationList: vi.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getConversationSync!(id); },
    getConversationSync: vi.fn().mockReturnValue({
      id: 'conversation-1',
      providerId: 'claude', title: 'Conversation', messages: [], sessionId: null, createdAt: Date.now(), lastActivityAt: Date.now(),
    }),
    projects: createProjectsFake([]),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    settings: {
      enableAutoTitleGeneration: false,
      titleGenerationModel: '',
      permissionMode: 'normal',
    },
    updateConversation: vi.fn().mockResolvedValue(undefined),
  }));
  const linkedContentToken = Object.freeze({}) as { readonly path?: string };
  const linkedContentController = {
    beginSubmission: vi.fn().mockReturnValue(linkedContentToken),
    commitSubmission: vi.fn().mockReturnValue({ queuedEvents: [] }),
    getSnapshot: vi.fn().mockReturnValue({
      content: null,
      mode: 'locked',
      path: null,
    }),
    resetAutoDraft: vi.fn(),
    rollbackSubmission: vi.fn(),
  };
  const deps = {
    plugin,
    state,
    renderer: {
      addMessage: vi.fn().mockImplementation(() => {
        const el = document.createElement('div');
        el.createDiv({ cls: 'claudian-message-content' });
        return el;
      }),
      appendInterruptIndicator: vi.fn(),
      refreshActionButtons: vi.fn(),
      finalizeResponse: vi.fn(),
      removeMessage: vi.fn(),
    },
    streamController: {
      beginResponse: vi.fn(),
      appendText: vi.fn(),
      appendError: vi.fn(),
      finalizeCurrentTextBlock: vi.fn(),
      finalizeCurrentThinkingBlock: vi.fn(),
      handleStreamChunk: vi.fn(),
      subagents: { releaseManaged: vi.fn() },
      thinkingIndicator: { hide: vi.fn(), show: vi.fn() },
    },
    selections: new ComposerSelections(selectionSources),
    getInputEl: () => input,
    getWelcomeEl: () => null,
    getMessagesEl: () => document.createElement('div') as any,
    getLinkedContentController: () => linkedContentController as any,
    getImageContextManager: () => ({
      clearImages: vi.fn(),
      getAttachedImages: vi.fn().mockReturnValue([]),
      hasImages: vi.fn().mockReturnValue(false),
      setImages: vi.fn(),
    }) as any,
    getTitleGenerationService: () => null,
    generateId: () => `id-${++id}`,
    getSettings: () => ({ model: 'claude-model', reasoning: 'high', permissionMode: 'normal', serviceTier: 'standard' }),
    getExecutionCoordinator: () => coordinator,
    getTabProviderId: () => 'claude',
    ensureExecutionInitialized: vi.fn().mockResolvedValue(true),
    canStartTurn: () => true,
    isClosing: () => false,
    ...dependencyOverrides,
    ...(typeof onReviewableSettlement === 'function'
      ? {
          captureReviewableSettlement: vi.fn(
            () => onReviewableSettlement as () => void,
          ),
        }
      : {}),
  } as unknown as InputControllerDeps & { renderer: NonNullable<InputControllerDeps['renderer']> };
  if (!('inlinePrompts' in dependencyOverrides)) {
    Object.assign(deps, {
      inlinePrompts: new SessionInteractions({
        getPromptParentEl: () => getInputContainerEl().parentElement,
        getSuppressedEl: getInputContainerEl,
      }),
    });
  }
  const ports = createConversationPorts({ ...(deps as any), session });
  // Conversation creation stays real; persistence and reset are observed at their boundary.
  const conversationController = new ConversationController({
    plugin, state, renderer: deps.renderer, drafts: ports.drafts, session,
    subagentManager: { clear: vi.fn() } as any,
    getWelcomeEl: () => null, setWelcomeEl: () => undefined, getMessagesEl: deps.getMessagesEl,
    getLinkedContentController: () => deps.getLinkedContentController(),
    ensureExecutionInitialized: () => deps.ensureExecutionInitialized(),
    getExecutionCoordinator: () => deps.getExecutionCoordinator(),
  });
  vi.spyOn(conversationController, 'save').mockResolvedValue(undefined);
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
  Object.assign(deps, { drafts: ports.drafts, session, builtInCommands });
  if (!('conversationController' in dependencyOverrides)) Object.assign(deps, { conversationController });
  const controller = new InputController(deps);
  return {
    openConversation, startNewConversation,
    builtInCommands,
    controller,
    coordinator,
    deps,
    /** Holds a running provider turn open until the returned release settles it. */
    holdResponse: () => holdResponse(session.turns),
    input,
    linkedContentController,
    plugin,
    selectionSources,
    session,
    state,
  };
}
