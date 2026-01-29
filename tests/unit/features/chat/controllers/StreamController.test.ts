import { createMockEl } from '@test/helpers/mockElement';

import { TOOL_AGENT_OUTPUT, TOOL_TASK, TOOL_TODO_WRITE } from '@/core/tools/toolNames';
import type { ChatMessage } from '@/core/types';
import { StreamController, type StreamControllerDeps } from '@/features/chat/controllers/StreamController';
import { ChatState } from '@/features/chat/state/ChatState';

jest.mock('@/core/tools', () => {
  return {
    parseTodoInput: jest.fn(),
  };
});

jest.mock('@/features/chat/rendering', () => {
  return {
    addSubagentToolCall: jest.fn(),
    appendThinkingContent: jest.fn(),
    createAsyncSubagentBlock: jest.fn().mockReturnValue({}),
    createSubagentBlock: jest.fn().mockReturnValue({
      info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
    }),
    createThinkingBlock: jest.fn().mockReturnValue({
      container: {},
      contentEl: {},
      content: '',
      startTime: Date.now(),
    }),
    createWriteEditBlock: jest.fn().mockReturnValue({}),
    finalizeAsyncSubagent: jest.fn(),
    finalizeSubagentBlock: jest.fn(),
    finalizeThinkingBlock: jest.fn().mockReturnValue(0),
    finalizeWriteEditBlock: jest.fn(),
    getToolLabel: jest.fn().mockReturnValue('Tool'),
    isBlockedToolResult: jest.fn().mockReturnValue(false),
    markAsyncSubagentOrphaned: jest.fn(),
    renderToolCall: jest.fn(),
    updateAsyncSubagentRunning: jest.fn(),
    updateSubagentToolResult: jest.fn(),
    updateToolCallResult: jest.fn(),
    updateWriteEditWithDiff: jest.fn(),
  };
});

function createMockDeps(): StreamControllerDeps {
  const state = new ChatState();
  const messagesEl = createMockEl();
  const agentService = {
    getSessionId: jest.fn().mockReturnValue('session-1'),
  };
  const fileContextManager = {
    markFileBeingEdited: jest.fn(),
    trackEditedFile: jest.fn(),
    getAttachedFiles: jest.fn().mockReturnValue(new Set()),
    hasFilesChanged: jest.fn().mockReturnValue(false),
  };

  return {
    plugin: {
      settings: {
        permissionMode: 'yolo',
      },
      app: {
        vault: {
          adapter: {
            basePath: '/test/vault',
          },
        },
      },
    } as any,
    state,
    renderer: {
      renderContent: jest.fn(),
      addTextCopyButton: jest.fn(),
    } as any,
    subagentManager: {
      isAsyncTask: jest.fn().mockReturnValue(false),
      isPendingAsyncTask: jest.fn().mockReturnValue(false),
      isLinkedAgentOutputTool: jest.fn().mockReturnValue(false),
      handleAgentOutputToolResult: jest.fn().mockReturnValue(undefined),
      handleAgentOutputToolUse: jest.fn(),
      handleTaskToolUse: jest.fn().mockReturnValue({ action: 'buffered' }),
      handleTaskToolResult: jest.fn(),
      hasPendingTask: jest.fn().mockReturnValue(false),
      renderPendingTask: jest.fn().mockReturnValue(null),
      getSyncSubagent: jest.fn().mockReturnValue(undefined),
      addSyncToolCall: jest.fn(),
      updateSyncToolResult: jest.fn(),
      finalizeSyncSubagent: jest.fn().mockReturnValue(null),
      resetStreamingState: jest.fn(),
      resetSpawnedCount: jest.fn(),
      subagentsSpawnedThisStream: 0,
    } as any,
    getMessagesEl: () => messagesEl,
    getFileContextManager: () => fileContextManager as any,
    updateQueueIndicator: jest.fn(),
    getAgentService: () => agentService as any,
  };
}

function createTestMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [],
    contentBlocks: [],
  };
}

