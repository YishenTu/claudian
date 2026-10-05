import { createConversationPorts, createTestTabSession } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';

import type { ConversationControllerDeps } from '@/features/chat/conversation/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabSession } from '@/features/chat/tabs/TabSession';

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export type FixtureDeps = ConversationControllerDeps & { session: TabSession; getInputEl: () => HTMLTextAreaElement; getImageContextManager: () => any };

/** Conversation controller deps with real draft, session, and state owners. */
export function createConversationControllerDeps(overrides: Record<string, unknown> = {}): FixtureDeps {
  const session = createTestTabSession({
    getState: () => state,
    coordinator: { cancel: () => (deps.getExecutionCoordinator() as { cancel?: () => void } | null)?.cancel?.() },
  });
  const state: ChatState = new ChatState({}, undefined, session.turns);
  const inputEl = { value: '', focus: jest.fn(), dispatchEvent: jest.fn() } as unknown as HTMLTextAreaElement;
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const linkedContentController = {
    resetAutoDraft: jest.fn(),
    lock: jest.fn(),
  };

  const deps = {
    plugin: {
      createConversation: jest.fn().mockResolvedValue({
        id: 'new-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      switchConversation: jest.fn().mockResolvedValue({
        id: 'switched-conv',
        title: 'Switched Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      getConversationById: jest.fn().mockResolvedValue(null),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        permissionMode: 'yolo',
      },
    } as any,
    state,
    renderer: {
      renderMessages: jest.fn().mockReturnValue(createMockEl()),
      refreshBranchButtons: jest.fn(),
      refreshBranchButtonState: jest.fn(),
    } as any,
    subagentManager: {
      orphanAllActive: jest.fn(),
      clear: jest.fn(),
    } as any,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: any) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl as any,
    getInputEl: () => inputEl,
    getLinkedContentController: () => linkedContentController as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
      hasImages: jest.fn().mockReturnValue(false), getAttachedImages: jest.fn().mockReturnValue([]), setImages: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    getExecutionCoordinator: () => null,
    ...overrides,
  } as unknown as FixtureDeps;
  return Object.assign(deps, createConversationPorts({ ...deps, session }));
}
