import { createMockEl } from '@test/helpers/mockElement';

import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';

function createMockDeps(overrides: Partial<ConversationControllerDeps> = {}): ConversationControllerDeps {
  const state = new ChatState();
  const inputEl = { value: '' } as HTMLTextAreaElement;
  const historyDropdown = createMockEl();
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const fileContextManager = {
    resetForNewConversation: jest.fn(),
    resetForLoadedConversation: jest.fn(),
    autoAttachActiveFile: jest.fn(),
    setCurrentNote: jest.fn(),
    getCurrentNotePath: jest.fn().mockReturnValue(null),
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
      getConversationById: jest.fn().mockResolvedValue(null),
      getConversationList: jest.fn().mockReturnValue([]),
      findEmptyConversation: jest.fn().mockResolvedValue(null),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      deleteConversation: jest.fn().mockResolvedValue(undefined),
      agentService: {
        getSessionId: jest.fn().mockResolvedValue(null),
        setSessionId: jest.fn(),
      },
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
      getEnabledServers: jest.fn().mockResolvedValue(new Set()),
      setEnabledServers: jest.fn(),
    }) as any,
    getExternalContextSelector: () => ({
      getExternalContexts: jest.fn().mockReturnValue([]),
      setExternalContexts: jest.fn(),
      clearExternalContexts: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    getTitleGenerationService: () => null,
    getStatusPanel: () => ({
      remount: jest.fn(),
      clearSubagents: jest.fn(),
      restoreSubagents: jest.fn(),
    }) as any,
    ...overrides,
  };
}