function createMockUsage(overrides: Record<string, any> = {}) {
  return {
    model: 'model-a',
    inputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 100,
    contextTokens: 10,
    percentage: 10,
    ...overrides,
  };
}

describe('StreamController - Text Content', () => {
  let controller: StreamController;
  let deps: StreamControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    deps = createMockDeps();
    controller = new StreamController(deps);
    deps.state.currentContentEl = createMockEl();
  });

  afterEach(() => {
    // Clean up any timers set by ChatState
    deps.state.resetStreamingState();
    jest.useRealTimers();
  });

  describe('Text streaming', () => {
    it('should append text content to message', async () => {
      const msg = createTestMessage();

      deps.state.currentTextEl = createMockEl();

      await controller.handleStreamChunk({ type: 'text', content: 'Hello ' }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'World' }, msg);

      expect(msg.content).toBe('Hello World');
    });

    it('should accumulate text across multiple chunks', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      const chunks = ['This ', 'is ', 'a ', 'test.'];
      for (const chunk of chunks) {
        await controller.handleStreamChunk({ type: 'text', content: chunk }, msg);
      }

      expect(msg.content).toBe('This is a test.');
    });
  });

  describe('Text block finalization', () => {
    it('should add copy button when finalizing text block with content', () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = 'Hello World';

      controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Hello World'
      );
      expect(msg.contentBlocks).toContainEqual({
        type: 'text',
        content: 'Hello World',
      });
    });

    it('should not add copy button when no text element exists', () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = null;
      deps.state.currentTextContent = 'Hello World';

      controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).not.toHaveBeenCalled();
      // Content block should still be added
      expect(msg.contentBlocks).toContainEqual({
        type: 'text',
        content: 'Hello World',
      });
    });

    it('should not add copy button when no text content exists', () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = '';

      controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).not.toHaveBeenCalled();
      expect(msg.contentBlocks).toEqual([]);
    });

    it('should reset text state after finalization', () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = 'Test content';

      controller.finalizeCurrentTextBlock(msg);

      expect(deps.state.currentTextEl).toBeNull();
      expect(deps.state.currentTextContent).toBe('');
    });
  });

  describe('Error and blocked handling', () => {
    it('should append error message on error chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'error', content: 'Something went wrong' },
        msg
      );

      expect(deps.state.currentTextContent).toContain('Error');
    });

    it('should append blocked message on blocked chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'blocked', content: 'Tool was blocked' },
        msg
      );

      expect(deps.state.currentTextContent).toContain('Blocked');
    });
  });

  describe('Done chunk handling', () => {
    it('should handle done chunk without error', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      // Should not throw
      await expect(
        controller.handleStreamChunk({ type: 'done' }, msg)
      ).resolves.not.toThrow();
    });
  });

  describe('Usage handling', () => {
    it('should update usage for current session', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('should ignore usage from other sessions', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-2' }, msg);

      expect(deps.state.usage).toBeNull();
    });
  });

  describe('Tool handling', () => {
    it('should record tool_use and add to content blocks', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'notes/test.md' } },
        msg
      );

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0].id).toBe('tool-1');
      expect(msg.toolCalls![0].status).toBe('running');
      expect(msg.contentBlocks).toHaveLength(1);
      expect(msg.contentBlocks![0]).toEqual({ type: 'tool_use', toolId: 'tool-1' });

      // Thinking indicator is debounced - advance timer to trigger it
      jest.advanceTimersByTime(500);
      expect(deps.updateQueueIndicator).toHaveBeenCalled();
    });

    it('should update tool_result status', async () => {
      const msg = createTestMessage();
      msg.toolCalls = [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: 'notes/test.md' },
          status: 'running',
        } as any,
      ];
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'tool-1', content: 'ok' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('completed');
      expect(msg.toolCalls![0].result).toBe('ok');
    });

    it('should add subagent entry to contentBlocks for Task tool', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Configure mock to return created_sync when run_in_background is known
      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'created_sync',
        subagentState: {
          info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
        },
      });

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'task-1',
          name: TOOL_TASK,
          input: { prompt: 'Do something', subagent_type: 'general-purpose', run_in_background: false },
        },
        msg
      );

      expect(msg.contentBlocks).toHaveLength(1);
      expect(msg.contentBlocks![0]).toEqual({ type: 'subagent', subagentId: 'task-1' });
      expect(msg.subagents).toHaveLength(1);
      expect(msg.subagents![0].id).toBe('task-1');
    });

    it('should render TodoWrite inline and update panel', async () => {
      const { parseTodoInput } = jest.requireMock('@/core/tools');
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const mockTodos = [{ content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' }];
      parseTodoInput.mockReturnValue(mockTodos);

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'todo-1',
          name: TOOL_TODO_WRITE,
          input: { todos: mockTodos },
        },
        msg
      );

      // Tool is buffered, should be in pendingTools
      expect(msg.contentBlocks).toHaveLength(1);
      expect(msg.contentBlocks![0]).toEqual({ type: 'tool_use', toolId: 'todo-1' });
      expect(deps.state.pendingTools.size).toBe(1);

      // Should update currentTodos for panel immediately (side effect)
      expect(deps.state.currentTodos).toEqual(mockTodos);

      // Flush pending tools by sending a different chunk type (text or done)
      await controller.handleStreamChunk({ type: 'done' }, msg);

      // Now renderToolCall should have been called
      expect(renderToolCall).toHaveBeenCalled();
      expect(deps.state.pendingTools.size).toBe(0);
    });

    it('should flush pending tools before rendering text content', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      deps.state.currentTextEl = createMockEl();
      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'read-1', name: 'Read' }),
        expect.any(Map)
      );
    });

    it('should flush pending tools before rendering thinking content', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'test' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      await controller.handleStreamChunk({ type: 'thinking', content: 'Let me think...' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should render pending tool when tool_result arrives before flush', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      // Result arrives while tool still pending - should render tool first
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'read-1', content: 'file contents here' },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
      expect(msg.toolCalls![0].status).toBe('completed');
      expect(msg.toolCalls![0].result).toBe('file contents here');
    });

    it('should buffer Write tool and use createWriteEditBlock on flush', async () => {
      const { createWriteEditBlock, renderToolCall } = jest.requireMock('@/features/chat/rendering');
      createWriteEditBlock.mockReturnValue({ wrapperEl: createMockEl() });

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'test.md', content: 'hello' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(1);
      expect(createWriteEditBlock).not.toHaveBeenCalled();
      expect(renderToolCall).not.toHaveBeenCalled();

      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(createWriteEditBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'write-1', name: 'Write' })
      );
      // renderToolCall should NOT be called for Write/Edit tools
      expect(renderToolCall).not.toHaveBeenCalled();
    });

    it('should buffer Edit tool and use createWriteEditBlock on flush', async () => {
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering');
      createWriteEditBlock.mockReturnValue({ wrapperEl: createMockEl() });

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'test.md', old_string: 'a', new_string: 'b' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(1);
      expect(createWriteEditBlock).not.toHaveBeenCalled();

      deps.state.currentTextEl = createMockEl();
      await controller.handleStreamChunk({ type: 'text', content: 'Done editing' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(createWriteEditBlock).toHaveBeenCalled();
    });

    it('should flush pending tools before rendering blocked message', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);

      await controller.handleStreamChunk({ type: 'blocked', content: 'Command blocked' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should flush pending tools before rendering error message', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'missing.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);

      await controller.handleStreamChunk({ type: 'error', content: 'Something went wrong' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should flush pending tools before Task tool renders', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'created_sync',
        subagentState: {
          info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
        },
      });

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose', run_in_background: false } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
      expect(deps.subagentManager.handleTaskToolUse).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ run_in_background: false }),
        expect.anything()
      );
    });

    it('should re-parse TodoWrite on input updates when streaming completes', async () => {
      const { parseTodoInput } = jest.requireMock('@/core/tools');

      const mockTodos = [
        { content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' },
      ];

      // First chunk: partial input, parsing fails
      parseTodoInput.mockReturnValueOnce(null);

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'todo-1',
          name: TOOL_TODO_WRITE,
          input: { todos: '[' }, // Incomplete JSON
        },
        msg
      );

      // No todos yet
      expect(deps.state.currentTodos).toBeNull();

      // Second chunk: complete input, parsing succeeds
      parseTodoInput.mockReturnValueOnce(mockTodos);

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'todo-1',
          name: TOOL_TODO_WRITE,
          input: { todos: mockTodos },
        },
        msg
      );

      // Now todos should be updated
      expect(deps.state.currentTodos).toEqual(mockTodos);
    });

    it('should clear pendingTools on resetStreamingState', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.md' } },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: 'b.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(2);

      controller.resetStreamingState();

      expect(deps.state.pendingTools.size).toBe(0);
    });

    it('should clear responseStartTime on resetStreamingState', () => {
      deps.state.responseStartTime = 12345;
      expect(deps.state.responseStartTime).toBe(12345);

      controller.resetStreamingState();

      expect(deps.state.responseStartTime).toBeNull();
    });
  });

  describe('Timer lifecycle', () => {
    it('should create timer interval when showing thinking indicator', () => {
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500); // Past the debounce delay

      expect(deps.state.flavorTimerInterval).not.toBeNull();
    });

    it('should clear timer interval when hiding thinking indicator', () => {
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);
      expect(deps.state.flavorTimerInterval).not.toBeNull();

      controller.hideThinkingIndicator();

      expect(deps.state.flavorTimerInterval).toBeNull();
    });

    it('should clear timer interval in resetStreamingState', () => {
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);
      expect(deps.state.flavorTimerInterval).not.toBeNull();

      controller.resetStreamingState();

      expect(deps.state.flavorTimerInterval).toBeNull();
    });

    it('should not create duplicate intervals on multiple showThinkingIndicator calls', () => {
      deps.state.responseStartTime = performance.now();
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);
      const firstInterval = deps.state.flavorTimerInterval;

      // Second call while indicator exists should not create a new interval
      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      // Should still have the same interval (no new one created since element exists)
      expect(deps.state.flavorTimerInterval).toBe(firstInterval);

      clearIntervalSpy.mockRestore();
    });
  });

  describe('Tool handling - continued', () => {
    it('should handle multiple pending tools and flush in order', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.md' } },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'test' } },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: '*.md' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(3);
      expect(renderToolCall).not.toHaveBeenCalled();

      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalledTimes(3);

      // Verify tools were rendered in order (Map preserves insertion order)
      const calls = renderToolCall.mock.calls;
      expect(calls[0][1].id).toBe('read-1');
      expect(calls[1][1].id).toBe('grep-1');
      expect(calls[2][1].id).toBe('glob-1');
    });
  });

  describe('Usage handling - edge cases', () => {
    it('should skip usage when subagentsSpawnedThisStream > 0', async () => {
      const msg = createTestMessage();
      (deps.subagentManager as any).subagentsSpawnedThisStream = 1;

      const usage = createMockUsage({ inputTokens: 100, contextWindow: 200, contextTokens: 100, percentage: 50 });

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toBeNull();
    });

    it('should skip usage when chunk has sessionId but currentSessionId is null', async () => {
      const nullSessionDeps = createMockDeps();
      nullSessionDeps.getAgentService = () => ({ getSessionId: jest.fn().mockReturnValue(null) }) as any;
      nullSessionDeps.state.currentContentEl = createMockEl();
      const nullSessionController = new StreamController(nullSessionDeps);

      const msg = createTestMessage();
      const usage = createMockUsage();

      await nullSessionController.handleStreamChunk({ type: 'usage', usage, sessionId: 'some-session' }, msg);

      expect(nullSessionDeps.state.usage).toBeNull();
    });

    it('should update usage when no sessionId on chunk', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage } as any, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('should not update usage when ignoreUsageUpdates is true', async () => {
      const msg = createTestMessage();
      deps.state.ignoreUsageUpdates = true;

      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toBeNull();
    });
  });

  describe('Thinking indicator - edge cases', () => {
    it('should not show indicator when no currentContentEl', () => {
      deps.state.currentContentEl = null;

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      expect(deps.state.thinkingEl).toBeNull();
    });

    it('should not show indicator when currentThinkingState is active', () => {
      deps.state.currentThinkingState = { content: 'thinking...', container: {}, contentEl: {}, startTime: Date.now() } as any;

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      expect(deps.state.thinkingEl).toBeNull();
    });

    it('should re-append existing indicator to bottom when called again', () => {
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      const thinkingEl = deps.state.thinkingEl;
      expect(thinkingEl).not.toBeNull();

      controller.showThinkingIndicator();

      expect(deps.state.thinkingEl).toBe(thinkingEl);
      expect(deps.updateQueueIndicator).toHaveBeenCalled();
    });
  });

  describe('scrollToBottom - settings', () => {
    it('should not scroll when enableAutoScroll setting is false', async () => {
      (deps.plugin.settings as any).enableAutoScroll = false;
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      messagesEl.scrollTop = 0;

      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      expect(messagesEl.scrollTop).toBe(0);
    });

    it('should not scroll when autoScrollEnabled state is false', async () => {
      deps.state.autoScrollEnabled = false;
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      messagesEl.scrollTop = 0;

      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      expect(messagesEl.scrollTop).toBe(0);
    });
  });

  describe('Subagent chunk handling', () => {
    it('should ignore subagent chunk with text type (no-op)', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
      });

      await controller.handleStreamChunk(
        { type: 'text', content: 'Subagent text', parentToolUseId: 'task-1' } as any,
        msg
      );

      // No text appended to main message
      expect(msg.content).toBe('');
    });

    it('should handle subagent tool_result chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      const toolCall = { id: 'read-1', name: 'Read', input: {}, status: 'running' };
      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [toolCall] },
      });

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'read-1', content: 'file content', parentToolUseId: 'task-1' } as any,
        msg
      );

      expect(deps.subagentManager.updateSyncToolResult).toHaveBeenCalledWith(
        'task-1',
        'read-1',
        expect.objectContaining({ status: 'completed', result: 'file content' })
      );
    });

    it('should handle subagent tool_use chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
      });

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'test' }, parentToolUseId: 'task-1' } as any,
        msg
      );

      expect(deps.subagentManager.addSyncToolCall).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ id: 'grep-1', name: 'Grep', status: 'running' })
      );
    });

    it('should skip subagent chunk when no sync subagent found', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce(undefined);

      await controller.handleStreamChunk(
        { type: 'text', content: 'orphan', parentToolUseId: 'unknown-task' } as any,
        msg
      );

      // Should not throw
      expect(msg.content).toBe('');
    });
  });

  describe('Async subagent handling', () => {
    it('should handle created_async action from Task tool use', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'created_async',
        info: { id: 'task-1', description: 'background task', status: 'running', toolCalls: [], mode: 'async' },
      });

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', run_in_background: true } },
        msg
      );

      expect(msg.subagents).toHaveLength(1);
      expect(msg.contentBlocks).toContainEqual({ type: 'subagent', subagentId: 'task-1', mode: 'async' });
    });

    it('should handle label_updated action from Task tool use (no-op for message)', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'label_updated',
      });

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Updated' } },
        msg
      );

      expect(msg.subagents).toBeUndefined();
      expect(msg.contentBlocks).toEqual([]);
    });
  });

  describe('onAsyncSubagentStateChange', () => {
    it('should update subagent in messages', () => {
      const subagent = { id: 'task-1', description: 'test', status: 'completed', result: 'done', toolCalls: [] } as any;
      deps.state.messages = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        subagents: [{ id: 'task-1', description: 'test', status: 'running', toolCalls: [] }],
      }] as any;

      controller.onAsyncSubagentStateChange(subagent);

      expect(deps.state.messages[0].subagents![0].status).toBe('completed');
      expect(deps.state.messages[0].subagents![0].result).toBe('done');
    });

    it('should not crash when subagent not found in messages', () => {
      const subagent = { id: 'unknown', description: 'test', status: 'completed', toolCalls: [] } as any;
      deps.state.messages = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        subagents: [{ id: 'task-1', description: 'test', status: 'running', toolCalls: [] }],
      }] as any;

      expect(() => controller.onAsyncSubagentStateChange(subagent)).not.toThrow();
    });
  });

  describe('Thinking block finalization', () => {
    it('should finalize thinking block and add to contentBlocks', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      deps.state.currentThinkingState = {
        content: 'Let me think...',
        container: createMockEl(),
        contentEl: createMockEl(),
        startTime: Date.now(),
      } as any;

      controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Let me think...' })
      );
      expect(deps.state.currentThinkingState).toBeNull();
    });

    it('should not add to contentBlocks when no thinking content', () => {
      const msg = createTestMessage();
      deps.state.currentThinkingState = {
        content: '',
        container: createMockEl(),
        contentEl: createMockEl(),
        startTime: Date.now(),
      } as any;

      controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });

    it('should be a no-op when no thinking state', () => {
      const msg = createTestMessage();
      deps.state.currentThinkingState = null;

      controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });
  });

  describe('Pending Task tool handling', () => {
    it('should render pending Task as sync when child chunk arrives', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Task without run_in_background - manager returns buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Manager's handleTaskToolUse should have been called
      expect(deps.subagentManager.handleTaskToolUse).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ prompt: 'Do something' }),
        expect.anything()
      );

      // Configure manager for child chunk: pending task exists, render returns sync
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTask as jest.Mock).mockReturnValueOnce({
        mode: 'sync',
        subagentState: {
          info: { id: 'task-1', description: 'Do something', status: 'running', toolCalls: [] },
        },
      });
      // Also configure getSyncSubagent for the child chunk routing
      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'Do something', status: 'running', toolCalls: [] },
      });

      // Child chunk arrives with parentToolUseId - should trigger render
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, parentToolUseId: 'task-1' } as any,
        msg
      );

      // Message should have subagent added
      expect(msg.subagents).toHaveLength(1);
      expect(msg.subagents![0].id).toBe('task-1');
      expect(deps.subagentManager.renderPendingTask).toHaveBeenCalledWith('task-1', deps.state.currentContentEl);
    });

    it('should not crash stream when pending Task rendering returns null via child chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Task without run_in_background - manager returns buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Configure manager: pending task exists but render returns null (error case)
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTask as jest.Mock).mockReturnValueOnce(null);

      // Child chunk arrives - renderPendingTask returns null but shouldn't crash
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, parentToolUseId: 'task-1' } as any,
        msg
      );

      // Should not throw - manager handled errors internally
      expect(deps.subagentManager.renderPendingTask).toHaveBeenCalledWith('task-1', deps.state.currentContentEl);
    });

    it('should not crash stream when pending Task rendering returns null via tool_result', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Task without run_in_background - manager returns buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Configure manager: pending task exists but render returns null
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTask as jest.Mock).mockReturnValueOnce(null);

      // Tool result arrives - renderPendingTask returns null but shouldn't crash
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task completed' },
        msg
      );

      // Should not throw - manager handled errors internally
      expect(deps.subagentManager.renderPendingTask).toHaveBeenCalledWith('task-1', deps.state.currentContentEl);
    });
  });

  describe('Text ↔ Thinking transitions', () => {
    it('text arrives while thinking state is active → finalizeCurrentThinkingBlock is called', async () => {
      const { finalizeThinkingBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      deps.state.currentThinkingState = {
        content: 'Let me think...',
        container: createMockEl(),
        contentEl: createMockEl(),
        startTime: Date.now(),
      } as any;

      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      expect(finalizeThinkingBlock).toHaveBeenCalled();
      expect(deps.state.currentThinkingState).toBeNull();
      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Let me think...' })
      );
    });

    it('thinking arrives while textEl exists → finalizeCurrentTextBlock is called', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = 'Some text';

      await controller.handleStreamChunk({ type: 'thinking', content: 'Hmm...' }, msg);

      expect(deps.state.currentTextEl).toBeNull();
      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'text', content: 'Some text' })
      );
      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Some text'
      );
    });

    it('tool_use arrives while thinking state → finalizeCurrentThinkingBlock is called', async () => {
      const { finalizeThinkingBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      deps.state.currentThinkingState = {
        content: 'Reasoning...',
        container: createMockEl(),
        contentEl: createMockEl(),
        startTime: Date.now(),
      } as any;

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );

      expect(finalizeThinkingBlock).toHaveBeenCalled();
      expect(deps.state.currentThinkingState).toBeNull();
      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Reasoning...' })
      );
    });
  });

  describe('Agent output tool use/result', () => {
    it('TOOL_AGENT_OUTPUT chunk creates tool call and delegates to subagentManager.handleAgentOutputToolUse', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'agent-out-1', name: TOOL_AGENT_OUTPUT, input: { task_id: 'task-1' } },
        msg
      );

      expect(deps.subagentManager.handleAgentOutputToolUse).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-out-1',
          name: TOOL_AGENT_OUTPUT,
          status: 'running',
        })
      );
      expect(msg.toolCalls).toEqual([]);
      expect(msg.contentBlocks).toEqual([]);
    });

    it('Agent output tool result handled via handleAgentOutputToolResult returning true', async () => {
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce({});

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-1', content: 'agent result' },
        msg
      );

      expect(deps.subagentManager.handleAgentOutputToolResult).toHaveBeenCalledWith(
        'agent-out-1',
        'agent result',
        false
      );
      expect(updateToolCallResult).not.toHaveBeenCalled();
    });
  });

  describe('Tool label update on input re-dispatch', () => {
    it('second tool_use with same id updates existing tool input and label', async () => {
      const { getToolLabel } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // First tool_use - creates the tool call
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );

      // Flush the tool so it transitions from pending to rendered
      await controller.handleStreamChunk({ type: 'done' }, msg);

      // Manually set up a rendered tool element with a label child
      // (the mock renderToolCall doesn't actually populate toolCallElements)
      const toolEl = createMockEl();
      const labelChild = toolEl.createDiv({ cls: 'claudian-tool-label' });
      labelChild.setText('Read: test.md');
      deps.state.toolCallElements.set('read-1', toolEl);

      getToolLabel.mockReturnValueOnce('Read: updated.md');

      // Second tool_use with same id - should update input and label
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'updated.md' } },
        msg
      );

      // Input should be merged
      expect(msg.toolCalls![0].input).toEqual(
        expect.objectContaining({ file_path: 'updated.md' })
      );
      // getToolLabel should have been called with updated input
      expect(getToolLabel).toHaveBeenCalledWith('Read', expect.objectContaining({ file_path: 'updated.md' }));
      // Label text should be updated
      expect(labelChild.textContent).toBe('Read: updated.md');
    });
  });

  describe('Sync subagent finalization', () => {
    it('tool_result for a sync subagent calls finalizeSyncSubagent and updates message subagents', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      msg.subagents = [
        { id: 'task-1', description: 'Do something', status: 'running', toolCalls: [], isExpanded: false },
      ];

      // getSyncSubagent returns a subagent state (indicating this is a sync subagent)
      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'Do something', status: 'running', toolCalls: [], isExpanded: false },
      });

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task completed successfully' },
        msg
      );

      expect(deps.subagentManager.finalizeSyncSubagent).toHaveBeenCalledWith(
        'task-1',
        'Task completed successfully',
        false
      );

      expect(msg.subagents![0].status).toBe('completed');
      expect(msg.subagents![0].result).toBe('Task completed successfully');
    });
  });

  describe('Async task tool result', () => {
    it('tool_result for a pending async task returns true from handleAsyncTaskToolResult', async () => {
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.isPendingAsyncTask as jest.Mock).mockReturnValueOnce(true);

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task started in background' },
        msg
      );

      expect(deps.subagentManager.handleTaskToolResult).toHaveBeenCalledWith(
        'task-1',
        'Task started in background',
        undefined
      );

      expect(updateToolCallResult).not.toHaveBeenCalled();
      expect(msg.toolCalls).toEqual([]);
    });
  });

  describe('showThinkingIndicator - timer disconnection cleanup', () => {
    it('should clear interval when timerSpan becomes disconnected from DOM', () => {
      // Use a non-zero value: with fake timers, performance.now() starts at 0,
      // and !0 is truthy which would cause updateTimer to return early.
      jest.advanceTimersByTime(1);
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500); // Past debounce delay

      expect(deps.state.flavorTimerInterval).not.toBeNull();

      const thinkingEl = deps.state.thinkingEl;
      expect(thinkingEl).not.toBeNull();

      // The timer span is the second child (first is flavor text, second is hint)
      const timerSpan = thinkingEl!.children[1];
      expect(timerSpan).toBeDefined();

      // Mock elements don't have isConnected by default (undefined = falsy),
      // so first set it to true so the timer runs normally on its first tick.
      Object.defineProperty(timerSpan, 'isConnected', { value: true, writable: true, configurable: true });

      // Advance time - interval should still run (isConnected is true)
      jest.advanceTimersByTime(1000);
      expect(deps.state.flavorTimerInterval).not.toBeNull();
      // Verify the interval callback actually ran by checking the timer text was updated
      expect((timerSpan as any).textContent).toContain('esc to interrupt');

      // Now simulate disconnection from DOM
      (timerSpan as any).isConnected = false;

      // Advance time to trigger the interval callback
      jest.advanceTimersByTime(1000);

      // Interval should have been cleared because isConnected is false
      expect(deps.state.flavorTimerInterval).toBeNull();
    });
  });

  describe('showThinkingIndicator - pre-existing interval', () => {
    it('should clear pre-existing interval before creating new one', () => {
      // Advance fake clock so performance.now() returns non-zero
      jest.advanceTimersByTime(1);
      deps.state.responseStartTime = performance.now();
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      // Manually set a pre-existing interval
      deps.state.flavorTimerInterval = setInterval(() => {}, 9999) as unknown as ReturnType<typeof setInterval>;

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      // clearInterval should have been called for the pre-existing interval
      expect(clearIntervalSpy).toHaveBeenCalled();

      // A new interval should have been created
      expect(deps.state.flavorTimerInterval).not.toBeNull();

      clearIntervalSpy.mockRestore();
    });
  });

  describe('appendThinking - no currentContentEl', () => {
    it('should not create thinking state when currentContentEl is null', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = null;

      await controller.handleStreamChunk({ type: 'thinking', content: 'test thinking' }, msg);

      // No thinking state should be created
      expect(deps.state.currentThinkingState).toBeNull();
    });
  });

  describe('showThinkingIndicator - responseStartTime null in timer', () => {
    it('should not update timer text when responseStartTime is null', () => {
      // Advance fake clock so performance.now() returns non-zero
      jest.advanceTimersByTime(1);
      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);

      expect(deps.state.thinkingEl).not.toBeNull();

      // Get timerSpan and set isConnected to true for proper timer operation
      const timerSpan = deps.state.thinkingEl!.children[1];
      Object.defineProperty(timerSpan, 'isConnected', { value: true, configurable: true });

      // Clear responseStartTime to trigger early return in updateTimer
      deps.state.responseStartTime = null;

      // Advance time to trigger timer callback - should not throw
      jest.advanceTimersByTime(1000);

      // Timer should still be set (interval not cleared by the null check)
      expect(deps.state.flavorTimerInterval).not.toBeNull();
    });
  });
});
