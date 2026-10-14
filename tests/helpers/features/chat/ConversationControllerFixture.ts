import { createConversationPorts, createTestSession } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';

import type { ConversationControllerDeps } from '@/features/chat/conversation/ConversationController';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';

export type FixtureDeps = ConversationControllerDeps & { renderer: NonNullable<ConversationControllerDeps['renderer']>; session: ChatSessionRuntime; getInputEl: () => HTMLTextAreaElement; getImageContextManager: () => any };

/** Conversation controller deps with real draft, session, and state owners. */
export function createConversationControllerDeps(
  overrides: Record<string, unknown> = {},
  work: { hasBackgroundWork?: () => boolean; hasDetachedWork?: () => boolean } = {},
): FixtureDeps {
  const session = createTestSession({
    getState: () => state,
    coordinator: {
      cancel: () => (deps.getExecutionCoordinator() as { cancel?: () => void } | null)?.cancel?.(),
      get hasBackgroundWork() { return work.hasBackgroundWork?.() ?? false; },
    },
    hasPendingWork: work.hasDetachedWork,
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
    getExecutionCoordinator: () => null,
    ...overrides,
  } as unknown as FixtureDeps;
  return Object.assign(deps, createConversationPorts({ ...deps, session }));
}
