/**
 * Tests for InputController - Message Queue and Input Handling
 */

import { InputController, type InputControllerDeps } from '../src/features/chat/controllers/InputController';
import { ChatState } from '../src/features/chat/state/ChatState';

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
      generateTitle: jest.fn().mockReturnValue('Test Title'),
    } as any,
    getInputEl: () => inputEl,
    getWelcomeEl: () => null,
    getMessagesEl: () => createMockElement() as any,
    getFileContextManager: () => ({
      startSession: jest.fn(),
      getAttachedFiles: jest.fn().mockReturnValue(new Set()),
      hasFilesChanged: jest.fn().mockReturnValue(false),
      markFilesSent: jest.fn(),
    }) as any,
    getImageContextManager: () => imageContextManager as any,
    getSlashCommandManager: () => null,
    getMcpServerSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    generateId: () => `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
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
});
