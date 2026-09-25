import { createMockEl } from '@test/helpers/MockElement';
import { testDate } from '@test/helpers/testClock';
import { Notice } from 'obsidian';

import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';
import { confirm } from '@/shared/modals/ConfirmModal';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

const mockNotice = Notice as jest.Mock;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMockDeps(overrides: Record<string, unknown> = {}): ConversationControllerDeps {
  const state = new ChatState();
  const inputEl = { value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement;
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const linkedContentController = {
    resetAutoDraft: jest.fn(),
    lock: jest.fn(),
  };

  return {
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
    }) as any,
    clearQueuedMessage: jest.fn(),
    getExecutionCoordinator: () => null,
    ...overrides,
  } as ReturnType<typeof createMockDeps>;
}

describe('ConversationController', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('Queue Management', () => {
    describe('Creating new conversation', () => {
      it('should clear queued message on new conversation', async () => {
        const onNewConversation = jest.fn();
        const dismissPendingInlinePrompts = jest.fn();
        deps = createMockDeps({ dismissPendingInlinePrompts });
        controller = new ConversationController(deps, { onNewConversation });
        const linkedContentController = deps.getLinkedContentController();
        deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null, canvasContext: null };
        deps.state.isStreaming = false;

        await controller.createNew();

        expect(deps.clearQueuedMessage).toHaveBeenCalled();
        expect(linkedContentController.resetAutoDraft).toHaveBeenCalled();
        const welcomeEl = deps.getWelcomeEl()!;
        expect(welcomeEl.querySelector('.claudian-welcome-brand')?.textContent).toBe('Claudian');
        expect(welcomeEl.querySelector('.claudian-welcome-greeting')).not.toBeNull();
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
        expect(deps.state.currentConversationId).toBeNull();
        expect(onNewConversation).toHaveBeenCalled();
        expect(dismissPendingInlinePrompts).toHaveBeenCalled();
      });

      it('should not create new conversation while streaming', async () => {
        deps.state.isStreaming = true;
        const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
        deps.state.currentConversationId = 'retained-conversation';
        deps.state.messages = messages;
        const inputEl = deps.getInputEl();
        inputEl.value = 'retained draft';
        const queuedMessage = { content: 'retained queue', images: undefined, editorContext: null, canvasContext: null };
        deps.state.queuedMessage = queuedMessage;
        const linkedContentController = deps.getLinkedContentController();

        await controller.createNew();

        expect(deps.state.currentConversationId).toBe('retained-conversation');
        expect(deps.state.messages).toEqual(messages);
        expect(inputEl.value).toBe('retained draft');
        expect(deps.state.queuedMessage).toBe(queuedMessage);
        expect(deps.clearQueuedMessage).not.toHaveBeenCalled();
        expect(linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
        expect(deps.subagentManager.orphanAllActive).not.toHaveBeenCalled();

        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      });

      it('should save current conversation before creating new one', async () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        deps.state.currentConversationId = 'old-conv';
        deps.state.hasPendingConversationSave = true;

        await controller.createNew();

        expect(deps.plugin.updateConversation).toHaveBeenCalledWith('old-conv', expect.any(Object));
      });

      it('drains async completions and terminalizes tasks before saving', async () => {
        const awaitCompletion = jest.fn().mockResolvedValue(undefined);
        deps = createMockDeps({ awaitBackgroundWork: awaitCompletion });
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        deps.state.currentConversationId = 'old-conv';
        controller = new ConversationController(deps);

        await controller.createNew();

        expect(awaitCompletion.mock.invocationCallOrder[0])
          .toBeLessThan((deps.subagentManager.orphanAllActive as jest.Mock).mock.invocationCallOrder[0]);
        expect((deps.subagentManager.orphanAllActive as jest.Mock).mock.invocationCallOrder[0])
          .toBeLessThan((deps.plugin.updateConversation as jest.Mock).mock.invocationCallOrder[0]);
      });

      it('should clear messages and reset state when creating new', async () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        deps.state.currentConversationId = 'old-conv';

        const clearMessagesSpy = jest.spyOn(deps.state, 'clearMessages');

        await controller.createNew();

        expect(clearMessagesSpy).toHaveBeenCalled();
        expect(deps.state.currentConversationId).toBeNull();

        clearMessagesSpy.mockRestore();
      });
    });

    describe('Switching conversations', () => {
      it('should clear queued message on conversation switch', async () => {
        const dismissPendingInlinePrompts = jest.fn();
        deps = createMockDeps({ dismissPendingInlinePrompts });
        const onConversationSwitched = jest.fn(() => {
          expect(deps.state.isSwitchingConversation).toBe(false);
        });
        controller = new ConversationController(deps, { onConversationSwitched });
        const inputEl = deps.getInputEl();
        inputEl.value = 'some input';
        deps.state.currentConversationId = 'old-conv';
        deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null, canvasContext: null };

        await controller.switchTo('new-conv');

        expect(deps.clearQueuedMessage).toHaveBeenCalled();
        expect(inputEl.value).toBe('');
        expect(dismissPendingInlinePrompts).toHaveBeenCalled();
        expect(onConversationSwitched).toHaveBeenCalled();
      });

      it('does not touch session activity when switching away without pending messages', async () => {
        deps.state.currentConversationId = 'old-conv';
        deps.state.messages = [{ id: '1', role: 'user', content: 'Existing', timestamp: 1 }];
        deps.state.hasPendingConversationSave = false;

        await controller.switchTo('new-conv');

        expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
          'old-conv',
          expect.any(Object),
        );
        const updates = (deps.plugin.updateConversation as jest.Mock).mock.calls[0][1];
        expect(updates).not.toHaveProperty('lastActivityAt');
      });

      it('should not switch while streaming', async () => {
        deps.state.isStreaming = true;
        deps.state.currentConversationId = 'old-conv';

        await controller.switchTo('new-conv');

        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
      });

      it('should not switch to current conversation', async () => {
        deps.state.currentConversationId = 'same-conv';

        await controller.switchTo('same-conv');

        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
      });
    });

    describe('Welcome visibility', () => {
      it('should hide welcome when messages exist', () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        const welcomeEl = deps.getWelcomeEl()!;

        controller.updateWelcomeVisibility();

        expect(welcomeEl.style.display).toBe('none');
      });

      it('should show welcome when no messages exist', () => {
        deps.state.messages = [];
        const welcomeEl = deps.getWelcomeEl()!;

        controller.updateWelcomeVisibility();

        // When no messages, welcome should not be 'none' (either 'block' or empty string)
        expect(welcomeEl.style.display).not.toBe('none');
      });

      it('should update welcome visibility after switching to conversation with messages', async () => {
        deps.state.currentConversationId = 'old-conv';
        deps.state.messages = [];
        (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
          id: 'new-conv',
          messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
          sessionId: null,
        });

        await controller.switchTo('new-conv');

        expect(deps.state.messages.length).toBe(1);
        const welcomeEl = deps.getWelcomeEl()!;
        expect(welcomeEl.style.display).toBe('none');
      });
    });
  });

  describe('initializeWelcome', () => {
    it('should not throw if welcomeEl is null', () => {
      const depsWithNullWelcome = createMockDeps({
        getWelcomeEl: () => null,
      });
      const controllerWithNullWelcome = new ConversationController(depsWithNullWelcome);

      expect(() => controllerWithNullWelcome.initializeWelcome()).not.toThrow();
    });

    it('should only add greeting if not already present', () => {
      const welcomeEl = deps.getWelcomeEl()!;
      const setWelcomeEl = jest.fn();
      controller = new ConversationController({ ...deps, setWelcomeEl });
      const linkedContentController = deps.getLinkedContentController();
      const createDivSpy = jest.spyOn(welcomeEl, 'createDiv');

      controller.initializeWelcome();
      const initialCallCount = createDivSpy.mock.calls.length;
      expect(setWelcomeEl).toHaveBeenCalledWith(welcomeEl);
      expect(welcomeEl.querySelector('.claudian-welcome-linked-content')).not.toBeNull();
      expect(linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
      expect(welcomeEl.querySelector('.claudian-welcome-brand')).not.toBeNull();
      expect(welcomeEl.querySelector('.claudian-welcome-greeting')).not.toBeNull();

      controller.initializeWelcome();
      expect(createDivSpy).toHaveBeenCalledTimes(initialCallCount);
      expect(linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
    });
  });

  describe('save edge cases', () => {
    it('should return early when no conversationId and no messages', async () => {
      deps.state.currentConversationId = null;
      deps.state.messages = [];

      await controller.save();

      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('rejects messages before InputController creates the Conversation shell', async () => {
      deps.state.currentConversationId = null;
      deps.state.messages = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now() }];

      await expect(controller.save()).rejects.toThrow(
        'Cannot save messages before the Conversation shell is created',
      );
      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should set lastActivityAt when updateLastActivity is true', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      const beforeCall = Date.now();

      await controller.save(true);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates).not.toHaveProperty('resumeAtMessageId');
      expect(updates.lastActivityAt).toBeDefined();
      expect(updates.lastActivityAt).toBeGreaterThanOrEqual(beforeCall);
      expect(updates.lastActivityAt).toBeLessThanOrEqual(Date.now());
    });

    it('should clear resumeAtMessageId when passed via extraUpdates', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      await controller.save(true, { resumeAtMessageId: undefined });

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates.resumeAtMessageId).toBeUndefined();
      // Verify it's explicitly set (not just missing)
      expect('resumeAtMessageId' in updates).toBe(true);
    });

    it('should not clear resumeAtMessageId when updateLastResponse is false', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      deps.state.hasPendingConversationSave = true;

      await controller.save(false);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates).not.toHaveProperty('resumeAtMessageId');
      expect(deps.state.hasPendingConversationSave).toBe(false);
    });
  });

  describe('loadActive with existing conversation', () => {
    it('should restore linkedContentPath when conversation has one', async () => {
      const linkedContentController = deps.getLinkedContentController();
      deps.state.currentConversationId = 'conv-with-note';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-with-note',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        linkedContentPath: 'notes/my-note.md',
      });

      await controller.loadActive();

      expect(linkedContentController.lock).toHaveBeenCalledWith('notes/my-note.md');
      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function),
      );
      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });

    it('locks an empty existing Conversation even without Linked content', async () => {
      const linkedContentController = deps.getLinkedContentController();
      deps.state.currentConversationId = 'empty-conv';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'empty-conv',
        messages: [],
        sessionId: null,
        linkedContentPath: undefined,
      });

      await controller.loadActive();

      expect(linkedContentController.lock).toHaveBeenCalledWith(undefined);
    });
  });

  describe('switchTo with linkedContentPath', () => {
    it('should set linkedContentPath when switched conversation has one', async () => {
      const linkedContentController = deps.getLinkedContentController();
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        linkedContentPath: 'docs/readme.md',
      });

      await controller.switchTo('new-conv');

      expect(linkedContentController.lock).toHaveBeenCalledWith('docs/readme.md');
    });

    it('locks a switched Conversation with explicit None', async () => {
      const linkedContentController = deps.getLinkedContentController();
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        linkedContentPath: undefined,
      });

      await controller.switchTo('new-conv');

      expect(linkedContentController.lock).toHaveBeenCalledWith(undefined);
      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function),
      );
      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });
  });

  describe('loadActive with greeting', () => {
    it('should show welcome and return early when no conversation exists', async () => {
      const onConversationLoaded = jest.fn();
      controller = new ConversationController(deps, { onConversationLoaded });
      deps.state.currentConversationId = null;

      await controller.loadActive();

      const welcomeEl = deps.getWelcomeEl();
      expect(welcomeEl?.style.display).not.toBe('none');
      expect(onConversationLoaded).toHaveBeenCalled();
    });
  });

  describe('Greeting Time Branches', () => {
    it.each([
      { name: 'morning (5-12)', hour: 9, day: 1, patterns: ['morning', 'Coffee'] },
      { name: 'afternoon (12-18)', hour: 14, day: 2, patterns: ['afternoon'] },
      { name: 'evening (18-22)', hour: 20, day: 3, patterns: ['evening', 'Evening', 'your day'] },
      { name: 'night owl (22+)', hour: 23, day: 4, patterns: ['night owl', 'Evening'] },
      { name: 'early morning night owl (0-4)', hour: 2, day: 0, patterns: ['night owl', 'Evening'] },
    ])('should include $name greetings', ({ hour, day, patterns }) => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(hour);
      jest.spyOn(Date.prototype, 'getDay').mockReturnValue(day);

      const greetings = new Set<string>();
      for (let i = 0; i < 50; i++) {
        jest.spyOn(Math, 'random').mockReturnValue(i / 50);
        greetings.add(controller.getGreeting());
      }

      const hasTimeBased = [...greetings].some(g =>
        patterns.some(p => g.includes(p))
      );
      expect(hasTimeBased).toBe(true);

      jest.restoreAllMocks();
    });
  });
});