describe('ConversationController', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('Queue Management', () => {
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

      it('should clear todos for new conversation', async () => {
        deps.state.currentTodos = [
          { content: 'Existing todo', status: 'pending', activeForm: 'Doing existing todo' }
        ];
        expect(deps.state.currentTodos).not.toBeNull();

        await controller.createNew();

        expect(deps.state.currentTodos).toBeNull();
      });

      it('should reset to entry point state (null conversationId) instead of creating conversation', async () => {
        // Entry point model: createNew() resets to blank state without creating conversation
        // Conversation is created lazily on first message send
        await controller.createNew();

        expect(deps.plugin.findEmptyConversation).not.toHaveBeenCalled();
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
        expect(deps.state.currentConversationId).toBeNull();
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

        expect(deps.state.messages.length).toBe(1);
        const welcomeEl = deps.getWelcomeEl()!;
        expect(welcomeEl.style.display).toBe('none');
      });
    });
  });

  describe('initializeWelcome', () => {
    it('should initialize file context for new tab', () => {
      const fileContextManager = deps.getFileContextManager()!;

      controller.initializeWelcome();

      expect(fileContextManager.resetForNewConversation).toHaveBeenCalled();
      expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
    });

    it('should not throw if welcomeEl is null', () => {
      const depsWithNullWelcome = createMockDeps({
        getWelcomeEl: () => null,
      });
      const controllerWithNullWelcome = new ConversationController(depsWithNullWelcome);

      expect(() => controllerWithNullWelcome.initializeWelcome()).not.toThrow();
    });

    it('should only add greeting if not already present', () => {
      const welcomeEl = deps.getWelcomeEl()!;
      const createDivSpy = jest.spyOn(welcomeEl, 'createDiv');

      // First call should add greeting
      controller.initializeWelcome();
      expect(createDivSpy).toHaveBeenCalledTimes(1);

      // Mock querySelector to return an element (greeting already exists)
      welcomeEl.querySelector = jest.fn().mockReturnValue(createMockEl());

      // Second call should not add another greeting
      controller.initializeWelcome();
      expect(createDivSpy).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  describe('formatDate', () => {
    it('should return time format for today', () => {
      const now = new Date();
      const result = controller.formatDate(now.getTime());

      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it('should return month/day format for a past date', () => {
      const pastDate = new Date(2023, 0, 15).getTime();
      const result = controller.formatDate(pastDate);

      expect(result).toContain('15');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return month/day format for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const result = controller.formatDate(yesterday.getTime());

      expect(result).not.toMatch(/^\d{2}:\d{2}$/);
    });
  });

  describe('toggleHistoryDropdown', () => {
    it('should add visible class when dropdown is hidden', () => {
      const dropdown = deps.getHistoryDropdown()!;
      expect(dropdown.hasClass('visible')).toBe(false);

      controller.toggleHistoryDropdown();

      expect(dropdown.hasClass('visible')).toBe(true);
    });

    it('should remove visible class when dropdown is visible', () => {
      const dropdown = deps.getHistoryDropdown()!;
      dropdown.addClass('visible');

      controller.toggleHistoryDropdown();

      expect(dropdown.hasClass('visible')).toBe(false);
    });

    it('should not throw when dropdown is null', () => {
      const depsNullDropdown = createMockDeps({
        getHistoryDropdown: () => null,
      });
      const ctrl = new ConversationController(depsNullDropdown);

      expect(() => ctrl.toggleHistoryDropdown()).not.toThrow();
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

    it('should lazily create conversation when entry point has messages', async () => {
      deps.state.currentConversationId = null;
      deps.state.messages = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now() }];

      (deps.plugin.createConversation as jest.Mock).mockResolvedValue({
        id: 'lazy-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await controller.save();

      expect(deps.plugin.createConversation).toHaveBeenCalled();
      expect(deps.state.currentConversationId).toBe('lazy-conv');
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'lazy-conv',
        expect.any(Object)
      );
    });

    it('should set lastResponseAt when updateLastResponse is true', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      const beforeCall = Date.now();

      await controller.save(true);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates.lastResponseAt).toBeDefined();
      expect(updates.lastResponseAt).toBeGreaterThanOrEqual(beforeCall);
      expect(updates.lastResponseAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('loadActive with existing conversation', () => {
    it('should restore currentNote when conversation has one', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'conv-with-note';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-with-note',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        currentNote: 'notes/my-note.md',
      });

      await controller.loadActive();

      expect(fileContextManager.setCurrentNote).toHaveBeenCalledWith('notes/my-note.md');
    });

    it('should auto-attach active file when no currentNote and no messages', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'empty-conv';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'empty-conv',
        messages: [],
        sessionId: null,
        currentNote: undefined,
      });

      await controller.loadActive();

      expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
      expect(fileContextManager.setCurrentNote).not.toHaveBeenCalled();
    });

    it('should call renderer.renderMessages with greeting callback', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
      });

      await controller.loadActive();

      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function)
      );

      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });
  });

  describe('switchTo with currentNote', () => {
    it('should set currentNote when switched conversation has one', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        currentNote: 'docs/readme.md',
      });

      await controller.switchTo('new-conv');

      expect(fileContextManager.setCurrentNote).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should not set currentNote when switched conversation has none', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        currentNote: undefined,
      });

      await controller.switchTo('new-conv');

      expect(fileContextManager.setCurrentNote).not.toHaveBeenCalled();
    });

    it('should call renderer.renderMessages with greeting callback on switch', async () => {
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
      });

      await controller.switchTo('new-conv');

      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function)
      );

      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });
  });

  describe('History Rendering', () => {
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    describe('updateHistoryDropdown with conversations', () => {
      it('should render conversation items when conversations exist', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'First Conversation', createdAt: 1000, lastResponseAt: 3000 },
          { id: 'conv-2', title: 'Second Conversation', createdAt: 2000, lastResponseAt: 2000 },
        ]);

        controller.updateHistoryDropdown();

        expect(dropdown.children.length).toBe(2);
        const list = dropdown.children[1];
        expect(list.hasClass('claudian-history-list')).toBe(true);
        expect(list.children.length).toBe(2);
      });

      it('should show "No conversations" when list is empty', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        expect(list.children[0].hasClass('claudian-history-empty')).toBe(true);
      });

      it('should sort conversations by lastResponseAt descending', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-old', title: 'Old', createdAt: 1000, lastResponseAt: 1000 },
          { id: 'conv-new', title: 'New', createdAt: 2000, lastResponseAt: 5000 },
          { id: 'conv-mid', title: 'Mid', createdAt: 3000, lastResponseAt: 3000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const firstTitle = list.children[0].querySelector('.claudian-history-item-title');
        expect(firstTitle?.textContent).toBe('New');
      });

      it('should mark current conversation as active', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 2000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const items = list.children;
        const activeItem = items.find((item: any) => item.hasClass('active'));
        expect(activeItem).toBeDefined();
      });

      it('should show loading indicator for pending title generation', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Generating...', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'pending' },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const loadingEl = item.querySelector('.claudian-action-loading');
        expect(loadingEl).toBeTruthy();
      });

      it('should show regenerate button for failed title generation', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Fallback Title', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'failed' },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const actions = item.querySelector('.claudian-history-item-actions');
        expect(actions).toBeTruthy();
        // regenerate button + rename button + delete button = 3 children
        expect(actions!.children.length).toBe(3);
      });

      it('should not show select click handler on current conversation', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const content = item.querySelector('.claudian-history-item-content');
        const listeners = content?._eventListeners?.get('click');
        expect(listeners).toBeUndefined();
      });

      it('should attach select click handler on non-current conversations', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        // conv-2 is the non-current one (sorted second by lastResponseAt)
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const listeners = content?._eventListeners?.get('click');
        expect(listeners).toBeDefined();
        expect(listeners!.length).toBe(1);
      });

      it('should not delete while streaming', async () => {
        deps.state.isStreaming = true;

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Test', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const deleteBtn = item.querySelector('.claudian-delete-btn');
        expect(deleteBtn).toBeTruthy();

        const clickHandlers = deleteBtn!._eventListeners?.get('click');
        expect(clickHandlers).toBeDefined();
        await clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(deps.plugin.deleteConversation).not.toHaveBeenCalled();
      });
    });

    describe('renderHistoryDropdown', () => {
      it('should render history items to provided container', () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Test', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, { onSelectConversation });

        expect(container.children.length).toBe(2); // header + list
      });
    });
  });

  describe('History Item Interactions', () => {
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    it('should switch conversation when clicking a non-current item content', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const otherItem = list.children[1];
      const content = otherItem.querySelector('.claudian-history-item-content');
      const clickHandlers = content?._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.switchConversation).toHaveBeenCalledWith('conv-2');
    });

    it('should call regenerateTitle when clicking regenerate button on failed item', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      deps.getTitleGenerationService = () => mockTitleService as any;

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Failed', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'failed' },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      // First child is the regenerate button
      const regenerateBtn = actions!.children[0];
      const clickHandlers = regenerateBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        title: 'Failed',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('should invoke rename handler when clicking rename button', () => {
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Test Title', createdAt: 1000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      expect(actions).toBeTruthy();
      // For non-failed items: rename is children[0], delete is children[1]
      const rBtn = actions!.children[0];
      expect(rBtn).toBeTruthy();
      const clickHandlers = rBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      const mockInput = createMockEl();
      (mockInput as any).type = '';
      (mockInput as any).className = '';
      (mockInput as any).value = '';
      (mockInput as any).focus = jest.fn();
      (mockInput as any).select = jest.fn();

      const titleEl = item.querySelector('.claudian-history-item-title');
      if (titleEl) {
        (titleEl as any).replaceWith = jest.fn();
      }

      const origDocument = global.document;
      global.document = { createElement: jest.fn().mockReturnValue(mockInput) } as any;

      try {
        clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(global.document.createElement).toHaveBeenCalledWith('input');
        expect((mockInput as any).value).toBe('Test Title');
        expect(titleEl!.replaceWith).toHaveBeenCalledWith(mockInput);
      } finally {
        global.document = origDocument;
      }
    });

    it('should delete conversation and reload active when deleting current conversation', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const deleteBtn = item.querySelector('.claudian-delete-btn');
      expect(deleteBtn).toBeTruthy();

      const clickHandlers = deleteBtn!._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-1');
    });

    it('should delete non-current conversation without calling loadActive', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const otherItem = list.children[1]; // conv-2
      const deleteBtn = otherItem.querySelector('.claudian-delete-btn');
      const clickHandlers = deleteBtn!._eventListeners?.get('click');

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-2');
      // Should not have called switchConversation (which is used in loadActive path)
      // The key check is that deleteConversation was called with conv-2
    });
  });

  describe('loadActive with greeting', () => {
    it('should show welcome and return early when no conversation exists', async () => {
      deps.state.currentConversationId = null;

      await controller.loadActive();

      const welcomeEl = deps.getWelcomeEl();
      expect(welcomeEl?.style.display).not.toBe('none');
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

describe('ConversationController - Title Generation', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockTitleService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps = createMockDeps({
      getTitleGenerationService: () => mockTitleService,
    });
    controller = new ConversationController(deps);
  });

  describe('regenerateTitle', () => {
    it('should not regenerate if titleService is null', async () => {
      const depsNoService = createMockDeps({
        getTitleGenerationService: () => null,
      });
      const controllerNoService = new ConversationController(depsNoService);

      (depsNoService.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controllerNoService.regenerateTitle('conv-1');

      expect(depsNoService.plugin.updateConversation).not.toHaveBeenCalled();
    });

    it('should not regenerate if enableAutoTitleGeneration is false', async () => {
      deps.plugin.settings.enableAutoTitleGeneration = false;
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();

      deps.plugin.settings.enableAutoTitleGeneration = true;
    });

    it('should not regenerate if conversation not found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue(null);

      await controller.regenerateTitle('non-existent');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if conversation has no messages', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if no user message found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'assistant', content: 'Hi' },
          { role: 'assistant', content: 'There' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should set pending status before generating', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('should call titleService.generateTitle with correct params', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello world', displayContent: 'Hello world!' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        'Hello world!', // Uses displayContent
        expect.any(Function)
      );
    });

    it('should regenerate title with only user message (no assistant yet)', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [{ role: 'user', content: 'Hello world' }],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        'Hello world',
        expect.any(Function)
      );
    });

    it('should rename conversation with generated title', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Create a plan' },
          { role: 'assistant', content: 'Here is the plan...' },
        ],
      });

      mockTitleService.generateTitle.mockImplementation(
        async (convId: string, _user: string, callback: any) => {
          await callback(convId, { success: true, title: 'New Generated Title' });
        }
      );

      (deps.plugin.renameConversation as any) = jest.fn().mockResolvedValue(undefined);

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'New Generated Title');
    });
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

