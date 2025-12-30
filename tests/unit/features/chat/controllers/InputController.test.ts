/**
 * Tests for InputController - Message Queue and Input Handling
 */

import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';

// Helper to create mock DOM element
function createMockElement() {
  const style: Record<string, string> = { display: 'none' };
  return {
    style,
    setText: jest.fn((text: string) => {
      (createMockElement as any).lastText = text;
    }),
    get textContent() {
      return (createMockElement as any).lastText || '';
    },
  };
}

// Helper to create mock input element
function createMockInputEl() {
  return {
    value: '',
    focus: jest.fn(),
  } as unknown as HTMLTextAreaElement;
}

// Helper to create mock image context manager
function createMockImageContextManager() {
  return {
    hasImages: jest.fn().mockReturnValue(false),
    getAttachedImages: jest.fn().mockReturnValue([]),
    clearImages: jest.fn(),
    setImages: jest.fn(),
    handleImagePathInText: jest.fn().mockResolvedValue({ text: '', imageLoaded: false }),
  };
}

async function* createMockStream(chunks: any[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Helper to create mock dependencies
function createMockDeps(overrides: Partial<InputControllerDeps> = {}): InputControllerDeps {
  const state = new ChatState();
  const inputEl = createMockInputEl();
  const queueIndicatorEl = createMockElement();
  state.queueIndicatorEl = queueIndicatorEl as any;

  // Store image context manager so tests can access it
  const imageContextManager = createMockImageContextManager();

  return {
    plugin: {
      agentService: {
        query: jest.fn(),
        cancel: jest.fn(),
        resetSession: jest.fn(),
        setApprovedPlanContent: jest.fn(),
        setCurrentPlanFilePath: jest.fn(),
      },
      settings: {
        slashCommands: [],
        blockedCommands: { unix: [], windows: [] },
        enableBlocklist: true,
        permissionMode: 'yolo',
      },
      mcpService: {
        extractMentions: jest.fn().mockReturnValue(new Set()),
      },
      renameConversation: jest.fn(),
      updateConversation: jest.fn(),
      getConversationById: jest.fn().mockReturnValue(null),
    } as any,
    state,
    renderer: {
      addMessage: jest.fn().mockReturnValue({
        querySelector: jest.fn().mockReturnValue(createMockElement()),
      }),
    } as any,
    streamController: {
      showThinkingIndicator: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      handleStreamChunk: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      appendText: jest.fn(),
    } as any,
    selectionController: {
      getContext: jest.fn().mockReturnValue(null),
    } as any,
    conversationController: {
      save: jest.fn(),
      generateFallbackTitle: jest.fn().mockReturnValue('Test Title'),
      updateHistoryDropdown: jest.fn(),
    } as any,
    getInputEl: () => inputEl,
    getWelcomeEl: () => null,
    getMessagesEl: () => createMockElement() as any,
    getFileContextManager: () => ({
      startSession: jest.fn(),
      getAttachedFiles: jest.fn().mockReturnValue(new Set()),
      hasFilesChanged: jest.fn().mockReturnValue(false),
      markFilesSent: jest.fn(),
      setPlanModeActive: jest.fn(),
    }) as any,
    getImageContextManager: () => imageContextManager as any,
    getSlashCommandManager: () => null,
    getMcpServerSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    getTitleGenerationService: () => null,
    getComponent: () => ({} as any),
    setPlanModeActive: jest.fn(),
    getPlanBanner: () => null,
    generateId: () => `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    resetContextMeter: jest.fn(),
    ...overrides,
  };
}

describe('InputController - Message Queue', () => {
  let controller: InputController;
  let deps: InputControllerDeps;
  let inputEl: ReturnType<typeof createMockInputEl>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
    controller = new InputController(deps);
  });

  describe('Queuing messages while streaming', () => {
    it('should queue message when isStreaming is true', async () => {
      deps.state.isStreaming = true;
      inputEl.value = 'queued message';

      await controller.sendMessage();

      expect(deps.state.queuedMessage).toEqual({
        content: 'queued message',
        images: undefined,
        editorContext: null,
      });
      expect(inputEl.value).toBe('');
    });

    it('should queue message with images when streaming', async () => {
      deps.state.isStreaming = true;
      inputEl.value = 'queued with images';
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      const imageContextManager = deps.getImageContextManager()!;
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(true);
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue(mockImages);

      await controller.sendMessage();

      expect(deps.state.queuedMessage).toEqual({
        content: 'queued with images',
        images: mockImages,
        editorContext: null,
      });
      expect(imageContextManager.clearImages).toHaveBeenCalled();
    });

    it('should append new message to existing queued message', async () => {
      deps.state.isStreaming = true;
      inputEl.value = 'first message';
      await controller.sendMessage();

      inputEl.value = 'second message';
      await controller.sendMessage();

      expect(deps.state.queuedMessage!.content).toBe('first message\n\nsecond message');
    });

    it('should merge images when appending to queue', async () => {
      deps.state.isStreaming = true;
      const imageContextManager = deps.getImageContextManager()!;

      // First message with image
      inputEl.value = 'first';
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(true);
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue([{ id: 'img1' }]);
      await controller.sendMessage();

      // Second message with another image
      inputEl.value = 'second';
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue([{ id: 'img2' }]);
      await controller.sendMessage();

      expect(deps.state.queuedMessage!.images).toHaveLength(2);
      expect(deps.state.queuedMessage!.images![0].id).toBe('img1');
      expect(deps.state.queuedMessage!.images![1].id).toBe('img2');
    });

    it('should not queue empty message', async () => {
      deps.state.isStreaming = true;
      inputEl.value = '';
      const imageContextManager = deps.getImageContextManager()!;
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(false);

      await controller.sendMessage();

      expect(deps.state.queuedMessage).toBeNull();
    });
  });

  describe('Queue indicator UI', () => {
    it('should show queue indicator when message is queued', () => {
      deps.state.queuedMessage = { content: 'test message', images: undefined, editorContext: null };

      controller.updateQueueIndicator();

      expect(deps.state.queueIndicatorEl!.style.display).toBe('block');
      expect(deps.state.queueIndicatorEl!.textContent).toContain('⌙ Queued: test message');
    });

    it('should hide queue indicator when no message is queued', () => {
      deps.state.queuedMessage = null;

      controller.updateQueueIndicator();

      expect(deps.state.queueIndicatorEl!.style.display).toBe('none');
    });

    it('should truncate long message preview in indicator', () => {
      const longMessage = 'a'.repeat(100);
      deps.state.queuedMessage = { content: longMessage, images: undefined, editorContext: null };

      controller.updateQueueIndicator();

      expect(deps.state.queueIndicatorEl!.textContent).toContain('...');
    });

    it('should include [images] when queue message has images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      deps.state.queuedMessage = { content: 'queued content', images: mockImages as any, editorContext: null };

      controller.updateQueueIndicator();

      expect(deps.state.queueIndicatorEl!.textContent).toContain('queued content');
      expect(deps.state.queueIndicatorEl!.textContent).toContain('[images]');
    });

    it('should show [images] when queue message has only images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      deps.state.queuedMessage = { content: '', images: mockImages as any, editorContext: null };

      controller.updateQueueIndicator();

      expect(deps.state.queueIndicatorEl!.textContent).toBe('⌙ Queued: [images]');
    });
  });

  describe('Clearing queued message', () => {
    it('should clear queued message and update indicator', () => {
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };

      controller.clearQueuedMessage();

      expect(deps.state.queuedMessage).toBeNull();
      expect(deps.state.queueIndicatorEl!.style.display).toBe('none');
    });
  });

  describe('Cancel streaming', () => {
    it('should clear queue on cancel', () => {
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };
      deps.state.isStreaming = true;

      controller.cancelStreaming();

      expect(deps.state.queuedMessage).toBeNull();
      expect(deps.state.cancelRequested).toBe(true);
      expect(deps.plugin.agentService.cancel).toHaveBeenCalled();
    });

    it('should not cancel if not streaming', () => {
      deps.state.isStreaming = false;

      controller.cancelStreaming();

      expect(deps.plugin.agentService.cancel).not.toHaveBeenCalled();
    });
  });

  describe('Sending messages', () => {
    it('should send message, hide welcome, and save conversation', async () => {
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = deps.getImageContextManager()!;
      (imageContextManager.handleImagePathInText as jest.Mock).mockResolvedValue({
        text: 'final content',
        imageLoaded: true,
      });

      deps.getWelcomeEl = () => welcomeEl;
      deps.getFileContextManager = () => fileContextManager as any;
      deps.state.currentConversationId = 'conv-1';
      deps.plugin.agentService.query = jest.fn().mockImplementation(() => createMockStream([{ type: 'done' }]));

      inputEl.value = 'original content';

      await controller.sendMessage();

      expect(welcomeEl.style.display).toBe('none');
      expect(fileContextManager.startSession).toHaveBeenCalled();
      expect(deps.renderer.addMessage).toHaveBeenCalledTimes(2);
      expect(deps.state.messages).toHaveLength(2);
      expect(deps.state.messages[0].content).toBe('final content');
      expect(deps.state.messages[0].displayContent).toBe('original content');
      expect(imageContextManager.clearImages).toHaveBeenCalled();
      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Test Title');
      expect(deps.conversationController.save).toHaveBeenCalledWith(true);
      expect(deps.plugin.agentService.query).toHaveBeenCalled();
      expect(deps.state.isStreaming).toBe(false);
    });

    it('should include MCP options in query when mentions are present', async () => {
      const mcpMentions = new Set(['server-a']);
      const enabledServers = new Set(['server-b']);

      deps.plugin.mcpService.extractMentions = jest.fn().mockReturnValue(mcpMentions);
      deps.getMcpServerSelector = () => ({
        getEnabledServers: () => enabledServers,
      }) as any;
      deps.plugin.agentService.query = jest.fn().mockImplementation(() => createMockStream([{ type: 'done' }]));

      inputEl.value = 'hello';

      await controller.sendMessage();

      const queryCall = (deps.plugin.agentService.query as jest.Mock).mock.calls[0];
      const queryOptions = queryCall[3];
      expect(queryOptions.mcpMentions).toBe(mcpMentions);
      expect(queryOptions.enabledMcpServers).toBe(enabledServers);
    });
  });

  describe('Plan mode', () => {
    it('clears stale plan file path when starting plan mode', async () => {
      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );
      inputEl.value = 'Plan this';

      await controller.sendPlanModeMessage();

      expect(deps.plugin.agentService.setCurrentPlanFilePath).toHaveBeenCalledWith(null);
    });

    it('resets plan mode state on interrupt', async () => {
      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'working' },
          { type: 'done' },
        ])
      );
      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async () => {
        deps.state.cancelRequested = true;
      });
      inputEl.value = 'Plan this';

      await controller.sendPlanModeMessage();

      expect(deps.setPlanModeActive).toHaveBeenCalledWith(false);
      expect(deps.plugin.agentService.setCurrentPlanFilePath).toHaveBeenCalledTimes(2);
      expect(deps.state.planModeState).toBeNull();
    });
  });

  describe('Title generation', () => {
    it('should set pending status and fallback title after first exchange', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
        getTitleGenerationService: () => mockTitleService as any,
      });
      deps.state.currentConversationId = 'conv-1';

      // Mock the agent query to return a text response
      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Hello, how can I help?' },
          { type: 'done' },
        ])
      );

      // Mock handleStreamChunk to populate assistant content
      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();

      // After first exchange (2 messages), should set pending status (only when titleService available and content exists)
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', { titleGenerationStatus: 'pending' });
      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Test Title');
    });

    it('should find messages by role, not by index', async () => {
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
      });
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      // Verify messages are found by role
      const userMsg = deps.state.messages.find(m => m.role === 'user');
      const assistantMsg = deps.state.messages.find(m => m.role === 'assistant');
      expect(userMsg).toBeDefined();
      expect(assistantMsg).toBeDefined();
    });

    it('should call title generation service when available', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
        getTitleGenerationService: () => mockTitleService as any,
      });
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Response text' },
          { type: 'done' },
        ])
      );

      // Mock handleStreamChunk to populate assistant content
      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();

      // Title service should be called with user and assistant content
      expect(mockTitleService.generateTitle).toHaveBeenCalled();
      const callArgs = mockTitleService.generateTitle.mock.calls[0];
      expect(callArgs[0]).toBe('conv-1'); // conversationId
      expect(callArgs[1]).toContain('Hello world'); // user content
    });

    it('should not overwrite user-renamed title in callback', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
        getTitleGenerationService: () => mockTitleService as any,
      });
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Response' },
          { type: 'done' },
        ])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      // Mock getConversationById to return a conversation with different title (user renamed)
      (deps.plugin.getConversationById as jest.Mock).mockReturnValue({
        id: 'conv-1',
        title: 'User Custom Title', // User renamed it
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test';
      controller = new InputController(deps);

      await controller.sendMessage();

      // Get the callback and simulate it being called
      const callback = mockTitleService.generateTitle.mock.calls[0][3];
      await callback('conv-1', { success: true, title: 'AI Generated Title' });

      // Should clear status since user manually renamed (not apply AI title)
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', { titleGenerationStatus: undefined });
    });

    it('should not set pending status when titleService is null', async () => {
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
        getTitleGenerationService: () => null, // No title service
      });
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Response' },
          { type: 'done' },
        ])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      // Should NOT set pending status when no titleService
      const updateCalls = (deps.plugin.updateConversation as jest.Mock).mock.calls;
      const pendingCall = updateCalls.find((call: [string, { titleGenerationStatus?: string }]) =>
        call[1]?.titleGenerationStatus === 'pending'
      );
      expect(pendingCall).toBeUndefined();
    });

    it('should not set pending status when assistantText is empty', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      const welcomeEl = { style: { display: '' } } as any;
      const fileContextManager = {
        startSession: jest.fn(),
        getAttachedFiles: jest.fn().mockReturnValue(new Set()),
        hasFilesChanged: jest.fn().mockReturnValue(false),
        markFilesSent: jest.fn(),
      };
      const imageContextManager = createMockImageContextManager();

      deps = createMockDeps({
        getWelcomeEl: () => welcomeEl,
        getFileContextManager: () => fileContextManager as any,
        getImageContextManager: () => imageContextManager as any,
        getTitleGenerationService: () => mockTitleService as any,
      });
      deps.state.currentConversationId = 'conv-1';

      // Return empty stream - no text content
      (deps.plugin.agentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      // Don't populate assistant content (leave it empty)
      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async () => {});

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      // Should NOT call title service when assistantText is empty
      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();

      // Should NOT set pending status when assistantText is empty
      const updateCalls = (deps.plugin.updateConversation as jest.Mock).mock.calls;
      const pendingCall = updateCalls.find((call: [string, { titleGenerationStatus?: string }]) =>
        call[1]?.titleGenerationStatus === 'pending'
      );
      expect(pendingCall).toBeUndefined();
    });
  });
});
