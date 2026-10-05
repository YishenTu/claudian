import { holdResponse } from '@test/helpers/ConversationPorts';
import { createConversationControllerDeps, deferred } from '@test/helpers/features/chat/ConversationControllerFixture';
import { testDate } from '@test/helpers/testClock';

import { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { QueuedMessage } from '@/features/chat/state/types';

/** A queued follow-up; conversation transitions only clear it through the queue owner. */
const queued = (content: string): QueuedMessage => ({ content } as QueuedMessage);

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

describe('ConversationController', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createConversationControllerDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createConversationControllerDeps();
    controller = new ConversationController(deps);
  });

  describe('Queue Management', () => {
    describe('Creating new conversation', () => {
      it('should clear queued message on new conversation', async () => {
        const onNewConversation = jest.fn();
        const dismissPendingInlinePrompts = jest.fn();
        deps = createConversationControllerDeps({ dismissPendingInlinePrompts });
        controller = new ConversationController(deps, { onNewConversation });
        const linkedContentController = deps.getLinkedContentController();
        deps.state.claimQueuedMessageWriter()(queued('test'));

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
        holdResponse(deps.session.turns);
        const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
        deps.state.currentConversationId = 'retained-conversation';
        deps.state.messages = messages;
        const inputEl = deps.getInputEl();
        inputEl.value = 'retained draft';
        const queuedMessage = queued('retained queue');
        deps.state.claimQueuedMessageWriter()(queuedMessage);
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
        deps = createConversationControllerDeps({ awaitBackgroundWork: awaitCompletion });
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
        deps = createConversationControllerDeps({ dismissPendingInlinePrompts });
        const onConversationSwitched = jest.fn(() => {
          expect(deps.state.isSwitchingConversation).toBe(false);
        });
        controller = new ConversationController(deps, { onConversationSwitched });
        const inputEl = deps.getInputEl();
        inputEl.value = 'some input';
        deps.state.currentConversationId = 'old-conv';
        deps.state.claimQueuedMessageWriter()(queued('test'));

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
        holdResponse(deps.session.turns);
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
      const depsWithNullWelcome = createConversationControllerDeps({
        getWelcomeEl: () => null,
      });
      const controllerWithNullWelcome = new ConversationController(depsWithNullWelcome);

      expect(() => controllerWithNullWelcome.initializeWelcome()).not.toThrow();
    });

    it('should only add greeting if not already present', () => {
      const welcomeEl = deps.getWelcomeEl()!;
      const setWelcomeEl = jest.fn();
      deps.setWelcomeEl = setWelcomeEl;
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

      deps.state.writeEditStates.set('old-tool', {} as any);
      await controller.loadActive();
      expect(deps.state.writeEditStates.size).toBe(0);

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
      deps = createConversationControllerDeps();
      controller = new ConversationController(deps, { onConversationLoaded });
      deps.state.currentConversationId = null;

      await controller.loadActive();

      const welcomeEl = deps.getWelcomeEl();
      expect(welcomeEl?.style.display).not.toBe('none');
      expect(onConversationLoaded).toHaveBeenCalled();
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
    const deps = createConversationControllerDeps({
      ensureExecutionForConversation,
      plugin: {
        ...createConversationControllerDeps().plugin,
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
  let deps: ReturnType<typeof createConversationControllerDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createConversationControllerDeps();
    controller = new ConversationController(deps);
  });

  describe('createNew guards', () => {
    it('should not create while already resetting to a new chat', async () => {
      jest.spyOn(deps.state, 'isResettingToNewChat', 'get').mockReturnValue(true);
      const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
      deps.state.currentConversationId = 'retained-conversation';
      deps.state.messages = messages;
      const inputEl = deps.getInputEl();
      inputEl.value = 'retained draft';
      const queuedMessage = queued('retained queue');
      deps.state.claimQueuedMessageWriter()(queuedMessage);
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
      jest.spyOn(deps.state, 'isSwitchingConversation', 'get').mockReturnValue(true);
      const messages = [{ id: 'retained-message', role: 'user' as const, content: 'Keep me', timestamp: testDate().getTime() }];
      deps.state.currentConversationId = 'retained-conversation';
      deps.state.messages = messages;
      const inputEl = deps.getInputEl();
      inputEl.value = 'retained draft';
      const queuedMessage = queued('retained queue');
      deps.state.claimQueuedMessageWriter()(queuedMessage);
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
      const releaseTurn = holdResponse(deps.session.turns);
      const cancel = jest.fn();
      deps.getExecutionCoordinator = () => ({ cancel, bindConversation: jest.fn() }) as any;
      deps.state.currentConversationId = 'active-conversation';
      deps.state.messages = [
        { id: 'message-1', role: 'user', content: 'Working', timestamp: testDate().getTime() },
      ];
      const initialGeneration = deps.state.streamGeneration;
      let cancelRequestedAtCancel = false;
      cancel.mockImplementation(() => { cancelRequestedAtCancel = deps.state.cancelRequested; });

      await controller.createNew({ force: true });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancelRequestedAtCancel).toBe(true);
      expect(deps.state.streamGeneration).toBe(initialGeneration + 1);
      expect(deps.state.currentConversationId).toBeNull();
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'active-conversation',
        expect.objectContaining({ lastActivityAt: expect.any(Number) }),
      );
      await releaseTurn();
      expect(deps.state.isStreaming).toBe(false);
    });

    it('should set and reset the new-chat reset flag during entry point reset', async () => {
      // Entry point model: createNew() just resets state, doesn't create conversation
      // But the reset flag should still be set during the reset
      let flagDuringExecution = false;

      deps.state.clearMessages = jest.fn(() => {
        flagDuringExecution = deps.state.isResettingToNewChat;
      });

      await controller.createNew();

      expect(flagDuringExecution).toBe(true);
      expect(deps.state.isResettingToNewChat).toBe(false);
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
      jest.spyOn(deps.state, 'isSwitchingConversation', 'get').mockReturnValue(true);

      await controller.switchTo('new-conv');

      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not switch while resetting to a new chat', async () => {
      deps.state.currentConversationId = 'old-conv';
      jest.spyOn(deps.state, 'isResettingToNewChat', 'get').mockReturnValue(true);

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
      const queuedMessage = queued('retained queue');
      deps.state.claimQueuedMessageWriter()(queuedMessage);
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