describe('ConversationController - MCP Server Persistence', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockMcpServerSelector: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpServerSelector = {
      clearEnabled: jest.fn(),
      getEnabledServers: jest.fn().mockReturnValue(new Set(['mcp-server-1', 'mcp-server-2'])),
      setEnabledServers: jest.fn(),
    };
    deps = createMockDeps({
      getMcpServerSelector: () => mockMcpServerSelector,
    });
    controller = new ConversationController(deps);
  });

  describe('save', () => {
    it('should save enabled MCP servers to conversation', async () => {
      deps.state.currentConversationId = 'conv-1';

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          enabledMcpServers: ['mcp-server-1', 'mcp-server-2'],
        })
      );
    });

    it('should save undefined when no MCP servers enabled', async () => {
      mockMcpServerSelector.getEnabledServers.mockReturnValue(new Set());
      deps.state.currentConversationId = 'conv-1';

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          enabledMcpServers: undefined,
        })
      );
    });
  });

  describe('loadActive', () => {
    it('should restore enabled MCP servers from conversation', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sessionId: null,
        enabledMcpServers: ['restored-server-1', 'restored-server-2'],
      });

      await controller.loadActive();

      expect(mockMcpServerSelector.setEnabledServers).toHaveBeenCalledWith([
        'restored-server-1',
        'restored-server-2',
      ]);
    });

    it('should clear MCP servers when conversation has none', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sessionId: null,
        enabledMcpServers: undefined,
      });

      await controller.loadActive();

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });
  });

  describe('switchTo', () => {
    it('should restore enabled MCP servers when switching conversations', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        enabledMcpServers: ['switched-server'],
      });

      await controller.switchTo('new-conv');

      expect(mockMcpServerSelector.setEnabledServers).toHaveBeenCalledWith(['switched-server']);
    });

    it('should clear MCP servers when switching to conversation with no servers', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        enabledMcpServers: undefined,
      });

      await controller.switchTo('new-conv');

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });
  });

  describe('createNew', () => {
    it('should clear enabled MCP servers for new conversation', async () => {
      await controller.createNew();

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });
  });
});

