/**
 * Tests for StreamController - Stream Chunk Handling
 *
 * Note: These tests focus on the controller logic for text content handling.
 * Tool result tracking and UI rendering are tested through integration tests.
 */

import { TOOL_TASK, TOOL_TODO_WRITE } from '@/core/tools/toolNames';
import type { ChatMessage } from '@/core/types';
import { StreamController, type StreamControllerDeps } from '@/features/chat/controllers/StreamController';
import { ChatState } from '@/features/chat/state/ChatState';

// Mock core tools module
jest.mock('@/core/tools', () => {
  return {
    parseTodoInput: jest.fn(),
  };
});

// Mock chat rendering module
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

// Helper to create mock DOM element with full properties needed for rendering
function createMockElement() {
  const children: any[] = [];
  const classList = new Set<string>();
  const dataset: Record<string, string> = {};
  const attributes: Record<string, string> = {};

  const element: any = {
    children,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    addClass: (cls: string) => classList.add(cls),
    removeClass: (cls: string) => classList.delete(cls),
    hasClass: (cls: string) => classList.has(cls),
    style: { display: '' },
    scrollTop: 0,
    scrollHeight: 0,
    dataset,
    empty: () => { children.length = 0; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createEl: (tag: string, opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      child.tagName = tag.toUpperCase();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    appendChild: (child: any) => { children.push(child); return child; },
    querySelector: jest.fn().mockReturnValue(null),
    querySelectorAll: jest.fn().mockReturnValue([]),
    remove: jest.fn(),
    setText: jest.fn((text: string) => { element.textContent = text; }),
    setAttr: jest.fn(),
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    getAttribute: (name: string) => attributes[name],
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    textContent: '',
    tagName: 'DIV',
  };

  return element;
}

// Helper to create mock dependencies with minimal UI rendering
function createMockDeps(): StreamControllerDeps {
  const state = new ChatState();
  const messagesEl = createMockElement();
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
    } as any,
    asyncSubagentManager: {
      isAsyncTask: jest.fn().mockReturnValue(false),
      isPendingAsyncTask: jest.fn().mockReturnValue(false),
      isLinkedAgentOutputTool: jest.fn().mockReturnValue(false),
      handleAgentOutputToolResult: jest.fn().mockReturnValue(undefined),
      registerTask: jest.fn(),
      updateTaskRunning: jest.fn(),
      completeTask: jest.fn(),
      failTask: jest.fn(),
    } as any,
    getMessagesEl: () => messagesEl,
    getFileContextManager: () => fileContextManager as any,
    updateQueueIndicator: jest.fn(),
    getAgentService: () => agentService as any,
  };
}

// Helper to create a test message
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