describe('ConversationController - Title Generation', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('generateFallbackTitle', () => {
    it('should generate title from first sentence', () => {
      const title = controller.generateFallbackTitle('How do I set up React? I need help.');

      expect(title).toBe('How do I set up React');
    });

    it('should truncate long titles to 50 chars', () => {
      const longMessage = 'A'.repeat(100);
      const title = controller.generateFallbackTitle(longMessage);

      expect(title.length).toBeLessThanOrEqual(53); // 50 + '...'
      expect(title).toContain('...');
    });

    it('should handle messages with no sentence breaks', () => {
      const title = controller.generateFallbackTitle('Hello world');

      expect(title).toBe('Hello world');
    });
  });
});

describe('ConversationController - provider switching', () => {
  it('should ensure the tab service matches the switched conversation provider', async () => {
    const ensureExecutionForConversation = jest.fn().mockResolvedValue(undefined);
    const switchedConversation = {
      id: 'new-conv',
      providerId: 'codex',
      title: 'Codex Conversation',
      messages: [],
      sessionId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    const deps = createMockDeps({
      ensureExecutionForConversation,
      plugin: {
        ...createMockDeps().plugin,
        switchConversation: jest.fn().mockResolvedValue(switchedConversation),
      } as any,
    });
    const controller = new ConversationController(deps);
    deps.state.currentConversationId = 'old-conv';

    await controller.switchTo('new-conv');

    expect(ensureExecutionForConversation).toHaveBeenCalledWith(switchedConversation);
  });
});

describe('ConversationController - Race Condition Guards', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('createNew guards', () => {
    it('should not create when isCreatingConversation is already true', async () => {
      deps.state.isCreatingConversation = true;
      const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
      deps.state.currentConversationId = 'retained-conversation';
      deps.state.messages = messages;
      const inputEl = deps.getInputEl();
      inputEl.value = 'retained draft';
      const queuedMessage = { content: 'retained queue', images: undefined, editorContext: null, canvasContext: null };
      deps.state.queuedMessage = queuedMessage;
      const linkedContentController = deps.getLinkedContentController();

      await controller.createNew();

      expect(deps.state.currentConversationId).toBe('retained-conversation');
      expect(deps.state.messages).toEqual(messages);
      expect(inputEl.value).toBe('retained draft');
      expect(deps.state.queuedMessage).toBe(queuedMessage);
      expect(deps.clearQueuedMessage).not.toHaveBeenCalled();
      expect(linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
      expect(deps.subagentManager.orphanAllActive).not.toHaveBeenCalled();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not create when isSwitchingConversation is true', async () => {
      deps.state.isSwitchingConversation = true;
      const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
      deps.state.currentConversationId = 'retained-conversation';
      deps.state.messages = messages;
      const inputEl = deps.getInputEl();
      inputEl.value = 'retained draft';
      const queuedMessage = { content: 'retained queue', images: undefined, editorContext: null, canvasContext: null };
      deps.state.queuedMessage = queuedMessage;
      const linkedContentController = deps.getLinkedContentController();

      await controller.createNew();

      expect(deps.state.currentConversationId).toBe('retained-conversation');
      expect(deps.state.messages).toEqual(messages);
      expect(inputEl.value).toBe('retained draft');
      expect(deps.state.queuedMessage).toBe(queuedMessage);
      expect(deps.clearQueuedMessage).not.toHaveBeenCalled();
      expect(linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
      expect(deps.subagentManager.orphanAllActive).not.toHaveBeenCalled();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should reset even when streaming if force is true', async () => {
      deps.state.isStreaming = true;
      deps.state.cancelRequested = false;
      deps.state.currentConversationId = 'active-conversation';
      deps.state.messages = [
        { id: 'message-1', role: 'user', content: 'Working', timestamp: 1 },
      ];
      const initialGeneration = deps.state.streamGeneration;

      await controller.createNew({ force: true });

      expect(deps.state.isStreaming).toBe(false);
      expect(deps.state.cancelRequested).toBe(true);
      expect(deps.state.streamGeneration).toBe(initialGeneration + 1);
      expect(deps.state.currentConversationId).toBeNull();
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'active-conversation',
        expect.objectContaining({ lastActivityAt: expect.any(Number) }),
      );
    });

    it('should set and reset isCreatingConversation flag during entry point reset', async () => {
      // Entry point model: createNew() just resets state, doesn't create conversation
      // But isCreatingConversation flag should still be set during the reset
      let flagDuringExecution = false;

      deps.state.clearMessages = jest.fn(() => {
        flagDuringExecution = deps.state.isCreatingConversation;
      });

      await controller.createNew();

      expect(flagDuringExecution).toBe(true);
      expect(deps.state.isCreatingConversation).toBe(false);
    });
  });

  describe('switchTo guards', () => {
    it('serializes a newer switch behind in-flight hydration instead of dropping it', async () => {
      const firstConversation = deferred<any>();
      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async (id: string) => {
        if (id === 'conversation-a') return firstConversation.promise;
        return {
          id,
          title: id,
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        };
      });
      deps.state.currentConversationId = 'old-conversation';

      const firstSwitch = controller.switchTo('conversation-a');
      for (let attempt = 0;
        attempt < 10 && (deps.plugin.switchConversation as jest.Mock).mock.calls.length === 0;
        attempt += 1) {
        await Promise.resolve();
      }
      const secondSwitch = controller.switchTo('conversation-b');

      expect(deps.plugin.switchConversation).toHaveBeenCalledTimes(1);
      firstConversation.resolve({
        id: 'conversation-a',
        title: 'Conversation A',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      await Promise.all([firstSwitch, secondSwitch]);

      expect(deps.plugin.switchConversation).toHaveBeenNthCalledWith(1, 'conversation-a');
      expect(deps.plugin.switchConversation).toHaveBeenNthCalledWith(2, 'conversation-b');
      expect(deps.state.currentConversationId).toBe('conversation-b');
    });

    it('should not switch when isSwitchingConversation is already true', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.state.isSwitchingConversation = true;

      await controller.switchTo('new-conv');

      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not switch when isCreatingConversation is true', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.state.isCreatingConversation = true;

      await controller.switchTo('new-conv');

      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should reset isSwitchingConversation flag even on error', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockRejectedValue(new Error('Switch failed'));

      await expect(controller.switchTo('new-conv')).rejects.toThrow('Switch failed');

      expect(deps.state.isSwitchingConversation).toBe(false);
    });

    it('should reset isSwitchingConversation flag when conversation not found', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(null);

      await controller.switchTo('non-existent');

      expect(deps.state.isSwitchingConversation).toBe(false);
    });

    it('should set isSwitchingConversation flag during switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      let flagDuringSwitch = false;
      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async () => {
        flagDuringSwitch = deps.state.isSwitchingConversation;
        return {
          id: 'new-conv',
          title: 'New Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        };
      });

      await controller.switchTo('new-conv');

      expect(flagDuringSwitch).toBe(true);
      expect(deps.state.isSwitchingConversation).toBe(false);
    });
  });

  describe('mutual exclusion', () => {
    it('should prevent createNew during switchTo', async () => {
      deps.state.currentConversationId = 'old-conv';
      const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
      deps.state.messages = messages;
      const inputEl = deps.getInputEl();
      inputEl.value = 'retained draft';
      const queuedMessage = { content: 'retained queue', images: undefined, editorContext: null, canvasContext: null };
      deps.state.queuedMessage = queuedMessage;
      const linkedContentController = deps.getLinkedContentController();

      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async () => {
        const orphanCount = (deps.subagentManager.orphanAllActive as jest.Mock).mock.calls.length;
        const clearQueueCount = (deps.clearQueuedMessage as jest.Mock).mock.calls.length;
        const resetDraftCount = (linkedContentController.resetAutoDraft as jest.Mock).mock.calls.length;
        expect(deps.state.isSwitchingConversation).toBe(true);

        await controller.createNew();

        expect(deps.state.currentConversationId).toBe('old-conv');
        expect(deps.state.messages).toEqual(messages);
        expect(inputEl.value).toBe('retained draft');
        expect(deps.state.queuedMessage).toBe(queuedMessage);
        expect(deps.subagentManager.orphanAllActive).toHaveBeenCalledTimes(orphanCount);
        expect(deps.clearQueuedMessage).toHaveBeenCalledTimes(clearQueueCount);
        expect(linkedContentController.resetAutoDraft).toHaveBeenCalledTimes(resetDraftCount);
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
        return {
          id: 'new-conv',
          messages: [],
          sessionId: null,
        };
      });

      await controller.switchTo('new-conv');

      expect(deps.state.currentConversationId).toBe('new-conv');
      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });
  });
});

