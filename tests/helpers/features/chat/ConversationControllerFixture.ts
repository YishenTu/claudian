import { createConversationPorts, createTestSession } from '@test/helpers/ConversationPorts';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
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
  const inputEl = { value: '', focus: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLTextAreaElement;
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const linkedContentController = {
    resetAutoDraft: vi.fn(),
    lock: vi.fn(),
  };

  const deps = {
    plugin: {
      createConversation: vi.fn().mockResolvedValue({
        id: 'new-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      switchConversation: vi.fn().mockResolvedValue({
        id: 'switched-conv',
        title: 'Switched Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      getConversationById: vi.fn().mockResolvedValue(null),
      getConversationSummary: vi.fn().mockReturnValue(null),
      projects: createProjectsFake([]),
      providerHost: { workingDirectory: '/vault' },
      updateConversation: vi.fn().mockResolvedValue(undefined),
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        permissionMode: 'yolo',
      },
    } as any,
    state,
    renderer: {
      renderMessages: vi.fn().mockReturnValue(createMockEl()),
      refreshBranchButtons: vi.fn(),
      refreshBranchButtonState: vi.fn(),
      captureReadingAnchor: vi.fn(() => null),
      restoreReadingAnchor: vi.fn(),
    } as any,
    subagentManager: {
      clear: vi.fn(),
    } as any,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: any) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl as any,
    getInputEl: () => inputEl,
    getLinkedContentController: () => linkedContentController as any,
    getImageContextManager: () => ({
      clearImages: vi.fn(),
      hasImages: vi.fn().mockReturnValue(false), getAttachedImages: vi.fn().mockReturnValue([]), setImages: vi.fn(),
    }) as any,
    getExecutionCoordinator: () => null,
    ...overrides,
  } as unknown as FixtureDeps;
  return Object.assign(deps, createConversationPorts({ ...deps, session }));
}