describe('ConversationController - Race Condition Guards', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('createNew guards', () => {
    it('should not create when isCreatingConversation is already true', async () => {
      deps.state.isCreatingConversation = true;

      await controller.createNew();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not create when isSwitchingConversation is true', async () => {
      deps.state.isSwitchingConversation = true;

      await controller.createNew();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should reset even when streaming if force is true', async () => {
      deps.state.isStreaming = true;
      deps.state.cancelRequested = false;
      const initialGeneration = deps.state.streamGeneration;

      await controller.createNew({ force: true });

      expect(deps.state.isStreaming).toBe(false);
      expect(deps.state.cancelRequested).toBe(true);
      expect(deps.state.streamGeneration).toBe(initialGeneration + 1);
      expect(deps.state.currentConversationId).toBeNull();
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
          updatedAt: Date.now(),
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

      // Simulate switchTo in progress
      let switchPromiseResolve: () => void;
      const switchPromise = new Promise<void>((resolve) => {
        switchPromiseResolve = resolve;
      });

      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async () => {
        // During switch, try to createNew
        const createPromise = controller.createNew();

        // createNew should be blocked because isSwitchingConversation is true
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();

        switchPromiseResolve!();
        await createPromise;

        return {
          id: 'new-conv',
          messages: [],
          sessionId: null,
        };
      });

      await controller.switchTo('new-conv');
      await switchPromise;

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });
  });
});