describe('ConversationController - Rewind', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createMockDeps>;
  let mockCoordinator: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCoordinator = {
      previewRewind: jest.fn().mockResolvedValue({ canRewind: true }),
      rewind: jest.fn().mockResolvedValue({ canRewind: true, filesChanged: ['a.ts'] }),
    };
    deps = createMockDeps({
      getExecutionCoordinator: () => mockCoordinator,
    });
    controller = new ConversationController(deps);
  });

  it('should find prev/response assistants with bounded scan (skipping non-uuid messages)', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'assistant', content: 'boundary', timestamp: 2 }, // No uuid
      { id: 'm3', role: 'user', content: 'test', timestamp: 3, userMessageId: 'user-uuid' },
      { id: 'm4', role: 'assistant', content: 'boundary2', timestamp: 4 }, // No uuid
      { id: 'm5', role: 'assistant', content: 'resp', timestamp: 5, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m3');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
  });

  it('should initialize a cold conversation execution before previewing rewind', async () => {
    let coordinator: typeof mockCoordinator | null = null;
    const ensureExecutionInitialized = jest.fn().mockImplementation(async () => {
      coordinator = mockCoordinator;
      return true;
    });
    deps = createMockDeps({
      getExecutionCoordinator: () => coordinator,
      ensureExecutionInitialized,
    });
    controller = new ConversationController(deps);
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2');

    expect(ensureExecutionInitialized).toHaveBeenCalledTimes(1);
    expect(mockCoordinator.previewRewind).toHaveBeenCalledWith(
      'user-uuid',
      'prev-a',
      'code-and-conversation',
    );
    expect(mockCoordinator.rewind).toHaveBeenCalled();
  });

  it('should reject a second rewind while the first preview is pending', async () => {
    const previewResolvers: Array<(value: { canRewind: true }) => void> = [];
    mockCoordinator.previewRewind = jest.fn().mockImplementation(() => (
      new Promise(resolve => { previewResolvers.push(resolve); })
    ));
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    const firstRewind = controller.rewind('m2');
    await Promise.resolve();
    const secondRewind = controller.rewind('m2');
    await Promise.resolve();
    const previewCallCountBeforeResolution = mockCoordinator.previewRewind.mock.calls.length;
    previewResolvers.forEach(resolve => resolve({ canRewind: true }));
    await Promise.all([firstRewind, secondRewind]);

    expect(previewCallCountBeforeResolution).toBe(1);
    expect(mockCoordinator.rewind).toHaveBeenCalledTimes(1);
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('rewind to finish'));
  });

  it('should show Notice when message ID not found', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('nonexistent');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when streaming', async () => {
    deps.state.isStreaming = true;
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when user message has no userMessageId', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2 }, // No userMessageId
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should allow rewind when no previous assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'test', timestamp: 1, userMessageId: 'u1' },
      { id: 'm2', role: 'assistant', content: '', timestamp: 2, assistantMessageId: 'a1' },
    ];

    await controller.rewind('m1');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('u1', undefined, 'code-and-conversation');
  });

  it('should show Notice when no response assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show i18n Notice on coordinator rewind exception', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockCoordinator.rewind.mockRejectedValue(new Error('Coordinator error'));

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Coordinator error');
    expect(deps.state.isRewinding).toBe(false);
  });

  it('should show i18n Notice when canRewind is false', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockCoordinator.rewind.mockResolvedValue({ canRewind: false, error: 'No checkpoints' });

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('No checkpoints');
  });

  it('should truncateAt, save with resumeAtMessageId, and renderMessages on success', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.usage = { inputTokens: 100, outputTokens: 50 } as any;
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    const truncateSpy = jest.spyOn(deps.state, 'truncateAt');

    await controller.rewind('m2');

    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      expect.stringContaining('cannot be undone'),
      'Rewind',
    );
    expect((confirm as jest.Mock).mock.calls[0][1]).not.toContain('does not affect');
    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
    expect(truncateSpy).toHaveBeenCalledWith('m2');
    expect(deps.state.usage).toBeNull();
    expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function)
    );
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ resumeAtMessageId: 'prev-a' })
    );

    // Should populate input with rewound message content
    const inputEl = deps.getInputEl();
    expect(inputEl.value).toBe('test');
    expect(inputEl.focus).toHaveBeenCalled();

    // Should show success notice with file count
    const noticeMsg = mockNotice.mock.calls[0][0] as string;
    expect(noticeMsg).toContain('1');

    truncateSpy.mockRestore();
  });

  it('should restore the rewound message through the composer owner', async () => {
    const restoreMessageToComposer = jest.fn();
    deps = createMockDeps({
      getExecutionCoordinator: () => mockCoordinator,
      restoreMessageToComposer,
    });
    controller = new ConversationController(deps);
    const images = [{ id: 'image-1', name: 'reference.png' }];
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      {
        content: '',
        displayContent: 'restore this prompt',
        id: 'm2',
        images: images as any,
        role: 'user',
        timestamp: 2,
        userMessageId: 'user-uuid',
      },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2');

    expect(restoreMessageToComposer).toHaveBeenCalledWith({
      content: 'restore this prompt',
      images,
    });
  });

  it('should rewind to before the first user message and clear provider session state', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1, userMessageId: 'user-uuid' },
      { id: 'm2', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m1');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', undefined, 'code-and-conversation');
    expect(deps.state.messages).toEqual([]);
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        messages: [],
        sessionId: null,
        providerState: undefined,
        resumeAtMessageId: undefined,
      })
    );
    expect(deps.getInputEl().value).toBe('first prompt');
  });

  it('should pass conversation-only mode and keep file changes', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2', 'conversation');

    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      'Rewind conversation to this point? File changes will be kept.',
      'Rewind',
    );
    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'conversation');
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ resumeAtMessageId: 'prev-a' })
    );
    const noticeMsg = mockNotice.mock.calls[0][0] as string;
    expect(noticeMsg).toBe('Rewound conversation; file changes kept');
  });

  it('should preview file rewind and surface provider conflicts before confirmation', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.previewRewind = jest.fn().mockResolvedValue({
      canRewind: true,
      conflicts: [{ conflictType: 'modified_externally', path: 'notes/conflicted.md' }],
      filesChanged: ['notes/conflicted.md'],
    });

    await controller.rewind('m2');

    expect(mockCoordinator.previewRewind).toHaveBeenCalledWith(
      'user-uuid',
      'prev-a',
      'code-and-conversation',
    );
    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      expect.stringContaining('notes/conflicted.md'),
      'Rewind',
    );
    expect((confirm as jest.Mock).mock.calls[0][1]).toContain('overwritten');
    expect(mockCoordinator.rewind).toHaveBeenCalled();
  });

  it('should abort when provider rewind preview rejects the checkpoint', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.previewRewind = jest.fn().mockResolvedValue({
      canRewind: false,
      error: 'Checkpoint is no longer available',
    });

    await controller.rewind('m2');

    expect(confirm).not.toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('Checkpoint is no longer available'));
  });

  it('should leave provider-native session persistence to the coordinator', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1, userMessageId: 'user-uuid' },
      { id: 'm2', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.rewind.mockResolvedValue({
      canRewind: true,
      filesChanged: [],
      sessionStrategy: 'preserve-provider-session',
    });

    await controller.rewind('m1');

    const updates = (deps.plugin.updateConversation as jest.Mock).mock.calls[0][1];
    expect(updates).toEqual(expect.objectContaining({
      messages: [],
      resumeAtMessageId: undefined,
    }));
    expect(updates).not.toHaveProperty('sessionId');
    expect(updates).not.toHaveProperty('providerState');
  });

  it('should abort when confirmation is declined', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockResolvedValueOnce(false);

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('should re-check streaming state after confirmation dialog', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockImplementationOnce(async () => {
      deps.state.isStreaming = true;
      return true;
    });

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalled();
  });

  it('should show a warning notice when rewind succeeded but save failed', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    (deps.plugin.updateConversation as jest.Mock).mockRejectedValueOnce(new Error('Save failed'));

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Save failed');
  });
});