describe('StreamController - Text Content', () => {
  let controller: StreamController;
  let deps: StreamControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    deps = createMockDeps();
    controller = new StreamController(deps);
    deps.state.currentContentEl = createMockElement();
  });

  afterEach(() => {
    // Clean up any timers set by ChatState
    deps.state.resetStreamingState();
    jest.useRealTimers();
  });

  describe('Text streaming', () => {
    it('should append text content to message', async () => {
      const msg = createTestMessage();

      // Set up text element for text streaming
      deps.state.currentTextEl = createMockElement();

      await controller.handleStreamChunk({ type: 'text', content: 'Hello ' }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'World' }, msg);

      expect(msg.content).toBe('Hello World');
    });

    it('should accumulate text across multiple chunks', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockElement();

      const chunks = ['This ', 'is ', 'a ', 'test.'];
      for (const chunk of chunks) {
        await controller.handleStreamChunk({ type: 'text', content: chunk }, msg);
      }

      expect(msg.content).toBe('This is a test.');
    });
  });

  describe('Error and blocked handling', () => {
    it('should append error message on error chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockElement();

      await controller.handleStreamChunk(
        { type: 'error', content: 'Something went wrong' },
        msg
      );

      expect(deps.state.currentTextContent).toContain('Error');
    });

    it('should append blocked message on blocked chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockElement();

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
      deps.state.currentTextEl = createMockElement();

      // Should not throw
      await expect(
        controller.handleStreamChunk({ type: 'done' }, msg)
      ).resolves.not.toThrow();
    });
  });

  describe('Usage handling', () => {
    it('should update usage for current session', async () => {
      const msg = createTestMessage();
      const usage = {
        model: 'model-a',
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 100,
        contextTokens: 10,
        percentage: 10,
      };

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('should ignore usage from other sessions', async () => {
      const msg = createTestMessage();
      const usage = {
        model: 'model-a',
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 100,
        contextTokens: 10,
        percentage: 10,
      };

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-2' }, msg);

      expect(deps.state.usage).toBeNull();
    });
  });

  describe('Tool handling', () => {
    it('should record tool_use and add to content blocks', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

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
      deps.state.currentContentEl = createMockElement();

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'tool-1', content: 'ok' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('completed');
      expect(msg.toolCalls![0].result).toBe('ok');
    });

    it('should add subagent entry to contentBlocks for Task tool', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

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
      deps.state.currentContentEl = createMockElement();

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
      deps.state.currentContentEl = createMockElement();

      // Add a tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      // Text chunk should flush pending tools first
      deps.state.currentTextEl = createMockElement();
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
      deps.state.currentContentEl = createMockElement();

      // Add a tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'test' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      // Thinking chunk should flush pending tools first
      await controller.handleStreamChunk({ type: 'thinking', content: 'Let me think...' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should render pending tool when tool_result arrives before flush', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add a tool - should be buffered
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
      createWriteEditBlock.mockReturnValue({ wrapperEl: createMockElement() });

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add Write tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'test.md', content: 'hello' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(1);
      expect(createWriteEditBlock).not.toHaveBeenCalled();
      expect(renderToolCall).not.toHaveBeenCalled();

      // Flush via done chunk
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
      createWriteEditBlock.mockReturnValue({ wrapperEl: createMockElement() });

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add Edit tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'test.md', old_string: 'a', new_string: 'b' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(1);
      expect(createWriteEditBlock).not.toHaveBeenCalled();

      // Flush via text chunk
      deps.state.currentTextEl = createMockElement();
      await controller.handleStreamChunk({ type: 'text', content: 'Done editing' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(createWriteEditBlock).toHaveBeenCalled();
    });

    it('should flush pending tools before rendering blocked message', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add a tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);

      // Blocked chunk should flush pending tools first
      await controller.handleStreamChunk({ type: 'blocked', content: 'Command blocked' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should flush pending tools before rendering error message', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add a tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'missing.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);

      // Error chunk should flush pending tools first
      await controller.handleStreamChunk({ type: 'error', content: 'Something went wrong' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should flush pending tools before Task tool renders', async () => {
      const { renderToolCall, createSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Add a regular tool - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);
      expect(renderToolCall).not.toHaveBeenCalled();

      // Task tool should flush pending tools before creating subagent block
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose', run_in_background: false } },
        msg
      );

      // Pending tools should be flushed
      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
      // Subagent block should be created
      expect(createSubagentBlock).toHaveBeenCalled();
    });

    it('should re-parse TodoWrite on input updates when streaming completes', async () => {
      const { parseTodoInput } = jest.requireMock('@/core/tools');

      const mockTodos = [
        { content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' },
      ];

      // First chunk: partial input, parsing fails
      parseTodoInput.mockReturnValueOnce(null);

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

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
      deps.state.currentContentEl = createMockElement();

      // Add some pending tools
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.md' } },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: 'b.md' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(2);

      // Reset streaming state
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
      deps.state.currentContentEl = createMockElement();

      // Add multiple tools - should all be buffered
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

      // Flush via done
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

  describe('Pending Task tool handling', () => {
    it('should render pending Task as sync when child chunk arrives', async () => {
      const { createSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Task without run_in_background - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Should be buffered in pendingTaskTools
      expect(deps.state.pendingTaskTools.size).toBe(1);
      expect(createSubagentBlock).not.toHaveBeenCalled();

      // Child chunk arrives with parentToolUseId - should trigger render as sync
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, parentToolUseId: 'task-1' } as any,
        msg
      );

      // Pending task should now be rendered
      expect(deps.state.pendingTaskTools.size).toBe(0);
      expect(createSubagentBlock).toHaveBeenCalled();
    });

    it('should not crash stream when pending Task rendering throws an error via child chunk', async () => {
      const { createSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Task without run_in_background - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      expect(deps.state.pendingTaskTools.size).toBe(1);

      // Make createSubagentBlock throw an error when child chunk triggers rendering
      createSubagentBlock.mockImplementationOnce(() => {
        throw new Error('Render failed');
      });

      // Child chunk arrives - should trigger renderPendingTask which has try-catch
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, parentToolUseId: 'task-1' } as any,
        msg
      );

      // Should not throw, state should be updated (subagent spawned counter incremented)
      expect(deps.state.subagentsSpawnedThisStream).toBe(1);
      // Pending task should be removed even though rendering failed
      expect(deps.state.pendingTaskTools.size).toBe(0);
    });

    it('should not crash stream when pending Task rendering throws an error via tool_result', async () => {
      const { createSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockElement();

      // Task without run_in_background - should be buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_TASK, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      expect(deps.state.pendingTaskTools.size).toBe(1);

      // Make createSubagentBlock throw an error when result triggers rendering
      createSubagentBlock.mockImplementationOnce(() => {
        throw new Error('Render failed');
      });

      // Tool result arrives - should trigger renderPendingTask which has try-catch
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task completed' },
        msg
      );

      // Should not throw, state should be updated (subagent spawned counter incremented)
      expect(deps.state.subagentsSpawnedThisStream).toBe(1);
      // Pending task should be removed even though rendering failed
      expect(deps.state.pendingTaskTools.size).toBe(0);
    });
  });
});
