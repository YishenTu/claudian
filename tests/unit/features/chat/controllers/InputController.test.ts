import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';

const mockNotice = Notice as jest.Mock;

function createMockInputEl() {
  return {
    value: '',
    focus: jest.fn(),
  } as unknown as HTMLTextAreaElement;
}

function createMockWelcomeEl() {
  return { style: { display: '' } } as any;
}

function createMockFileContextManager() {
  return {
    startSession: jest.fn(),
    getCurrentNotePath: jest.fn().mockReturnValue(null),
    shouldSendCurrentNote: jest.fn().mockReturnValue(false),
    markCurrentNoteSent: jest.fn(),
    transformContextMentions: jest.fn().mockImplementation((text: string) => text),
  };
}

function createMockImageContextManager() {
  return {
    hasImages: jest.fn().mockReturnValue(false),
    getAttachedImages: jest.fn().mockReturnValue([]),
    clearImages: jest.fn(),
    setImages: jest.fn(),
  };
}

async function* createMockStream(chunks: any[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createMockAgentService() {
  return {
    query: jest.fn(),
    cancel: jest.fn(),
    resetSession: jest.fn(),
    setApprovedPlanContent: jest.fn(),
    setCurrentPlanFilePath: jest.fn(),
    getApprovedPlanContent: jest.fn().mockReturnValue(null),
    clearApprovedPlanContent: jest.fn(),
    ensureReady: jest.fn().mockResolvedValue(true),
    getSessionId: jest.fn().mockReturnValue(null),
  };
}

function createMockInstructionRefineService(overrides: Record<string, jest.Mock> = {}) {
  return {
    refineInstruction: jest.fn().mockResolvedValue({ success: true }),
    resetConversation: jest.fn(),
    continueConversation: jest.fn(),
    cancel: jest.fn(),
    ...overrides,
  };
}

function createMockInstructionModeManager() {
  return { clear: jest.fn() };
}

function createMockDeps(overrides: Partial<InputControllerDeps> = {}): InputControllerDeps & { mockAgentService: ReturnType<typeof createMockAgentService> } {
  const state = new ChatState();
  const inputEl = createMockInputEl();
  const queueIndicatorEl = createMockEl();
  queueIndicatorEl.style.display = 'none';
  jest.spyOn(queueIndicatorEl, 'setText');
  state.queueIndicatorEl = queueIndicatorEl as any;

  const imageContextManager = createMockImageContextManager();
  const mockAgentService = createMockAgentService();

  return {
    plugin: {
      saveSettings: jest.fn(),
      settings: {
        slashCommands: [],
        blockedCommands: { unix: [], windows: [] },
        enableBlocklist: true,
        permissionMode: 'yolo',
        enableAutoTitleGeneration: true,
      },
      mcpManager: {
        extractMentions: jest.fn().mockReturnValue(new Set()),
        transformMentions: jest.fn().mockImplementation((text: string) => text),
      },
      renameConversation: jest.fn(),
      updateConversation: jest.fn(),
      getConversationById: jest.fn().mockResolvedValue(null),
      createConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    } as any,
    state,
    renderer: {
      addMessage: jest.fn().mockReturnValue({
        querySelector: jest.fn().mockReturnValue(createMockEl()),
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
      clearTerminalSubagentsFromMessages: jest.fn(),
    } as any,
    getInputEl: () => inputEl,
    getInputContainerEl: () => createMockEl() as any,
    getWelcomeEl: () => null,
    getMessagesEl: () => createMockEl() as any,
    getFileContextManager: () => ({
      startSession: jest.fn(),
      getCurrentNotePath: jest.fn().mockReturnValue(null),
      shouldSendCurrentNote: jest.fn().mockReturnValue(false),
      markCurrentNoteSent: jest.fn(),
      transformContextMentions: jest.fn().mockImplementation((text: string) => text),
    }) as any,
    getImageContextManager: () => imageContextManager as any,
    getMcpServerSelector: () => null,
    getExternalContextSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    generateId: () => `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    resetInputHeight: jest.fn(),
    getAgentService: () => mockAgentService as any,
    getSubagentManager: () => ({ resetSpawnedCount: jest.fn(), resetStreamingState: jest.fn() }) as any,
    mockAgentService,
    ...overrides,
  };
}

/**
 * Composite helper for tests that need a complete "sendable" deps setup.
 * Creates welcomeEl + fileContextManager and sets conversationId by default,
 * eliminating the repeated boilerplate in send-path tests.
 */
function createSendableDeps(
  overrides: Partial<InputControllerDeps> = {},
  conversationId: string | null = 'conv-1',
): InputControllerDeps & { mockAgentService: ReturnType<typeof createMockAgentService> } {
  const welcomeEl = createMockWelcomeEl();
  const fileContextManager = createMockFileContextManager();
  const result = createMockDeps({
    getWelcomeEl: () => welcomeEl,
    getFileContextManager: () => fileContextManager as any,
    ...overrides,
  });
  if (conversationId !== null) {
    result.state.currentConversationId = conversationId;
  }
  return result;
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
        hidden: undefined,
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
        hidden: undefined,
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

      inputEl.value = 'first';
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(true);
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue([{ id: 'img1' }]);
      await controller.sendMessage();

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

  describe('Queued message processing', () => {
    it('should send queued message in non-plan mode', async () => {
      jest.useFakeTimers();
      try {
        deps.plugin.settings.permissionMode = 'normal';
        deps.state.queuedMessage = {
          content: 'queued plan',
          images: undefined,
          editorContext: null,
        };

        const sendSpy = jest.spyOn(controller, 'sendMessage').mockResolvedValue(undefined);

        (controller as any).processQueuedMessage();
        jest.runAllTimers();
        await Promise.resolve();

        expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ editorContextOverride: null }));
        sendSpy.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Queue indicator UI', () => {
    it('should show queue indicator when message is queued', () => {
      deps.state.queuedMessage = { content: 'test message', images: undefined, editorContext: null };

      controller.updateQueueIndicator();

      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      expect(queueIndicatorEl.setText).toHaveBeenCalledWith('⌙ Queued: test message');
      expect(queueIndicatorEl.style.display).toBe('block');
    });

    it('should hide queue indicator when no message is queued', () => {
      deps.state.queuedMessage = null;

      controller.updateQueueIndicator();

      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      expect(queueIndicatorEl.style.display).toBe('none');
    });

    it('should truncate long message preview in indicator', () => {
      const longMessage = 'a'.repeat(100);
      deps.state.queuedMessage = { content: longMessage, images: undefined, editorContext: null };

      controller.updateQueueIndicator();

      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      const call = queueIndicatorEl.setText.mock.calls[0][0] as string;
      expect(call).toContain('...');
    });

    it('should include [images] when queue message has images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      deps.state.queuedMessage = { content: 'queued content', images: mockImages as any, editorContext: null };

      controller.updateQueueIndicator();

      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      const call = queueIndicatorEl.setText.mock.calls[0][0] as string;
      expect(call).toContain('queued content');
      expect(call).toContain('[images]');
    });

    it('should show [images] when queue message has only images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      deps.state.queuedMessage = { content: '', images: mockImages as any, editorContext: null };

      controller.updateQueueIndicator();

      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      expect(queueIndicatorEl.setText).toHaveBeenCalledWith('⌙ Queued: [images]');
    });
  });

  describe('Clearing queued message', () => {
    it('should clear queued message and update indicator', () => {
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };

      controller.clearQueuedMessage();

      expect(deps.state.queuedMessage).toBeNull();
      const queueIndicatorEl = deps.state.queueIndicatorEl as any;
      expect(queueIndicatorEl.style.display).toBe('none');
    });
  });

  describe('Cancel streaming', () => {
    it('should clear queue on cancel', () => {
      deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null };
      deps.state.isStreaming = true;

      controller.cancelStreaming();

      expect(deps.state.queuedMessage).toBeNull();
      expect(deps.state.cancelRequested).toBe(true);
      expect((deps as any).mockAgentService.cancel).toHaveBeenCalled();
    });

    it('should not cancel if not streaming', () => {
      deps.state.isStreaming = false;

      controller.cancelStreaming();

      expect((deps as any).mockAgentService.cancel).not.toHaveBeenCalled();
    });
  });

  describe('Sending messages', () => {
    it('should send message, hide welcome, and save conversation', async () => {
      const welcomeEl = createMockWelcomeEl();
      const fileContextManager = createMockFileContextManager();
      const imageContextManager = deps.getImageContextManager()!;

      deps.getWelcomeEl = () => welcomeEl;
      deps.getFileContextManager = () => fileContextManager as any;
      deps.state.currentConversationId = 'conv-1';
      (deps as any).mockAgentService.query = jest.fn().mockImplementation(() => createMockStream([{ type: 'done' }]));

      inputEl.value = 'See ![[image.png]]';

      await controller.sendMessage();

      expect(welcomeEl.style.display).toBe('none');
      expect(fileContextManager.startSession).toHaveBeenCalled();
      expect(deps.renderer.addMessage).toHaveBeenCalledTimes(2);
      expect(deps.state.messages).toHaveLength(2);
      // Without XML context tags, content equals displayContent (no <query> wrapper)
      expect(deps.state.messages[0].content).toBe('See ![[image.png]]');
      expect(deps.state.messages[0].displayContent).toBe('See ![[image.png]]');
      expect(deps.state.messages[0].images).toBeUndefined();
      expect(imageContextManager.clearImages).toHaveBeenCalled();
      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Test Title');
      expect(deps.conversationController.save).toHaveBeenCalledWith(true);
      expect((deps as any).mockAgentService.query).toHaveBeenCalled();
      expect(deps.state.isStreaming).toBe(false);
    });

    it('should prepend current note only once per session', async () => {
      const prompts: string[] = [];
      let currentNoteSent = false;
      const fileContextManager = {
        startSession: jest.fn(),
        getCurrentNotePath: jest.fn().mockReturnValue('notes/session.md'),
        shouldSendCurrentNote: jest.fn().mockImplementation(() => !currentNoteSent),
        markCurrentNoteSent: jest.fn().mockImplementation(() => { currentNoteSent = true; }),
        transformContextMentions: jest.fn().mockImplementation((text: string) => text),
      };

      deps.getFileContextManager = () => fileContextManager as any;
      (deps as any).mockAgentService.query = jest.fn().mockImplementation((prompt: string) => {
        prompts.push(prompt);
        return createMockStream([{ type: 'done' }]);
      });

      inputEl.value = 'First message';
      await controller.sendMessage();

      inputEl.value = 'Second message';
      await controller.sendMessage();

      expect(prompts[0]).toContain('<current_note>');
      expect(prompts[1]).not.toContain('<current_note>');
    });

    it('should include MCP options in query when mentions are present', async () => {
      const mcpMentions = new Set(['server-a']);
      const enabledServers = new Set(['server-b']);

      deps.plugin.mcpManager.extractMentions = jest.fn().mockReturnValue(mcpMentions);
      deps.getMcpServerSelector = () => ({
        getEnabledServers: () => enabledServers,
      }) as any;
      (deps as any).mockAgentService.query = jest.fn().mockImplementation(() => createMockStream([{ type: 'done' }]));

      inputEl.value = 'hello';

      await controller.sendMessage();

      const queryCall = ((deps as any).mockAgentService.query as jest.Mock).mock.calls[0];
      const queryOptions = queryCall[3];
      expect(queryOptions.mcpMentions).toBe(mcpMentions);
      expect(queryOptions.enabledMcpServers).toBe(enabledServers);
    });
  });

  describe('Conversation operation guards', () => {
    it('should not send message when isCreatingConversation is true', async () => {
      deps.state.isCreatingConversation = true;
      inputEl.value = 'test message';

      await controller.sendMessage();

      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
      // Input should be preserved for retry
      expect(inputEl.value).toBe('test message');
    });

    it('should not send message when isSwitchingConversation is true', async () => {
      deps.state.isSwitchingConversation = true;
      inputEl.value = 'test message';

      await controller.sendMessage();

      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
      // Input should be preserved for retry
      expect(inputEl.value).toBe('test message');
    });

    it('should preserve images when blocked by conversation operation', async () => {
      deps.state.isCreatingConversation = true;
      inputEl.value = 'test message';
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      const imageContextManager = deps.getImageContextManager()!;
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(true);
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue(mockImages);

      await controller.sendMessage();

      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
      // Images should NOT be cleared
      expect(imageContextManager.clearImages).not.toHaveBeenCalled();
    });
  });

  describe('Title generation', () => {
    it('should set pending status and fallback title after first user message', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };

      // conversationId=null to test the conversation creation path
      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      }, null);

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Hello, how can I help?' },
          { type: 'done' },
        ])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.plugin.createConversation).toHaveBeenCalled();
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', { titleGenerationStatus: 'pending' });
      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Test Title');
    });

    it('should find messages by role, not by index', async () => {
      deps = createSendableDeps();

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

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

      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Response text' },
          { type: 'done' },
        ])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockTitleService.generateTitle).toHaveBeenCalled();
      const callArgs = mockTitleService.generateTitle.mock.calls[0];
      expect(callArgs[0]).toBe('conv-1');
      expect(callArgs[1]).toContain('Hello world');
    });

    it('should not overwrite user-renamed title in callback', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };

      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
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

      // Simulate user having renamed the conversation
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        title: 'User Custom Title',
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test';
      controller = new InputController(deps);

      await controller.sendMessage();

      const callback = mockTitleService.generateTitle.mock.calls[0][2];
      await callback('conv-1', { success: true, title: 'AI Generated Title' });

      // Should clear status since user manually renamed (not apply AI title)
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', { titleGenerationStatus: undefined });
    });

    it('should not set pending status when titleService is null', async () => {
      deps = createSendableDeps({
        getTitleGenerationService: () => null,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
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

      const updateCalls = (deps.plugin.updateConversation as jest.Mock).mock.calls;
      const pendingCall = updateCalls.find((call: [string, { titleGenerationStatus?: string }]) =>
        call[1]?.titleGenerationStatus === 'pending'
      );
      expect(pendingCall).toBeUndefined();
    });

    it('should NOT call title generation service when enableAutoTitleGeneration is false', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };

      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      });
      deps.plugin.settings.enableAutoTitleGeneration = false;

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([
          { type: 'text', content: 'Response text' },
          { type: 'done' },
        ])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content = chunk.content;
        }
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();

      const updateCalls = (deps.plugin.updateConversation as jest.Mock).mock.calls;
      const pendingCall = updateCalls.find((call: [string, { titleGenerationStatus?: string }]) =>
        call[1]?.titleGenerationStatus === 'pending'
      );
      expect(pendingCall).toBeUndefined();

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Test Title');
    });
  });

  describe('Auto-hide status panels on response end', () => {
    it('should clear currentTodos when all todos are completed', async () => {
      deps = createSendableDeps();
      deps.state.currentTodos = [
        { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'completed', activeForm: 'Task 2' },
      ];

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.state.currentTodos).toBeNull();
    });

    it('should NOT clear currentTodos when some todos are pending', async () => {
      deps = createSendableDeps();
      deps.state.currentTodos = [
        { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'pending', activeForm: 'Task 2' },
      ];

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.state.currentTodos).not.toBeNull();
      expect(deps.state.currentTodos).toHaveLength(2);
    });

    it('should call clearTerminalSubagents when all subagents completed', async () => {
      const mockStatusPanel = {
        areAllSubagentsCompleted: jest.fn().mockReturnValue(true),
        clearTerminalSubagents: jest.fn(),
      };

      deps = createSendableDeps({
        getStatusPanel: () => mockStatusPanel as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockStatusPanel.areAllSubagentsCompleted).toHaveBeenCalled();
      // clearTerminalSubagents called twice: once at start, once at response end
      expect(mockStatusPanel.clearTerminalSubagents).toHaveBeenCalledTimes(2);
    });

    it('should only call clearTerminalSubagents at start when subagents still running', async () => {
      const mockStatusPanel = {
        areAllSubagentsCompleted: jest.fn().mockReturnValue(false),
        clearTerminalSubagents: jest.fn(),
      };

      deps = createSendableDeps({
        getStatusPanel: () => mockStatusPanel as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockStatusPanel.areAllSubagentsCompleted).toHaveBeenCalled();
      // clearTerminalSubagents called once at start (not at response end since subagents still running)
      expect(mockStatusPanel.clearTerminalSubagents).toHaveBeenCalledTimes(1);
    });

    it('should handle null statusPanel gracefully', async () => {
      deps = createSendableDeps({
        getStatusPanel: () => null,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Test message';
      controller = new InputController(deps);

      await expect(controller.sendMessage()).resolves.not.toThrow();
    });
  });

  describe('Approval modal tracking', () => {
    it('should dismiss pending modal and clear reference', () => {
      controller = new InputController(deps);
      const mockModal = { close: jest.fn() };
      (controller as any).pendingApprovalModal = mockModal;

      controller.dismissPendingApproval();

      expect(mockModal.close).toHaveBeenCalled();
      expect((controller as any).pendingApprovalModal).toBeNull();
    });

    it('should be a no-op when no modal is pending', () => {
      controller = new InputController(deps);
      expect((controller as any).pendingApprovalModal).toBeNull();
      expect(() => controller.dismissPendingApproval()).not.toThrow();
    });
  });

  describe('Built-in commands - /add-dir', () => {
    beforeEach(() => {
      mockNotice.mockClear();
    });

    it('should show error notice when external context selector is not available', async () => {
      deps.getExternalContextSelector = () => null;
      inputEl.value = '/add-dir /some/path';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockNotice).toHaveBeenCalledWith('External context selector not available.');
      expect(inputEl.value).toBe('');
    });

    it('should show success notice when path is added successfully', async () => {
      const mockExternalContextSelector = {
        getExternalContexts: jest.fn().mockReturnValue([]),
        addExternalContext: jest.fn().mockReturnValue({ success: true, normalizedPath: '/some/path' }),
      };
      deps.getExternalContextSelector = () => mockExternalContextSelector;
      inputEl.value = '/add-dir /some/path';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockExternalContextSelector.addExternalContext).toHaveBeenCalledWith('/some/path');
      expect(mockNotice).toHaveBeenCalledWith('Added external context: /some/path');
      expect(inputEl.value).toBe('');
    });

    it('should show error notice when /add-dir is called without path', async () => {
      const mockExternalContextSelector = {
        getExternalContexts: jest.fn().mockReturnValue([]),
        addExternalContext: jest.fn().mockReturnValue({
          success: false,
          error: 'No path provided. Usage: /add-dir /absolute/path',
        }),
      };
      deps.getExternalContextSelector = () => mockExternalContextSelector;
      inputEl.value = '/add-dir';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockExternalContextSelector.addExternalContext).toHaveBeenCalledWith('');
      expect(mockNotice).toHaveBeenCalledWith('No path provided. Usage: /add-dir /absolute/path');
      expect(inputEl.value).toBe('');
    });

    it('should show error notice when path addition fails', async () => {
      const mockExternalContextSelector = {
        getExternalContexts: jest.fn().mockReturnValue([]),
        addExternalContext: jest.fn().mockReturnValue({
          success: false,
          error: 'Path must be absolute. Usage: /add-dir /absolute/path',
        }),
      };
      deps.getExternalContextSelector = () => mockExternalContextSelector;
      inputEl.value = '/add-dir relative/path';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockExternalContextSelector.addExternalContext).toHaveBeenCalledWith('relative/path');
      expect(mockNotice).toHaveBeenCalledWith('Path must be absolute. Usage: /add-dir /absolute/path');
      expect(inputEl.value).toBe('');
    });

    it('should handle /add-dir with home path expansion', async () => {
      const expandedPath = '/Users/test/projects';
      const mockExternalContextSelector = {
        getExternalContexts: jest.fn().mockReturnValue([]),
        addExternalContext: jest.fn().mockReturnValue({ success: true, normalizedPath: expandedPath }),
      };
      deps.getExternalContextSelector = () => mockExternalContextSelector;
      inputEl.value = '/add-dir ~/projects';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockExternalContextSelector.addExternalContext).toHaveBeenCalledWith('~/projects');
      expect(mockNotice).toHaveBeenCalledWith(`Added external context: ${expandedPath}`);
    });

    it('should handle /add-dir with quoted path', async () => {
      const normalizedPath = '/path/with spaces';
      const mockExternalContextSelector = {
        getExternalContexts: jest.fn().mockReturnValue([]),
        addExternalContext: jest.fn().mockReturnValue({ success: true, normalizedPath }),
      };
      deps.getExternalContextSelector = () => mockExternalContextSelector;
      inputEl.value = '/add-dir "/path/with spaces"';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockExternalContextSelector.addExternalContext).toHaveBeenCalledWith('"/path/with spaces"');
      expect(mockNotice).toHaveBeenCalledWith(`Added external context: ${normalizedPath}`);
    });
  });

  describe('Built-in commands - /clear', () => {
    it('should call conversationController.createNew on /clear', async () => {
      (deps.conversationController as any).createNew = jest.fn().mockResolvedValue(undefined);
      inputEl.value = '/clear';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect((deps.conversationController as any).createNew).toHaveBeenCalled();
      expect(inputEl.value).toBe('');
    });
  });

  describe('Cancel streaming - restore behavior', () => {
    it('should set cancelRequested and call agent cancel', () => {
      deps.state.isStreaming = true;
      controller = new InputController(deps);

      controller.cancelStreaming();

      expect(deps.state.cancelRequested).toBe(true);
      expect((deps as any).mockAgentService.cancel).toHaveBeenCalled();
    });

    it('should restore queued message to input when cancelling', () => {
      deps.state.isStreaming = true;
      deps.state.queuedMessage = { content: 'restored text', images: undefined, editorContext: null };
      controller = new InputController(deps);

      controller.cancelStreaming();

      expect(deps.state.queuedMessage).toBeNull();
      expect(inputEl.value).toBe('restored text');
    });

    it('should restore queued images to image context manager when cancelling', () => {
      deps.state.isStreaming = true;
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      deps.state.queuedMessage = { content: 'msg', images: mockImages as any, editorContext: null };

      controller = new InputController(deps);
      controller.cancelStreaming();

      const imageContextManager = deps.getImageContextManager()!;
      expect(imageContextManager.setImages).toHaveBeenCalledWith(mockImages);
    });

    it('should hide thinking indicator when cancelling', () => {
      deps.state.isStreaming = true;
      controller = new InputController(deps);

      controller.cancelStreaming();

      expect(deps.streamController.hideThinkingIndicator).toHaveBeenCalled();
    });

    it('should be a no-op when not streaming', () => {
      deps.state.isStreaming = false;
      controller = new InputController(deps);

      controller.cancelStreaming();

      expect(deps.state.cancelRequested).toBe(false);
      expect((deps as any).mockAgentService.cancel).not.toHaveBeenCalled();
    });
  });

  describe('ensureServiceInitialized failure', () => {
    beforeEach(() => {
      mockNotice.mockClear();
    });

    it('should show Notice and reset streaming when ensureServiceInitialized returns false', async () => {
      deps = createSendableDeps({
        ensureServiceInitialized: jest.fn().mockResolvedValue(false),
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockNotice).toHaveBeenCalledWith('Failed to initialize agent service. Please try again.');
      expect(deps.streamController.hideThinkingIndicator).toHaveBeenCalled();
      expect(deps.state.isStreaming).toBe(false);
      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
    });
  });

  describe('Agent service null', () => {
    beforeEach(() => {
      mockNotice.mockClear();
    });

    it('should show Notice when getAgentService returns null', async () => {
      deps = createSendableDeps({
        getAgentService: () => null,
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(mockNotice).toHaveBeenCalledWith('Agent service not available. Please reload the plugin.');
      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
    });
  });

  describe('Streaming error handling', () => {
    it('should catch errors and display via appendText', async () => {
      deps = createSendableDeps();

      ((deps as any).mockAgentService.query as jest.Mock).mockImplementation(() => {
        throw new Error('Network timeout');
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.streamController.appendText).toHaveBeenCalledWith('\n\n**Error:** Network timeout');
      expect(deps.state.isStreaming).toBe(false);
    });

    it('should handle non-Error thrown values', async () => {
      deps = createSendableDeps();

      ((deps as any).mockAgentService.query as jest.Mock).mockImplementation(() => {
        throw 'string error';
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.streamController.appendText).toHaveBeenCalledWith('\n\n**Error:** Unknown error');
    });
  });

  describe('Stream interruption', () => {
    it('should append interrupted text when cancelRequested is true', async () => {
      deps = createSendableDeps();

      ((deps as any).mockAgentService.query as jest.Mock).mockImplementation(() => {
        return (async function* () {
          // Simulate cancel requested during streaming
          deps.state.cancelRequested = true;
          yield { type: 'text', content: 'partial' };
        })();
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect(deps.streamController.appendText).toHaveBeenCalledWith(
        expect.stringContaining('Interrupted')
      );
      expect(deps.state.isStreaming).toBe(false);
      expect(deps.state.cancelRequested).toBe(false);
    });
  });

  describe('Duration footer', () => {
    it('should render response duration footer when durationSeconds > 0', async () => {
      deps = createSendableDeps();

      // First call sets responseStartTime; must be non-zero (0 is falsy and skips duration)
      let callCount = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => {
        callCount++;
        // Returns 1000 for responseStartTime, 6000 for elapsed (5 seconds)
        return callCount <= 1 ? 1000 : 6000;
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      const assistantMsg = deps.state.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.durationSeconds).toBe(5);
      expect(assistantMsg!.durationFlavorWord).toBeDefined();

      jest.spyOn(performance, 'now').mockRestore();
    });
  });

  describe('External context in query', () => {
    it('should pass externalContextPaths in queryOptions', async () => {
      const externalPaths = ['/external/path1', '/external/path2'];

      deps = createSendableDeps({
        getExternalContextSelector: () => ({
          getExternalContexts: () => externalPaths,
          addExternalContext: jest.fn(),
        }),
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      const queryCall = ((deps as any).mockAgentService.query as jest.Mock).mock.calls[0];
      const queryOptions = queryCall[3];
      expect(queryOptions.externalContextPaths).toEqual(externalPaths);
    });
  });

  describe('Editor context', () => {
    it('should append editorContext to prompt when available', async () => {
      const editorContext = {
        notePath: 'test/note.md',
        mode: 'selection' as const,
        selectedText: 'selected text content',
      };

      deps = createSendableDeps();
      (deps.selectionController.getContext as jest.Mock).mockReturnValue(editorContext);

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'hello';
      controller = new InputController(deps);

      await controller.sendMessage();

      const queryCall = ((deps as any).mockAgentService.query as jest.Mock).mock.calls[0];
      const promptSent = queryCall[0];
      expect(promptSent).toContain('selected text content');
      expect(promptSent).toContain('test/note.md');
    });
  });

  describe('Built-in commands - unknown', () => {
    beforeEach(() => {
      mockNotice.mockClear();
    });

    it('should show Notice for unknown built-in command', async () => {
      // Directly call the private method since there's no public API to trigger unknown commands
      controller = new InputController(deps);

      await (controller as any).executeBuiltInCommand('nonexistent-command', '');

      expect(mockNotice).toHaveBeenCalledWith('Unknown command: nonexistent-command');
    });
  });

  describe('Title generation callback branches', () => {
    it('should rename conversation when title generation callback succeeds', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockImplementation(
          async (convId: string, _user: string, callback: any) => {
            (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
              id: convId,
              title: 'Test Title',
            });
            await callback(convId, { success: true, title: 'AI Generated Title' });
          }
        ),
        cancel: jest.fn(),
      };

      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'text', content: 'Response' }, { type: 'done' }])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') msg.content = chunk.content;
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'AI Generated Title');
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'success',
      });
    });

    it('should mark as failed when title generation callback fails', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockImplementation(
          async (convId: string, _user: string, callback: any) => {
            (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
              id: convId,
              title: 'Test Title',
            });
            await callback(convId, { success: false, title: '' });
          }
        ),
        cancel: jest.fn(),
      };

      deps = createSendableDeps({
        getTitleGenerationService: () => mockTitleService as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'text', content: 'Response' }, { type: 'done' }])
      );

      (deps.streamController.handleStreamChunk as jest.Mock).mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') msg.content = chunk.content;
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'Hello world';
      controller = new InputController(deps);

      await controller.sendMessage();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'failed',
      });
    });
  });

  describe('handleApprovalRequest', () => {
    it('should create and store approval modal as pending', async () => {
      controller = new InputController(deps);

      // void: promise won't resolve until the approval callback fires
      void controller.handleApprovalRequest(
        'bash',
        { command: 'ls -la' },
        'Run shell command'
      );

      expect((controller as any).pendingApprovalModal).not.toBeNull();
      expect((controller as any).pendingApprovalModal.open).toHaveBeenCalled();

      controller.dismissPendingApproval();
      expect((controller as any).pendingApprovalModal).toBeNull();
    });
  });

  describe('handleInstructionSubmit', () => {
    it('should create InstructionModal and call refineInstruction', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService({
        refineInstruction: jest.fn().mockResolvedValue({
          success: true,
          refinedInstruction: 'refined instruction',
        }),
      });
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      deps.plugin.settings.systemPrompt = '';

      controller = new InputController(deps);

      await controller.handleInstructionSubmit('add logging');

      expect(mockInstructionRefineService.resetConversation).toHaveBeenCalled();
      expect(mockInstructionRefineService.refineInstruction).toHaveBeenCalledWith(
        'add logging',
        ''
      );
    });

    it('should return early when instructionRefineService is null', async () => {
      deps = createMockDeps({
        getInstructionRefineService: () => null,
      });
      controller = new InputController(deps);

      await expect(controller.handleInstructionSubmit('test')).resolves.not.toThrow();
    });
  });

  describe('processQueuedMessage restores images', () => {
    it('should restore images from queued message', () => {
      jest.useFakeTimers();
      try {
        const mockImages = [{ id: 'img1', name: 'test.png' }];
        deps.state.queuedMessage = {
          content: 'queued content',
          images: mockImages as any,
          editorContext: null,
        };
        const imageContextManager = deps.getImageContextManager()!;
        const sendSpy = jest.spyOn(controller, 'sendMessage').mockResolvedValue(undefined);

        (controller as any).processQueuedMessage();
        jest.runAllTimers();

        expect(imageContextManager.setImages).toHaveBeenCalledWith(mockImages);
        sendSpy.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Sending messages - edge cases', () => {
    it('should not send empty message without images', async () => {
      inputEl.value = '';
      const imageContextManager = deps.getImageContextManager()!;
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(false);

      await controller.sendMessage();

      expect((deps as any).mockAgentService.query).not.toHaveBeenCalled();
    });

    it('should send message with only images (empty text)', async () => {
      const imageContextManager = createMockImageContextManager();
      (imageContextManager.hasImages as jest.Mock).mockReturnValue(true);
      (imageContextManager.getAttachedImages as jest.Mock).mockReturnValue([{ id: 'img1', name: 'test.png' }]);

      deps = createSendableDeps({
        getImageContextManager: () => imageContextManager as any,
      });

      ((deps as any).mockAgentService.query as jest.Mock).mockReturnValue(
        createMockStream([{ type: 'done' }])
      );

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = '';
      controller = new InputController(deps);

      await controller.sendMessage();

      expect((deps as any).mockAgentService.query).toHaveBeenCalled();
      expect(deps.state.messages).toHaveLength(2);
      expect(deps.state.messages[0].images).toHaveLength(1);
    });
  });

  describe('Stream invalidation', () => {
    it('should break from stream loop and skip cleanup when stream generation changes', async () => {
      deps = createSendableDeps();

      ((deps as any).mockAgentService.query as jest.Mock).mockImplementation(() => {
        return (async function* () {
          yield { type: 'text', content: 'partial' };
          // Simulate stream invalidation (e.g. tab closed during stream)
          deps.state.bumpStreamGeneration();
          yield { type: 'text', content: 'should not be processed' };
        })();
      });

      inputEl = deps.getInputEl() as ReturnType<typeof createMockInputEl>;
      inputEl.value = 'test message';
      controller = new InputController(deps);

      await controller.sendMessage();

      // The stream was invalidated, so isStreaming should still be true
      // (cleanup was skipped) and no interrupt text should appear
      expect(deps.streamController.appendText).not.toHaveBeenCalledWith(
        expect.stringContaining('Interrupted')
      );
    });
  });

  describe('handleInstructionSubmit - advanced paths', () => {
    it('should show clarification when result has clarification', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService({
        refineInstruction: jest.fn().mockResolvedValue({
          success: true,
          clarification: 'Please clarify what you mean',
        }),
      });
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      controller = new InputController(deps);

      await controller.handleInstructionSubmit('ambiguous instruction');

      expect(mockInstructionRefineService.refineInstruction).toHaveBeenCalledWith(
        'ambiguous instruction',
        undefined
      );
    });

    it('should show error when result has no clarification or instruction', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService();
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      controller = new InputController(deps);
      mockNotice.mockClear();

      await controller.handleInstructionSubmit('empty result');

      expect(mockNotice).toHaveBeenCalledWith('No instruction received');
      expect(mockInstructionModeManager.clear).toHaveBeenCalled();
    });

    it('should handle cancelled result from refineInstruction', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService({
        refineInstruction: jest.fn().mockResolvedValue({
          success: false,
          error: 'Cancelled',
        }),
      });
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      controller = new InputController(deps);

      await controller.handleInstructionSubmit('cancelled instruction');

      expect(mockInstructionModeManager.clear).toHaveBeenCalled();
      expect(mockNotice).not.toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    });

    it('should handle non-cancelled error from refineInstruction', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService({
        refineInstruction: jest.fn().mockResolvedValue({
          success: false,
          error: 'API Error',
        }),
      });
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      controller = new InputController(deps);
      mockNotice.mockClear();

      await controller.handleInstructionSubmit('error instruction');

      expect(mockNotice).toHaveBeenCalledWith('API Error');
      expect(mockInstructionModeManager.clear).toHaveBeenCalled();
    });

    it('should handle exception thrown during refineInstruction', async () => {
      const mockInstructionRefineService = createMockInstructionRefineService({
        refineInstruction: jest.fn().mockRejectedValue(new Error('Unexpected error')),
      });
      const mockInstructionModeManager = createMockInstructionModeManager();

      deps = createMockDeps({
        getInstructionRefineService: () => mockInstructionRefineService as any,
        getInstructionModeManager: () => mockInstructionModeManager as any,
      });
      controller = new InputController(deps);
      mockNotice.mockClear();

      await controller.handleInstructionSubmit('error instruction');

      expect(mockNotice).toHaveBeenCalledWith('Error: Unexpected error');
      expect(mockInstructionModeManager.clear).toHaveBeenCalled();
    });
  });
});
