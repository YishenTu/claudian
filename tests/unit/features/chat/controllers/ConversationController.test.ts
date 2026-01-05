/**
 * Tests for ConversationController - Conversation Lifecycle
 */

import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';

// Helper to create mock DOM element
function createMockElement(): any {
  const style: Record<string, string> = {};
  const classList = new Set<string>();
  const children: any[] = [];

  const el: any = {
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
    createSpan: (opts?: { text?: string }) => {
      const child = createMockElement();
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createEl: (_tag: string, opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      children.push(child);
      return child;
    },
    setAttribute: jest.fn(),
    addEventListener: jest.fn(),
    querySelector: jest.fn().mockReturnValue(null),
    setText: jest.fn(),
    textContent: '',
  };

  return el;
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
      getActiveConversation: jest.fn().mockReturnValue(null),
      getConversationById: jest.fn().mockReturnValue(null),
      getConversationList: jest.fn().mockReturnValue([]),
      findEmptyConversation: jest.fn().mockReturnValue(null),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      agentService: {
        getSessionId: jest.fn().mockReturnValue(null),
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
      getEnabledServers: jest.fn().mockReturnValue(new Set()),
      setEnabledServers: jest.fn(),
    }) as any,
    getContextPathSelector: () => ({
      getContextPaths: jest.fn().mockReturnValue([]),
      setContextPaths: jest.fn(),
      clearContextPaths: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    getApprovedPlan: jest.fn().mockReturnValue(null),
    setApprovedPlan: jest.fn(),
    showPlanBanner: jest.fn(),
    hidePlanBanner: jest.fn(),
    triggerPendingPlanApproval: jest.fn(),
    getTitleGenerationService: () => null,
    setPlanModeActive: jest.fn(),
    getTodoPanel: () => ({
      remount: jest.fn(),
    }) as any,
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

    it('should clear todos for new conversation', async () => {
      // Set up existing todos
      deps.state.currentTodos = [
        { content: 'Existing todo', status: 'pending', activeForm: 'Doing existing todo' }
      ];
      expect(deps.state.currentTodos).not.toBeNull();

      await controller.createNew();

      expect(deps.state.currentTodos).toBeNull();
    });

    it('should switch to existing empty conversation instead of creating new one', async () => {
      const emptyConv = {
        id: 'empty-conv',
        title: 'Empty Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (deps.plugin.findEmptyConversation as jest.Mock).mockReturnValue(emptyConv);
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(emptyConv);

      await controller.createNew();

      expect(deps.plugin.findEmptyConversation).toHaveBeenCalled();
      expect(deps.plugin.switchConversation).toHaveBeenCalledWith('empty-conv');
      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      expect(deps.state.currentConversationId).toBe('empty-conv');
    });

    it('should create new conversation if no empty conversation exists', async () => {
      (deps.plugin.findEmptyConversation as jest.Mock).mockReturnValue(null);

      await controller.createNew();

      expect(deps.plugin.findEmptyConversation).toHaveBeenCalled();
      expect(deps.plugin.createConversation).toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should fallback to createConversation if switchConversation fails', async () => {
      const emptyConv = {
        id: 'empty-conv',
        title: 'Empty Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (deps.plugin.findEmptyConversation as jest.Mock).mockReturnValue(emptyConv);
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(null);

      await controller.createNew();

      expect(deps.plugin.switchConversation).toHaveBeenCalledWith('empty-conv');
      expect(deps.plugin.createConversation).toHaveBeenCalled();
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

  describe('Plan mode restore', () => {
    it('should restore plan mode state on loadActive', async () => {
      const conversation = {
        id: 'conv-1',
        messages: [],
        sessionId: null,
        isInPlanMode: false,
      };
      deps.plugin.settings.permissionMode = 'plan';
      deps.plugin.getActiveConversation = jest.fn().mockReturnValue(conversation);

      await controller.loadActive();

      expect(deps.state.planModeState?.isActive).toBe(true);
      expect(deps.setPlanModeActive).toHaveBeenCalledWith(true);
    });

    it('should restore plan mode state on switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.plugin.settings.permissionMode = 'plan';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        isInPlanMode: false,
      });

      await controller.switchTo('new-conv');

      expect(deps.state.planModeState?.isActive).toBe(true);
      expect(deps.setPlanModeActive).toHaveBeenCalledWith(true);
    });

    it('should keep plan mode active when creating new conversation', async () => {
      deps.plugin.settings.permissionMode = 'plan';

      await controller.createNew();

      expect(deps.state.planModeState?.isActive).toBe(true);
      expect(deps.setPlanModeActive).toHaveBeenCalledWith(true);
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

      (depsNoService.plugin.getConversationById as any) = jest.fn().mockReturnValue({
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
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
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

      // Reset for other tests
      deps.plugin.settings.enableAutoTitleGeneration = true;
    });

    it('should not regenerate if conversation not found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue(null);

      await controller.regenerateTitle('non-existent');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if conversation has less than 2 messages', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: 'Title',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if no user message found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
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

    it('should not regenerate if no assistant message found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'user', content: 'There' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if assistant text is empty', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: '' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should set pending status before generating', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
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
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
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
        'Hi there!',
        expect.any(Function)
      );
    });

    it('should preserve [Plan] prefix for plan conversations', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: '[Plan] Old Title',
        messages: [
          { role: 'user', content: 'Create a plan' },
          { role: 'assistant', content: 'Here is the plan...' },
        ],
      });

      // Simulate callback being called
      mockTitleService.generateTitle.mockImplementation(
        async (convId: string, _user: string, _assistant: string, callback: any) => {
          await callback(convId, { success: true, title: 'New Generated Title' });
        }
      );

      // Also mock getConversationById to return the expected title for the callback check
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: '[Plan] Old Title',
        messages: [
          { role: 'user', content: 'Create a plan' },
          { role: 'assistant', content: 'Here is the plan...' },
        ],
      });

      (deps.plugin.renameConversation as any) = jest.fn().mockResolvedValue(undefined);

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', '[Plan] New Generated Title');
    });

    it('should extract text from contentBlocks if content is empty', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockReturnValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            contentBlocks: [
              { type: 'text', content: 'Block 1' },
              { type: 'thinking', content: 'Thinking...' },
              { type: 'text', content: 'Block 2' },
            ],
          },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        'Hello',
        'Block 1\nBlock 2', // Joins text blocks with newline
        expect.any(Function)
      );
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
      (deps.plugin.getActiveConversation as jest.Mock).mockReturnValue({
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
      (deps.plugin.getActiveConversation as jest.Mock).mockReturnValue({
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
