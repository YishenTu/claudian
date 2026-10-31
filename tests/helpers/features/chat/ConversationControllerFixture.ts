import '@/providers';

import { createConversationPorts, createTestSession } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { Component } from 'obsidian';

import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import type { ConversationControllerDeps } from '@/features/chat/conversation/ConversationController';
import { LinkedContentController } from '@/features/chat/linked-content';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';

export type FixtureDeps = ConversationControllerDeps & { renderer: NonNullable<ConversationControllerDeps['renderer']>; session: ChatSessionRuntime; getInputEl: () => HTMLTextAreaElement; getImageContextManager: () => ImageContextManager };

/** Conversation controller deps with real draft, session, and state owners. */
export async function createConversationControllerDeps(
  overrides: Record<string, unknown> = {},
  work: { hasBackgroundWork?: () => boolean; hasDetachedWork?: () => boolean } = {},
): Promise<FixtureDeps> {
  const session = createTestSession({
    getState: () => state,
    coordinator: {
      cancel: () => (deps.getExecutionCoordinator() as { cancel?: () => void } | null)?.cancel?.(),
      get hasBackgroundWork() { return work.hasBackgroundWork?.() ?? false; },
    },
    hasPendingWork: work.hasDetachedWork,
  });
  const state: ChatState = new ChatState({}, undefined, session.turns);
  const inputEl = document.createElement('textarea');
  vi.spyOn(inputEl, 'focus');
  vi.spyOn(inputEl, 'dispatchEvent');
  let welcomeEl: HTMLElement | null = document.createElement('div');
  const messagesEl = document.createElement('div');

  const plugin = await createChatFeatureHost({
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
      updateConversation: vi.fn().mockResolvedValue(undefined),
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        permissionMode: 'yolo',
      },
    });
  const component = new Component();
  const renderer = new MessageRenderer(plugin, component, messagesEl);
  for (const method of ['renderMessages', 'refreshBranchButtons', 'refreshBranchButtonState', 'captureReadingAnchor', 'restoreReadingAnchor'] as const) vi.spyOn(renderer, method);
  const subagentManager = new SubagentManager(() => undefined);
  vi.spyOn(subagentManager, 'clear');
  const linkedContentController = new LinkedContentController({ app: plugin.app, getExcludedTags: () => [], getCachedVaultFiles: () => [], getCachedVaultFolders: () => [] });
  vi.spyOn(linkedContentController, 'resetAutoDraft');
  vi.spyOn(linkedContentController, 'lock');
  const images = new ImageContextManager(plugin.app.keymap, messagesEl, inputEl, {});
  for (const method of ['clearImages', 'hasImages', 'getAttachedImages', 'setImages'] as const) vi.spyOn(images, method);
  onTestFinished(() => { images.destroy(); linkedContentController.destroy(); subagentManager.clear(); renderer.dispose(); component.unload(); });
  const deps: Omit<FixtureDeps, 'drafts'> = {
    plugin, state, session,
    renderer, subagentManager,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: HTMLElement | null) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl,
    getInputEl: () => inputEl,
    getLinkedContentController: () => linkedContentController,
    getImageContextManager: () => images,
    getExecutionCoordinator: () => null,
    ...overrides,
  };
  return Object.assign(deps, createConversationPorts({ ...deps, session }));
}
