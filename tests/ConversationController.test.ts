/**
 * Tests for ConversationController - Conversation Lifecycle
 */

import { ConversationController, type ConversationControllerDeps } from '../src/features/chat/controllers/ConversationController';
import { ChatState } from '../src/features/chat/state/ChatState';

// Helper to create mock DOM element
function createMockElement() {
  const style: Record<string, string> = {};
  const classList = new Set<string>();
  const children: any[] = [];

  return {
    style,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    addClass: (cls: string) => classList.add(cls),
    removeClass: (cls: string) => classList.delete(cls),
    hasClass: (cls: string) => classList.has(cls),
    empty: () => { children.length = 0; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      children.push(child);
      return child;
    },
    setText: jest.fn(),
    textContent: '',
  };
}

// Helper to create mock dependencies
function createMockDeps(overrides: Partial<ConversationControllerDeps> = {}): ConversationControllerDeps {
  const state = new ChatState();
  const inputEl = { value: '' } as HTMLTextAreaElement;
  const historyDropdown = createMockElement();
  let welcomeEl: any = createMockElement();
  const messagesEl = createMockElement();

  const fileContextManager = {
    resetForNewConversation: jest.fn(),
    resetForLoadedConversation: jest.fn(),
    autoAttachActiveFile: jest.fn(),
    setAttachedFiles: jest.fn(),
    getAttachedFiles: jest.fn().mockReturnValue(new Set()),
  };

  return {
    plugin: {
      createConversation: jest.fn().mockResolvedValue({
        id: 'new-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      switchConversation: jest.fn().mockResolvedValue({
        id: 'switched-conv',
        title: 'Switched Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      getActiveConversation: jest.fn().mockReturnValue(null),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      agentService: {
        getSessionId: jest.fn().mockReturnValue(null),
        setSessionId: jest.fn(),
      },
      settings: {
        userName: '',
      },
    } as any,
    state,
    renderer: {
      renderMessages: jest.fn().mockReturnValue(createMockElement()),
    } as any,
    asyncSubagentManager: {
      orphanAllActive: jest.fn(),
    } as any,
    getHistoryDropdown: () => historyDropdown as any,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: any) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl as any,
    getInputEl: () => inputEl,
    getFileContextManager: () => fileContextManager as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
    }) as any,
    getMcpServerSelector: () => ({
      clearEnabled: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    ...overrides,
  };
}

describe('ConversationController - Queue Management', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('Creating new conversation', () => {
    it('should clear queued message on new conversation', async () => {
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };
      deps.state.isStreaming = false;

      await controller.createNew();

      expect(deps.clearQueuedMessage).toHaveBeenCalled();
    });

    it('should not create new conversation while streaming', async () => {
      deps.state.isStreaming = true;

      await controller.createNew();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should save current conversation before creating new one', async () => {
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
      deps.state.currentConversationId = 'old-conv';

      await controller.createNew();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('old-conv', expect.any(Object));
    });

    it('should reset file context for new conversation', async () => {
      const fileContextManager = deps.getFileContextManager()!;

      await controller.createNew();

      expect(fileContextManager.resetForNewConversation).toHaveBeenCalled();
      expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
    });
  });

  describe('Switching conversations', () => {
    it('should clear queued message on conversation switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };

      await controller.switchTo('new-conv');

      expect(deps.clearQueuedMessage).toHaveBeenCalled();
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

    it('should reset file context when switching conversations', async () => {
      deps.state.currentConversationId = 'old-conv';
      const fileContextManager = deps.getFileContextManager()!;

      await controller.switchTo('new-conv');

      expect(fileContextManager.resetForLoadedConversation).toHaveBeenCalled();
    });

    it('should clear input value on switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      const inputEl = deps.getInputEl();
      inputEl.value = 'some input';

      await controller.switchTo('new-conv');

      expect(inputEl.value).toBe('');
    });

    it('should hide history dropdown after switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      const dropdown = deps.getHistoryDropdown()!;
      dropdown.addClass('visible');

      await controller.switchTo('new-conv');

      expect(dropdown.hasClass('visible')).toBe(false);
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

      // After switch, messages should be loaded and welcome should be hidden
      expect(deps.state.messages.length).toBe(1);
      const welcomeEl = deps.getWelcomeEl()!;
      expect(welcomeEl.style.display).toBe('none');
    });
  });
});

describe('ConversationController - Callbacks', () => {
  it('should call onNewConversation callback', async () => {
    const onNewConversation = jest.fn();
    const deps = createMockDeps();
    const controller = new ConversationController(deps, { onNewConversation });

    await controller.createNew();

    expect(onNewConversation).toHaveBeenCalled();
  });

  it('should call onConversationSwitched callback', async () => {
    const onConversationSwitched = jest.fn();
    const deps = createMockDeps();
    deps.state.currentConversationId = 'old-conv';
    const controller = new ConversationController(deps, { onConversationSwitched });

    await controller.switchTo('new-conv');

    expect(onConversationSwitched).toHaveBeenCalled();
  });

  it('should call onConversationLoaded callback', async () => {
    const onConversationLoaded = jest.fn();
    const deps = createMockDeps();
    const controller = new ConversationController(deps, { onConversationLoaded });

    await controller.loadActive();

    expect(onConversationLoaded).toHaveBeenCalled();
  });
});
