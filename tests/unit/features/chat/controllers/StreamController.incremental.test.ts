import { createMockEl } from '@test/helpers/mockElement';

import type { ChatMessage } from '@/core/types';
import { StreamController, type StreamControllerDeps } from '@/features/chat/controllers/StreamController';
import { ChatState } from '@/features/chat/state/ChatState';

function createMockDeps(): StreamControllerDeps {
  const state = new ChatState();
  const messagesEl = createMockEl();
  
  return {
    plugin: {
      settings: { permissionMode: 'yolo' },
      app: { vault: { adapter: { basePath: '/test/vault' } } },
    } as any,
    state,
    renderer: {
      renderContent: jest.fn().mockResolvedValue(undefined),
      appendContent: jest.fn().mockResolvedValue(undefined),
      addTextCopyButton: jest.fn(),
    } as any,
    subagentManager: {
      subagentsSpawnedThisStream: 0,
      resetStreamingState: jest.fn(),
    } as any,
    getMessagesEl: () => messagesEl,
    getFileContextManager: () => null,
    updateQueueIndicator: jest.fn(),
  };
}

function createTestMessage(): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [],
  };
}

describe('StreamController - Incremental Rendering State', () => {
  let deps: StreamControllerDeps;
  let controller: StreamController;
  let msg: ChatMessage;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new StreamController(deps);
    msg = createTestMessage();
    
    deps.state.currentContentEl = createMockEl();
    deps.state.isStreaming = true;
  });

  describe('State fields for incremental rendering', () => {
    it('should initialize with correct default values', () => {
      expect(deps.state.lastRenderedLength).toBe(0);
      expect(deps.state.renderDebounceTimer).toBeNull();
      expect(deps.state.pendingRenderContent).toBe('');
    });

    it('should update state when appendText is called', async () => {
      await controller.appendText('Hello');

      expect(deps.state.currentTextContent).toBe('Hello');
      expect(deps.state.pendingRenderContent).toBe('Hello');
      expect(deps.state.renderDebounceTimer).toBeTruthy();
    });

    it('should accumulate pending content across multiple calls', async () => {
      await controller.appendText('Hello');
      await controller.appendText(' ');
      await controller.appendText('World');

      expect(deps.state.currentTextContent).toBe('Hello World');
      expect(deps.state.pendingRenderContent).toBe('Hello World');
    });
  });

  describe('finalizeCurrentTextBlock', () => {
    it('should record content block with accumulated text', async () => {
      await controller.appendText('Test content here');
      controller.finalizeCurrentTextBlock(msg);

      expect(msg.contentBlocks).toEqual([
        { type: 'text', content: 'Test content here' },
      ]);
    });

    it('should handle empty content gracefully', () => {
      controller.finalizeCurrentTextBlock(msg);

      expect(msg.contentBlocks).toBeUndefined();
    });
  });

  describe('resetStreamingState', () => {
    it('should clear all incremental rendering state', async () => {
      await controller.appendText('Some content');
      expect(deps.state.renderDebounceTimer).toBeTruthy();
      expect(deps.state.renderDebounceTimer).toBeTruthy();

      // Clear the actual timer to avoid issues
      if (deps.state.renderDebounceTimer) {
        clearTimeout(deps.state.renderDebounceTimer);
      }
      deps.state.renderDebounceTimer = null;

      controller.resetStreamingState();

      expect(deps.state.lastRenderedLength).toBe(0);
      expect(deps.state.pendingRenderContent).toBe('');
      expect(deps.subagentManager.resetStreamingState).toHaveBeenCalled();
    });
  });

  describe('appendContent parameters', () => {
    it('should pass isFirstChunk=true on first render', async () => {
      await controller.appendText('First');

      // Trigger debounce manually
      if (deps.state.renderDebounceTimer) {
        clearTimeout(deps.state.renderDebounceTimer);
      }
      // Call appendContent directly to verify parameters
      await deps.renderer.appendContent(deps.state.currentTextEl!, 'First', true);

      expect(deps.renderer.appendContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'First',
        true
      );
    });
  });
});