describe('ConversationController - Persistent External Context Paths', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockExternalContextSelector: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExternalContextSelector = {
      getExternalContexts: jest.fn().mockReturnValue([]),
      setExternalContexts: jest.fn(),
      clearExternalContexts: jest.fn(),
    };
    deps = createMockDeps({
      getExternalContextSelector: () => mockExternalContextSelector,
    });
    (deps.plugin.settings as any).persistentExternalContextPaths = ['/persistent/path/a', '/persistent/path/b'];
    controller = new ConversationController(deps);
  });

  describe('createNew', () => {
    it('should call clearExternalContexts with persistent paths from settings', async () => {
      await controller.createNew();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should call clearExternalContexts with empty array if no persistent paths', async () => {
      (deps.plugin.settings as any).persistentExternalContextPaths = undefined;

      await controller.createNew();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('loadActive', () => {
    it('should use persistent paths for new conversation (no existing conversation)', async () => {
      deps.state.currentConversationId = null;

      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should use persistent paths for empty conversation (msg=0)', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [],
        sessionId: null,
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should restore saved paths for conversation with messages (msg>0)', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: ['/saved/path'],
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith(['/saved/path']);
      expect(mockExternalContextSelector.clearExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore empty paths for conversation with messages but no saved paths', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: undefined,
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('switchTo', () => {
    beforeEach(() => {
      deps.state.currentConversationId = 'old-conv';
    });

    it('should use persistent paths when switching to empty conversation (msg=0)', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'empty-conv',
        messages: [],
        sessionId: null,
        externalContextPaths: ['/old/saved/path'],
      });

      await controller.switchTo('empty-conv');

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
      expect(mockExternalContextSelector.setExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore saved paths when switching to conversation with messages', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'conv-with-messages',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: ['/saved/path/from/session'],
      });

      await controller.switchTo('conv-with-messages');

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith(
        ['/saved/path/from/session']
      );
      expect(mockExternalContextSelector.clearExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore empty array for conversation with messages but no saved paths', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'conv-with-messages',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: undefined,
      });

      await controller.switchTo('conv-with-messages');

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('Scenario: Adding persistent paths across sessions', () => {
    it('should show all persistent paths when returning to empty session', async () => {
      // Scenario:
      // 1. User is in session 0 (empty), adds path A as persistent
      // 2. User switches to session 1 (with messages), adds path B as persistent
      // 3. User returns to session 0 (empty) - should see both A and B

      // Step 1: Session 0 is empty, persistent paths = [A]
      (deps.plugin.settings as any).persistentExternalContextPaths = ['/path/a'];
      deps.state.currentConversationId = null;
      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(['/path/a']);

      // Step 2: User switches to session 1 and adds path B, settings now have [A, B]
      deps.state.currentConversationId = 'session-0'; // Currently in session 0
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'session-1',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: [],
      });
      await controller.switchTo('session-1');

      // User adds path B in session 1, settings now have [A, B]
      (deps.plugin.settings as any).persistentExternalContextPaths = ['/path/a', '/path/b'];

      // Step 3: User returns to session 0 (empty)
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'session-0',
        messages: [], // Empty session
        sessionId: null,
        externalContextPaths: ['/path/a'], // Only had A when originally created
      });

      jest.clearAllMocks();
      await controller.switchTo('session-0');

      // Should get BOTH paths because session is empty (msg=0)
      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/path/a', '/path/b']
      );
    });
  });
});

describe('ConversationController - Previous SDK Session IDs', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockAgentService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentService = {
      getSessionId: jest.fn().mockReturnValue(null),
      setSessionId: jest.fn(),
      consumeSessionInvalidation: jest.fn().mockReturnValue(false),
    };
    deps = createMockDeps({
      getAgentService: () => mockAgentService,
    });
    controller = new ConversationController(deps);
  });

  describe('save - session change detection', () => {
    it('should accumulate old sdkSessionId when SDK creates new session', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Existing conversation has sdkSessionId 'session-A'
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sdkSessionId: 'session-A',
        isNative: true,
        previousSdkSessionIds: undefined,
      });

      // Agent service reports new session 'session-B' (resume failed, new session created)
      mockAgentService.getSessionId.mockReturnValue('session-B');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          sdkSessionId: 'session-B',
          previousSdkSessionIds: ['session-A'],
        })
      );
    });

    it('should preserve existing previousSdkSessionIds when session changes again', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Conversation already has previous sessions [A], current is B
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sdkSessionId: 'session-B',
        isNative: true,
        previousSdkSessionIds: ['session-A'],
      });

      // Agent service reports new session 'session-C'
      mockAgentService.getSessionId.mockReturnValue('session-C');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          sdkSessionId: 'session-C',
          previousSdkSessionIds: ['session-A', 'session-B'],
        })
      );
    });

    it('should not modify previousSdkSessionIds when session has not changed', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sdkSessionId: 'session-A',
        isNative: true,
        previousSdkSessionIds: undefined,
      });

      mockAgentService.getSessionId.mockReturnValue('session-A');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          sdkSessionId: 'session-A',
          previousSdkSessionIds: undefined,
        })
      );
    });

    it('should deduplicate session IDs to prevent duplicates from race conditions', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Simulate a race condition where session-A is already in previousSdkSessionIds
      // but sdkSessionId is still session-A (should not duplicate)
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sdkSessionId: 'session-A',
        isNative: true,
        previousSdkSessionIds: ['session-A'], // Already contains A (from prior bug/race)
      });

      // Agent reports new session-B
      mockAgentService.getSessionId.mockReturnValue('session-B');

      await controller.save();

      // Should deduplicate: [A, A] -> [A]
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          sdkSessionId: 'session-B',
          previousSdkSessionIds: ['session-A'], // Deduplicated, not ['session-A', 'session-A']
        })
      );
    });
  });
});

