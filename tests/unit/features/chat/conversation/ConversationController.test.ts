import { createConversationControllerDeps } from '@test/helpers/features/chat/ConversationControllerFixture';

import { ConversationController } from '@/features/chat/conversation/ConversationController';

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

  describe('Presentation', () => {
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

      it('should update welcome visibility after loading a conversation with messages', async () => {
        deps.state.currentConversationId = 'new-conv';
        deps.state.messages = [];
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'new-conv',
          messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
          sessionId: null,
        });

        await controller.loadActive();

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

describe('ConversationController - provider hydration', () => {
  it('should ensure the tab service matches the loaded conversation provider', async () => {
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
        getConversationById: jest.fn().mockResolvedValue(switchedConversation),
      } as any,
    });
    const controller = new ConversationController(deps);
    deps.state.currentConversationId = 'new-conv';

    await controller.loadActive();

    expect(ensureExecutionForConversation).toHaveBeenCalledWith(switchedConversation);
  });
});