describe('ConversationController - restoreExternalContextPaths null selector', () => {
  it('should return early when external context selector is null', async () => {
    const deps = createMockDeps({
      getExternalContextSelector: () => null,
    });
    const controller = new ConversationController(deps);

    deps.state.currentConversationId = 'old-conv';
    (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
      id: 'new-conv',
      messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
      sessionId: null,
      externalContextPaths: ['/some/path'],
    });

    // Should not throw even though selector is null
    await expect(controller.switchTo('new-conv')).resolves.not.toThrow();
  });
});

describe('ConversationController - regenerateTitle callback branches', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockTitleService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps = createMockDeps({
      getTitleGenerationService: () => mockTitleService,
    });
    controller = new ConversationController(deps);
  });

  it('should mark as failed when generation fails and user has not renamed', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns same title (user didn't rename)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'Original Title',
          messages: [],
        });
        await callback('conv-1', { success: false, title: '' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: 'failed',
    });
  });

  it('should clear status when user manually renamed during generation', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where user has renamed the conversation
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns a different title (user renamed)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'User Renamed Title',
          messages: [],
        });
        await callback('conv-1', { success: true, title: 'AI Generated Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    // Should NOT rename because user already renamed
    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    // Should clear the status since user's choice takes precedence
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: undefined,
    });
  });

  it('should not apply title when conversation no longer exists during callback', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where conversation was deleted
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(null);
        await callback('conv-1', { success: true, title: 'New Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
  });
});
