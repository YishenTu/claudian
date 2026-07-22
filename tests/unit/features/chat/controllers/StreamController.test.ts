import '@/providers';

import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createMockEl } from '@test/helpers/mockElement';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import {
  TOOL_AGENT_OUTPUT,
  TOOL_APPLY_PATCH,
  TOOL_SPAWN_AGENT,
  TOOL_SUBAGENT,
  TOOL_TODO_WRITE,
  TOOL_WAIT_AGENT,
} from '@/core/tools/toolNames';
import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { StreamController, type StreamControllerDeps } from '@/features/chat/controllers/StreamController';
import { ChatState } from '@/features/chat/state/ChatState';

jest.mock('@/core/tools/todo', () => ({
  parseTodoInput: jest.fn(),
}));

jest.mock('@/core/tools/toolInput', () => ({
  extractResolvedAnswers: jest.fn().mockReturnValue(undefined),
  extractResolvedAnswersFromResultText: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@/features/chat/rendering/SubagentRenderer', () => ({
  createAsyncSubagentBlock: jest.fn().mockReturnValue({
    info: { id: 'task-1', description: 'test', mode: 'async', status: 'running', toolCalls: [] },
    labelEl: { setText: jest.fn() },
  }),
  createSubagentBlock: jest.fn().mockReturnValue({
    info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
    labelEl: { setText: jest.fn() },
  }),
  finalizeAsyncSubagent: jest.fn(),
  finalizeSubagentBlock: jest.fn(),
  updateAsyncSubagentRunning: jest.fn(),
}));

jest.mock('@/features/chat/rendering/ThinkingBlockRenderer', () => ({
  appendThinkingContent: jest.fn(),
  createThinkingBlock: jest.fn().mockImplementation(() => ({
    container: {},
    contentEl: {},
    content: '',
    startTime: Date.now(),
  })),
  finalizeThinkingBlock: jest.fn().mockReturnValue(0),
}));

jest.mock('@/features/chat/rendering/ToolCallRenderer', () => ({
  getToolName: jest.fn().mockReturnValue('Read'),
  getToolSummary: jest.fn().mockReturnValue('file.md'),
  isBlockedToolResult: jest.fn().mockReturnValue(false),
  renderToolCall: jest.fn(),
  updateToolCallResult: jest.fn(),
}));

jest.mock('@/features/chat/rendering/WriteEditRenderer', () => ({
  createWriteEditBlock: jest.fn().mockReturnValue({}),
  finalizeWriteEditBlock: jest.fn(),
  updateWriteEditWithDiff: jest.fn(),
}));

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
  normalizePathForVault: jest.fn((path: string | undefined) => path),
}));

const originalWindow = (globalThis as { window?: Window }).window;

function installTestWindow(): void {
  const testWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback): number =>
      globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number,
    cancelAnimationFrame: (handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    setTimeout: (callback: () => void, timeout: number): number =>
      globalThis.setTimeout(callback, timeout) as unknown as number,
    clearTimeout: (handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    setInterval: (callback: () => void, timeout: number): number =>
      globalThis.setInterval(callback, timeout) as unknown as number,
    clearInterval: (handle: number): void => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    },
  } as Window;

  Object.defineProperty(globalThis, 'window', {
    value: testWindow,
    configurable: true,
  });
}

function restoreTestWindow(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
    return;
  }

  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  });
}

function createMockDeps(): StreamControllerDeps {
  const state = new ChatState();
  const messagesEl = createMockEl();
  const agentService = {
    getSessionId: jest.fn().mockReturnValue('session-1'),
    loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
    loadSubagentFinalResult: jest.fn().mockResolvedValue(null),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsPlanMode: true,
      planPathPrefix: '/.claude/plans/',
    }),
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
      handleAsyncSubagentCompletion: jest.fn().mockReturnValue(undefined),
      handleTaskToolUse: jest.fn().mockReturnValue({ action: 'buffered' }),
      handleTaskToolResult: jest.fn(),
      getByTaskId: jest.fn().mockReturnValue(undefined),
      refreshAsyncSubagent: jest.fn(),
      hasPendingTask: jest.fn().mockReturnValue(false),
      renderPendingTask: jest.fn().mockReturnValue(null),
      renderPendingTaskFromTaskResult: jest.fn().mockReturnValue(null),
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

function installOrderedMockParent(parent: any): void {
  parent.insertBefore = jest.fn((element: any, reference: any) => {
    const existingIndex = parent.children.indexOf(element);
    if (existingIndex >= 0) parent.children.splice(existingIndex, 1);
    const referenceIndex = parent.children.indexOf(reference);
    parent.children.splice(referenceIndex >= 0 ? referenceIndex : parent.children.length, 0, element);
  });
}

function mountMockChild(parent: any, child: any): any {
  parent.children.push(child);
  Object.defineProperty(child, 'parentElement', {
    configurable: true,
    value: parent,
  });
  child.remove = jest.fn(() => {
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
  });
  return child;
}

describe('StreamController - Text Content', () => {
  let controller: StreamController;
  let deps: StreamControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    installTestWindow();
    deps = createMockDeps();
    controller = new StreamController(deps);
    deps.state.currentContentEl = createMockEl();
  });

  afterEach(() => {
    // Clean up any timers set by ChatState
    deps.state.resetStreamingState();
    restoreTestWindow();
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

    it('should coalesce text renders until the next animation frame', async () => {
      deps.state.currentTextEl = createMockEl();

      await controller.appendText('Hello ');
      await controller.appendText('World');

      expect(deps.renderer.renderContent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Hello World'
      );
    });

    it('should defer math rendering during live text renders', async () => {
      deps.state.currentTextEl = createMockEl();

      await controller.appendText('Euler: $e^{i\\pi} + 1 = 0$');

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Euler: $e^{i\\pi} + 1 = 0$',
        { deferMath: true }
      );
    });

    it('should defer LaTeX-delimited math during live text renders', async () => {
      deps.state.currentTextEl = createMockEl();

      await controller.appendText('Euler: \\(e^{i\\pi} + 1 = 0\\)');

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Euler: \\(e^{i\\pi} + 1 = 0\\)',
        { deferMath: true }
      );
    });

    it('should honor disabled deferred math rendering setting during live text renders', async () => {
      (deps.plugin.settings as any).deferMathRenderingDuringStreaming = false;
      deps.state.currentTextEl = createMockEl();

      await controller.appendText('Euler: $e^{i\\pi} + 1 = 0$');

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Euler: $e^{i\\pi} + 1 = 0$'
      );
    });

    it('should flush a pending text render before finalizing text', async () => {
      const msg = createTestMessage();

      await controller.appendText('Hello');
      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        expect.anything(),
        'Hello'
      );
      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Hello'
      );
      expect(msg.contentBlocks).toContainEqual({
        type: 'text',
        content: 'Hello',
      });
    });

    it('should render original math once when finalizing a deferred text block', async () => {
      const msg = createTestMessage();

      await controller.appendText('Final $x^2$');
      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'Final $x^2$',
        { deferMath: true }
      );
      expect(deps.renderer.renderContent).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'Final $x^2$'
      );
      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Final $x^2$'
      );
    });
  });

  describe('Text block finalization', () => {
    it('should add copy button when finalizing text block with content', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = 'Hello World';

      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Hello World'
      );
      expect(msg.contentBlocks).toContainEqual({
        type: 'text',
        content: 'Hello World',
      });
    });

    it('should not add copy button when no text element exists', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = null;
      deps.state.currentTextContent = 'Hello World';

      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).not.toHaveBeenCalled();
      // Content block should still be added
      expect(msg.contentBlocks).toContainEqual({
        type: 'text',
        content: 'Hello World',
      });
    });

    it('should not add copy button when no text content exists', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = '';

      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).not.toHaveBeenCalled();
      expect(msg.contentBlocks).toEqual([]);
    });

    it('should reset text state after finalization', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();
      deps.state.currentTextContent = 'Test content';

      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.state.currentTextEl).toBeNull();
      expect(deps.state.currentTextContent).toBe('');
    });
  });

  describe('Error and notice handling', () => {
    it('should append error message on error chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'error', content: 'Something went wrong' },
        msg
      );

      expect(deps.state.currentTextContent).toContain('Error');
    });

    it('should append warning notice on notice chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'notice', content: 'Tool was blocked', level: 'warning' },
        msg
      );

      expect(deps.state.currentTextContent).toContain('Blocked');
    });
  });

  describe('context_compacted handling', () => {
    it('should record a context_compacted block on the message', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk({ type: 'context_compacted' }, msg);

      expect(msg.contentBlocks).toContainEqual({ type: 'context_compacted' });
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

    it('stamps the active provider model onto usage when the provider omits it', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage({ model: undefined });
      const providerSettingsSpy = jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot');
      providerSettingsSpy.mockReturnValue({ model: TEST_CODEX_MODEL } as any);
      (deps.getAgentService!() as any).providerId = 'codex';

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toEqual({ ...usage, model: TEST_CODEX_MODEL });

      providerSettingsSpy.mockRestore();
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
          name: TOOL_SUBAGENT,
          input: { prompt: 'Do something', subagent_type: 'general-purpose', run_in_background: false },
        },
        msg
      );

      expect(msg.contentBlocks).toHaveLength(1);
      expect(msg.contentBlocks![0]).toEqual({ type: 'subagent', subagentId: 'task-1' });
      expect(msg.toolCalls).toContainEqual(
        expect.objectContaining({
          id: 'task-1',
          name: TOOL_SUBAGENT,
          subagent: expect.objectContaining({ id: 'task-1' }),
        })
      );
    });

    it.each([
      'Agent',
      'Task',
      'future_agent',
    ])(
      'keeps Grok %s tools as ordinary lossless cards',
      async (name) => {
        const msg = createTestMessage();
        deps.state.currentContentEl = createMockEl();
        deps.getAgentService = () => ({
          providerId: 'grok',
          getCapabilities: jest.fn().mockReturnValue({
            providerId: 'grok',
          }),
        }) as any;

        await controller.handleStreamChunk({
          id: `grok-${name}`,
          input: { opaque: name },
          name,
          providerPayload: { rawInput: { opaque: name }, rawName: name },
          type: 'tool_use',
        }, msg);

        expect(deps.subagentManager.handleTaskToolUse).not.toHaveBeenCalled();
        expect(msg.toolCalls).toEqual([expect.objectContaining({
          id: `grok-${name}`,
          input: { opaque: name },
          name,
          providerPayload: { rawInput: { opaque: name }, rawName: name },
          status: 'running',
        })]);
        expect(msg.contentBlocks).toEqual([{ type: 'tool_use', toolId: `grok-${name}` }]);
      },
    );

    it('converts an OpenCode generic card to Agent in place without duplicate state or DOM', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      renderToolCall.mockReset();
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      deps.getAgentService = () => ({
        providerId: 'opencode',
        getCapabilities: jest.fn().mockReturnValue({
          providerId: 'opencode',
        }),
      }) as any;
      const genericEl = createMockEl();
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, genericEl);
        elements.set(toolCall.id, genericEl);
        return genericEl;
      });
      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'created_sync',
        subagentState: {
          info: {
            id: 'opencode-agent',
            description: 'Inspect the vault',
            status: 'running',
            toolCalls: [],
          },
        },
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        id: 'opencode-agent',
        input: { description: 'Inspect' },
        name: 'tool',
        providerPayload: { rawInput: { description: 'Inspect' }, rawName: 'tool' },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      const toolCall = msg.toolCalls![0];
      Object.assign(toolCall, { isExpanded: true, result: 'partial result' });

      await controller.handleStreamChunk({
        id: 'opencode-agent',
        input: { prompt: 'Inspect the vault' },
        name: 'Agent',
        providerPayload: {
          rawInput: { prompt: 'Inspect the vault' },
          rawName: 'task',
          rawOutput: { phase: 'started' },
        },
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toEqual([toolCall]);
      expect(toolCall).toMatchObject({
        input: { description: 'Inspect', prompt: 'Inspect the vault' },
        isExpanded: true,
        name: TOOL_SUBAGENT,
        providerPayload: {
          rawInput: { prompt: 'Inspect the vault' },
          rawName: 'task',
          rawOutput: { phase: 'started' },
        },
        result: 'partial result',
        subagent: expect.objectContaining({ id: 'opencode-agent' }),
      });
      expect(msg.contentBlocks).toEqual([
        { type: 'subagent', subagentId: 'opencode-agent' },
        { content: 'Intervening content', type: 'text' },
      ]);
      expect(deps.subagentManager.handleTaskToolUse).toHaveBeenCalledTimes(1);
      expect(genericEl.remove).toHaveBeenCalledTimes(1);
      expect(deps.state.toolCallElements.has('opencode-agent')).toBe(false);
      expect(deps.state.writeEditStates.has('opencode-agent')).toBe(false);
    });

    it('routes the current Claude Agent tool through the managed subagent protocol', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();
      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'buffered',
      });

      await controller.handleStreamChunk({
        id: 'claude-agent',
        input: { prompt: 'Inspect' },
        name: 'Agent',
        type: 'tool_use',
      }, msg);

      expect(deps.subagentManager.handleTaskToolUse).toHaveBeenCalledWith(
        'claude-agent',
        { prompt: 'Inspect' },
        deps.state.currentContentEl,
      );
      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0].name).toBe(TOOL_SUBAGENT);
    });

    it('should render TodoWrite inline and update panel', async () => {
      const { parseTodoInput } = jest.requireMock('@/core/tools/todo');
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
        expect.any(Map),
        { initiallyExpanded: false },
      );
    });

    it('should pass expanded default to apply_patch tool blocks when enabled', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      (deps.plugin.settings as any).expandFileEditsByDefault = true;

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'patch-1',
          name: TOOL_APPLY_PATCH,
          input: { changes: [{ path: 'src/main.ts', kind: 'update' }] },
        },
        msg
      );
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'patch-1', name: TOOL_APPLY_PATCH }),
        expect.any(Map),
        { initiallyExpanded: true },
      );
    });

    it('should flush pending tools before rendering thinking content', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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

    it('should render a pending tool on tool_output and append incremental output', async () => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(1);

      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'bash-1', content: 'line 1\n' },
        msg
      );

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
      expect(updateToolCallResult).not.toHaveBeenCalled();

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenCalledWith(
        'bash-1',
        expect.objectContaining({
          id: 'bash-1',
          status: 'running',
          result: 'line 1\n',
        }),
        expect.any(Map)
      );

      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'bash-1', content: 'line 2\n' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('running');
      expect(msg.toolCalls![0].result).toBe('line 1\nline 2\n');
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenLastCalledWith(
        'bash-1',
        expect.objectContaining({
          id: 'bash-1',
          status: 'running',
          result: 'line 1\nline 2\n',
        }),
        expect.any(Map)
      );
    });

    it('should coalesce tool_output renders until the next animation frame', async () => {
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'bash-1', content: 'line 1\n' },
        msg
      );
      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'bash-1', content: 'line 2\n' },
        msg
      );

      expect(updateToolCallResult).not.toHaveBeenCalled();

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        'bash-1',
        expect.objectContaining({
          result: 'line 1\nline 2\n',
          status: 'running',
        }),
        expect.any(Map)
      );
    });

    it('should buffer Write tool and use createWriteEditBlock on flush', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
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
        expect.objectContaining({ id: 'write-1', name: 'Write' }),
        { initiallyExpanded: false },
      );
      // renderToolCall should NOT be called for Write/Edit tools
      expect(renderToolCall).not.toHaveBeenCalled();
    });

    it('should pass expanded default to Write tool blocks when enabled', async () => {
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
      createWriteEditBlock.mockReturnValue({ wrapperEl: createMockEl() });

      (deps.plugin.settings as any).expandFileEditsByDefault = true;

      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'test.md', content: 'hello' } },
        msg
      );
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(createWriteEditBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'write-1', name: 'Write' }),
        { initiallyExpanded: true },
      );
    });

    it('should buffer Edit tool and use createWriteEditBlock on flush', async () => {
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
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
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
        msg
      );
      expect(deps.state.pendingTools.size).toBe(1);

      await controller.handleStreamChunk({ type: 'notice', content: 'Command blocked', level: 'warning' }, msg);

      expect(deps.state.pendingTools.size).toBe(0);
      expect(renderToolCall).toHaveBeenCalled();
    });

    it('should flush pending tools before rendering error message', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something', subagent_type: 'general-purpose', run_in_background: false } },
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
      const { parseTodoInput } = jest.requireMock('@/core/tools/todo');

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

    it('uses the content owner window for thinking timers', () => {
      const ownerSetTimeout = jest.fn<ReturnType<Window['setTimeout']>, Parameters<Window['setTimeout']>>(
        (callback, timeout) => globalThis.setTimeout(callback, timeout) as unknown as number,
      );
      const ownerClearTimeout = jest.fn<void, [number]>((handle) => {
        globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
      });
      const ownerSetInterval = jest.fn<ReturnType<Window['setInterval']>, Parameters<Window['setInterval']>>(
        (callback, timeout) => globalThis.setInterval(callback, timeout) as unknown as number,
      );
      const ownerClearInterval = jest.fn<void, [number]>((handle) => {
        globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
      });
      const ownerWindow = {
        ...deps.state.currentContentEl!.ownerDocument.defaultView,
        setTimeout: ownerSetTimeout,
        clearTimeout: ownerClearTimeout,
        setInterval: ownerSetInterval,
        clearInterval: ownerClearInterval,
      };
      Object.defineProperty(deps.state.currentContentEl!.ownerDocument, 'defaultView', {
        configurable: true,
        value: ownerWindow,
      });

      deps.state.responseStartTime = performance.now();

      controller.showThinkingIndicator();
      expect(ownerSetTimeout).toHaveBeenCalledWith(expect.any(Function), 400);

      controller.hideThinkingIndicator();
      expect(ownerClearTimeout).toHaveBeenCalled();

      controller.showThinkingIndicator();
      jest.advanceTimersByTime(500);
      expect(ownerSetInterval).toHaveBeenCalledWith(expect.any(Function), 1000);

      controller.hideThinkingIndicator();
      expect(ownerClearInterval).toHaveBeenCalled();
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
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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

    it('uses authoritative usage chunks directly', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage({
        model: TEST_CODEX_MODEL,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        contextTokens: 129200,
        percentage: 50,
      });

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

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
    it('should handle subagent tool_result chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      const toolCall = { id: 'read-1', name: 'Read', input: {}, status: 'running' };
      (deps.subagentManager.getSyncSubagent as jest.Mock).mockReturnValueOnce({
        info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [toolCall] },
      });

      await controller.handleStreamChunk(
        { type: 'subagent_tool_result', id: 'read-1', subagentId: 'task-1', content: 'file content' },
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
        { type: 'subagent_tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'test' }, subagentId: 'task-1' },
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
        { type: 'subagent_tool_use', id: 'orphan-read', name: 'Read', input: { file_path: 'test.md' }, subagentId: 'unknown-task' },
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
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something', run_in_background: true } },
        msg
      );

      expect(msg.toolCalls).toContainEqual(
        expect.objectContaining({
          id: 'task-1',
          name: TOOL_SUBAGENT,
          subagent: expect.objectContaining({
            id: 'task-1',
            mode: 'async',
          }),
        })
      );
      expect(msg.contentBlocks).toContainEqual({ type: 'subagent', subagentId: 'task-1', mode: 'async' });
    });

    it('should handle label_updated action from Task tool use (no-op for message)', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.handleTaskToolUse as jest.Mock).mockReturnValueOnce({
        action: 'label_updated',
      });

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Updated' } },
        msg
      );

      expect(msg.toolCalls).toContainEqual(
        expect.objectContaining({
          id: 'task-1',
          name: TOOL_SUBAGENT,
        })
      );
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
        toolCalls: [{
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'test' },
          status: 'running',
          subagent: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
        }],
      }] as any;

      controller.onAsyncSubagentStateChange(subagent);

      const taskTool = deps.state.messages[0].toolCalls![0];
      expect(taskTool.status).toBe('completed');
      expect(taskTool.subagent?.status).toBe('completed');
      expect(taskTool.subagent?.result).toBe('done');
    });

    it('should not crash when subagent not found in messages', () => {
      const subagent = { id: 'unknown', description: 'test', status: 'completed', toolCalls: [] } as any;
      deps.state.messages = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'test' },
          status: 'running',
        }],
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

      await controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Let me think...' })
      );
      expect(deps.state.currentThinkingState).toBeNull();
    });

    it('should not add to contentBlocks when no thinking content', async () => {
      const msg = createTestMessage();
      deps.state.currentThinkingState = {
        content: '',
        container: createMockEl(),
        contentEl: createMockEl(),
        startTime: Date.now(),
      } as any;

      await controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });

    it('should be a no-op when no thinking state', async () => {
      const msg = createTestMessage();
      deps.state.currentThinkingState = null;

      await controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });

    it('should coalesce thinking renders until the next animation frame', async () => {
      const { createThinkingBlock } = jest.requireMock('@/features/chat/rendering/ThinkingBlockRenderer');
      const msg = createTestMessage();
      const contentEl = createMockEl();
      createThinkingBlock.mockReturnValueOnce({
        wrapperEl: createMockEl(),
        contentEl,
        labelEl: createMockEl(),
        content: '',
        startTime: Date.now(),
      });

      await controller.handleStreamChunk({ type: 'thinking', content: 'Let ' }, msg);
      await controller.handleStreamChunk({ type: 'thinking', content: 'me think' }, msg);

      expect(deps.renderer.renderContent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderContent).toHaveBeenCalledWith(contentEl, 'Let me think');
    });

    it('should defer math rendering during live thinking renders', async () => {
      const { createThinkingBlock } = jest.requireMock('@/features/chat/rendering/ThinkingBlockRenderer');
      const msg = createTestMessage();
      const contentEl = createMockEl();
      createThinkingBlock.mockReturnValueOnce({
        wrapperEl: createMockEl(),
        contentEl,
        labelEl: createMockEl(),
        content: '',
        startTime: Date.now(),
      });

      await controller.handleStreamChunk({ type: 'thinking', content: 'Reasoning $x^2$' }, msg);

      jest.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        contentEl,
        'Reasoning $x^2$',
        { deferMath: true }
      );
    });

    it('should render original math once when finalizing a deferred thinking block', async () => {
      const { createThinkingBlock } = jest.requireMock('@/features/chat/rendering/ThinkingBlockRenderer');
      const msg = createTestMessage();
      const contentEl = createMockEl();
      createThinkingBlock.mockReturnValueOnce({
        wrapperEl: createMockEl(),
        contentEl,
        labelEl: createMockEl(),
        content: '',
        startTime: Date.now(),
      });

      await controller.handleStreamChunk({ type: 'thinking', content: 'Reasoning $x^2$' }, msg);
      await controller.finalizeCurrentThinkingBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenNthCalledWith(
        1,
        contentEl,
        'Reasoning $x^2$',
        { deferMath: true }
      );
      expect(deps.renderer.renderContent).toHaveBeenNthCalledWith(
        2,
        contentEl,
        'Reasoning $x^2$'
      );
      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Reasoning $x^2$' })
      );
    });

    it('should flush a pending thinking render before finalizing', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk({ type: 'thinking', content: 'Reasoning' }, msg);
      await controller.finalizeCurrentThinkingBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        expect.anything(),
        'Reasoning'
      );
      expect(msg.contentBlocks).toContainEqual(
        expect.objectContaining({ type: 'thinking', content: 'Reasoning' })
      );
    });
  });

  describe('Pending Task tool handling', () => {
    it('should render pending Task as sync when child chunk arrives', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Task without run_in_background - manager returns buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
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
        { type: 'subagent_tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, subagentId: 'task-1' },
        msg
      );

      // Task toolCall should carry linked subagent
      expect(msg.toolCalls).toContainEqual(
        expect.objectContaining({
          id: 'task-1',
          name: TOOL_SUBAGENT,
          subagent: expect.objectContaining({ id: 'task-1' }),
        })
      );
      expect(deps.subagentManager.renderPendingTask).toHaveBeenCalledWith('task-1', deps.state.currentContentEl);
    });

    it('should not crash stream when pending Task rendering returns null via child chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // Task without run_in_background - manager returns buffered
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Configure manager: pending task exists but render returns null (error case)
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTask as jest.Mock).mockReturnValueOnce(null);

      // Child chunk arrives - renderPendingTask returns null but shouldn't crash
      await controller.handleStreamChunk(
        { type: 'subagent_tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, subagentId: 'task-1' },
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
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something', subagent_type: 'general-purpose' } },
        msg
      );

      // Configure manager: pending task exists but render returns null
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTaskFromTaskResult as jest.Mock).mockReturnValueOnce(null);

      // Tool result arrives - pending resolver returns null but stream should continue
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task completed' },
        msg
      );

      // Should not throw - manager handled errors internally
      expect(deps.subagentManager.renderPendingTaskFromTaskResult).toHaveBeenCalledWith(
        'task-1',
        'Task completed',
        false,
        deps.state.currentContentEl,
        undefined
      );
    });

    it('should resolve pending Task as async via tool_result and continue async lifecycle', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something' } },
        msg
      );

      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTaskFromTaskResult as jest.Mock).mockReturnValueOnce({
        mode: 'async',
        info: {
          id: 'task-1',
          description: 'Do something',
          prompt: 'Do something',
          mode: 'async',
          isExpanded: false,
          status: 'running',
          toolCalls: [],
          asyncStatus: 'pending',
        },
      });
      (deps.subagentManager.isPendingAsyncTask as jest.Mock).mockReturnValueOnce(true);

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: '{"agent_id":"agent-1"}' },
        msg
      );

      expect(deps.subagentManager.renderPendingTaskFromTaskResult).toHaveBeenCalledWith(
        'task-1',
        '{"agent_id":"agent-1"}',
        false,
        deps.state.currentContentEl,
        undefined
      );
      expect(deps.subagentManager.handleTaskToolResult).toHaveBeenCalledWith(
        'task-1',
        '{"agent_id":"agent-1"}',
        undefined,
        undefined
      );
      expect(msg.contentBlocks).toContainEqual({
        type: 'subagent',
        subagentId: 'task-1',
        mode: 'async',
      });
      expect(msg.toolCalls).toContainEqual(
        expect.objectContaining({
          id: 'task-1',
          name: TOOL_SUBAGENT,
          subagent: expect.objectContaining({ mode: 'async' }),
        })
      );
    });

    it('should pass task toolUseResult into pending Task resolver', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something' } },
        msg
      );

      const toolUseResult = { isAsync: true, status: 'async_launched', agentId: 'agent-1' };
      (deps.subagentManager.hasPendingTask as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.renderPendingTaskFromTaskResult as jest.Mock).mockReturnValueOnce(null);

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Launching...', toolUseResult } as any,
        msg
      );

      expect(deps.subagentManager.renderPendingTaskFromTaskResult).toHaveBeenCalledWith(
        'task-1',
        'Launching...',
        false,
        deps.state.currentContentEl,
        toolUseResult
      );
    });
  });

  describe('Text ↔ Thinking transitions', () => {
    it('text arrives while thinking state is active → finalizeCurrentThinkingBlock is called', async () => {
      const { finalizeThinkingBlock } = jest.requireMock('@/features/chat/rendering/ThinkingBlockRenderer');
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
      const { finalizeThinkingBlock } = jest.requireMock('@/features/chat/rendering/ThinkingBlockRenderer');
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
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce({});

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-1', content: 'agent result', toolUseResult: { foo: 'bar' } as any },
        msg
      );

      expect(deps.subagentManager.handleAgentOutputToolResult).toHaveBeenCalledWith(
        'agent-out-1',
        'agent result',
        false,
        { foo: 'bar' }
      );
      expect(updateToolCallResult).not.toHaveBeenCalled();
    });

    it('native async completion finalizes and hydrates the matching background subagent', async () => {
      const runtime = deps.getAgentService!() as any;
      deps.state.currentContentEl = createMockEl();
      const completedSubagent = {
        id: 'task-1',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-1',
        result: 'Notification summary',
      };

      (deps.subagentManager.handleAsyncSubagentCompletion as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );
      runtime.loadSubagentFinalResult.mockResolvedValueOnce('Recovered final result');

      const completion = {
        type: 'async_subagent_completion' as const,
        providerSessionId: 'session-1',
        taskId: 'agent-1',
        toolUseId: 'task-1',
        status: 'completed' as const,
        result: 'Notification summary',
      };
      await controller.handleAsyncSubagentCompletion(completion);

      expect(deps.subagentManager.handleAsyncSubagentCompletion).toHaveBeenCalledWith(completion);
      expect(runtime.loadSubagentToolCalls).toHaveBeenCalledWith('agent-1');
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledWith('agent-1');
      expect(completedSubagent.result).toBe('Recovered final result');
      expect(deps.subagentManager.refreshAsyncSubagent).toHaveBeenCalledWith(completedSubagent);
    });

    it('discards hydration that resolves after the canonical task is cleared', async () => {
      const runtime = deps.getAgentService!() as any;
      const completedSubagent = {
        id: 'task-stale',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-stale',
        result: 'Notification summary',
      };
      let resolveToolCalls!: (toolCalls: ToolCallInfo[]) => void;
      runtime.loadSubagentToolCalls.mockReturnValueOnce(new Promise((resolve) => {
        resolveToolCalls = resolve;
      }));
      (deps.subagentManager.handleAsyncSubagentCompletion as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );

      const pending = controller.handleAsyncSubagentCompletion({
        type: 'async_subagent_completion',
        providerSessionId: 'session-1',
        taskId: 'agent-stale',
        toolUseId: 'task-stale',
        status: 'completed',
      });
      await Promise.resolve();

      (deps.subagentManager.getByTaskId as jest.Mock).mockReturnValue(undefined);
      resolveToolCalls([{
        id: 'read-stale',
        name: 'Read',
        input: {},
        status: 'completed',
        isExpanded: false,
      }]);
      await pending;

      expect(completedSubagent.toolCalls).toEqual([]);
      expect(runtime.loadSubagentFinalResult).not.toHaveBeenCalled();
      expect(deps.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();
    });

    it('discards hydration that resolves after the provider session changes', async () => {
      const runtime = deps.getAgentService!() as any;
      const completedSubagent = {
        id: 'task-stale-session',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-stale-session',
        result: 'Notification summary',
      };
      let resolveToolCalls!: (toolCalls: ToolCallInfo[]) => void;
      runtime.loadSubagentToolCalls.mockReturnValueOnce(new Promise((resolve) => {
        resolveToolCalls = resolve;
      }));
      (deps.subagentManager.handleAsyncSubagentCompletion as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );

      const pending = controller.handleAsyncSubagentCompletion({
        type: 'async_subagent_completion',
        providerSessionId: 'session-1',
        taskId: 'agent-stale-session',
        toolUseId: 'task-stale-session',
        status: 'completed',
      });
      await Promise.resolve();

      runtime.getSessionId.mockReturnValue('session-2');
      resolveToolCalls([{
        id: 'read-stale-session',
        name: 'Read',
        input: {},
        status: 'completed',
        isExpanded: false,
      }]);
      await pending;

      expect(completedSubagent.toolCalls).toEqual([]);
      expect(runtime.loadSubagentFinalResult).not.toHaveBeenCalled();
      expect(deps.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();
    });

    it('hydrates async subagent tool calls from sidecar during streaming completion', async () => {
      const runtime = deps.getAgentService!() as any;
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      const completedSubagent = {
        id: 'task-1',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-1',
        result: 'Done',
      };

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );
      runtime.loadSubagentToolCalls.mockResolvedValueOnce([
        {
          id: 'read-1',
          name: 'Read',
          input: { file_path: 'notes.md' },
          status: 'completed',
          result: 'content',
          isExpanded: false,
        },
      ]);

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-1', content: 'agent result' },
        msg
      );

      expect(runtime.loadSubagentToolCalls).toHaveBeenCalledWith('agent-1');
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledWith('agent-1');
      expect(completedSubagent.toolCalls).toHaveLength(1);
      expect(deps.subagentManager.refreshAsyncSubagent).toHaveBeenCalledWith(completedSubagent);
    });

    it('hydrates async subagent final result from sidecar even when tool calls already exist', async () => {
      const runtime = deps.getAgentService!() as any;
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      const completedSubagent = {
        id: 'task-2',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [
          {
            id: 'existing-tool',
            name: 'Read',
            input: { file_path: 'notes.md' },
            status: 'completed',
            result: 'existing',
            isExpanded: false,
          },
        ],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-2',
        result: 'Short placeholder',
      };

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );
      runtime.loadSubagentFinalResult.mockResolvedValueOnce('Recovered final result from sidecar');

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-2', content: 'agent result' },
        msg
      );

      expect(runtime.loadSubagentToolCalls).not.toHaveBeenCalled();
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledWith('agent-2');
      expect(completedSubagent.result).toBe('Recovered final result from sidecar');
      expect(deps.subagentManager.refreshAsyncSubagent).toHaveBeenCalledWith(completedSubagent);
    });

    it('does not retry async subagent final result hydration when sidecar matches current result', async () => {
      const runtime = deps.getAgentService!() as any;
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      const completedSubagent = {
        id: 'task-2b',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [
          {
            id: 'existing-tool',
            name: 'Read',
            input: { file_path: 'notes.md' },
            status: 'completed',
            result: 'existing',
            isExpanded: false,
          },
        ],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-2b',
        result: 'Already final',
      };

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );
      runtime.loadSubagentFinalResult.mockResolvedValueOnce('Already final');

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-2b', content: 'agent result' },
        msg
      );

      expect(runtime.loadSubagentToolCalls).not.toHaveBeenCalled();
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledTimes(1);
      expect(deps.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();

      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledTimes(1);
    });

    it('retries async subagent final result hydration when first sidecar read is stale', async () => {
      const runtime = deps.getAgentService!() as any;
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();
      const enqueueBackgroundWork = jest.fn((work: () => Promise<void>) => work());
      const persistConversation = jest.fn().mockResolvedValue(undefined);
      Object.assign(deps, { enqueueBackgroundWork, persistConversation });

      const completedSubagent = {
        id: 'task-3',
        description: 'Background task',
        prompt: 'Do work',
        mode: 'async',
        status: 'completed',
        toolCalls: [
          {
            id: 'existing-tool',
            name: 'Read',
            input: { file_path: 'notes.md' },
            status: 'completed',
            result: 'existing',
            isExpanded: false,
          },
        ],
        isExpanded: false,
        asyncStatus: 'completed',
        agentId: 'agent-3',
        result: 'Intermediate line',
      };

      (deps.subagentManager.isLinkedAgentOutputTool as jest.Mock).mockReturnValueOnce(true);
      (deps.subagentManager.handleAgentOutputToolResult as jest.Mock).mockReturnValueOnce(completedSubagent);
      (deps.subagentManager.getByTaskId as jest.Mock).mockImplementation(
        (taskId: string) => taskId === completedSubagent.id ? completedSubagent : undefined,
      );
      runtime.loadSubagentFinalResult
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('Recovered final result after delayed flush');

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-3', content: 'agent result' },
        msg
      );

      expect(runtime.loadSubagentToolCalls).not.toHaveBeenCalled();
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledTimes(1);
      expect(deps.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(enqueueBackgroundWork).toHaveBeenCalledTimes(1);
      expect(runtime.loadSubagentFinalResult).toHaveBeenCalledTimes(2);
      expect(completedSubagent.result).toBe('Recovered final result after delayed flush');
      expect(deps.subagentManager.refreshAsyncSubagent).toHaveBeenCalledWith(completedSubagent);
      expect(persistConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tool header update on input re-dispatch', () => {
    it.each([
      ['Bash', { command: 'npm test' }],
      ['Read', { file_path: 'notes/test.md' }],
    ])('refines a pending generic tool to %s without duplicating it', async (name, input) => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk({
        id: 'refined-tool',
        input: {},
        name: 'tool',
        providerPayload: { rawName: 'tool' },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({
        id: 'refined-tool',
        input,
        name,
        providerPayload: { rawName: name.toLowerCase() },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.contentBlocks).toEqual([{ type: 'tool_use', toolId: 'refined-tool' }]);
      expect(msg.toolCalls![0]).toMatchObject({
        id: 'refined-tool',
        input,
        name,
        providerPayload: { rawName: name.toLowerCase() },
        status: 'running',
      });
      expect(renderToolCall).toHaveBeenCalledTimes(1);
      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'refined-tool', name }),
        expect.any(Map),
        { initiallyExpanded: false },
      );
    });

    it('selects the Edit renderer after a pending generic tool is refined', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
      createWriteEditBlock.mockReturnValueOnce({ wrapperEl: createMockEl() });
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'edit-refined', name: 'tool', input: {} },
        msg,
      );
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'edit-refined',
        name: 'Edit',
        input: { file_path: 'notes/test.md', old_string: 'old', new_string: 'new' },
      }, msg);
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.contentBlocks).toEqual([{ type: 'tool_use', toolId: 'edit-refined' }]);
      expect(createWriteEditBlock).toHaveBeenCalledTimes(1);
      expect(createWriteEditBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'edit-refined', name: 'Edit' }),
        { initiallyExpanded: false },
      );
      expect(renderToolCall).not.toHaveBeenCalled();
    });

    it.each(['Edit', 'Write'])('migrates a rendered generic tool in place to %s and finalizes its diff', async (name) => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const {
        createWriteEditBlock,
        finalizeWriteEditBlock,
        updateWriteEditWithDiff,
      } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const genericEl = createMockEl();
      const writeEditEl = createMockEl();
      let writeEditState: any;
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, genericEl);
        elements.set(toolCall.id, genericEl);
        return genericEl;
      });
      createWriteEditBlock.mockImplementationOnce((parent: any, toolCall: ToolCallInfo) => {
        mountMockChild(parent, writeEditEl);
        writeEditState = { wrapperEl: writeEditEl, toolCall, isExpanded: toolCall.isExpanded };
        return writeEditState;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        id: 'migrated-edit',
        input: {},
        name: 'tool',
        providerPayload: { rawName: 'tool' },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      const interveningTextEl = parentEl.children[1];
      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'migrated-edit', content: 'partial output' },
        msg,
      );

      await controller.handleStreamChunk({
        id: 'migrated-edit',
        input: name === 'Edit'
          ? { file_path: 'notes/test.md', old_string: 'old', new_string: 'new' }
          : { file_path: 'notes/test.md', content: 'new' },
        name,
        providerPayload: { rawInput: { path: 'notes/test.md' }, rawName: name.toLowerCase() },
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.contentBlocks?.filter(block => block.type === 'tool_use')).toEqual([
        { type: 'tool_use', toolId: 'migrated-edit' },
      ]);
      expect(genericEl.remove).toHaveBeenCalledTimes(1);
      expect(parentEl.children[0]).toBe(writeEditEl);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('migrated-edit')).toBe(writeEditEl);
      expect(deps.state.writeEditStates.get('migrated-edit')).toBe(writeEditState);
      expect(updateToolCallResult).not.toHaveBeenCalled();

      jest.advanceTimersByTime(16);
      await Promise.resolve();
      expect(updateToolCallResult).not.toHaveBeenCalled();

      await controller.handleStreamChunk({
        content: 'updated file',
        id: 'migrated-edit',
        toolUseResult: {
          filePath: 'notes/test.md',
          structuredPatch: [{
            lines: ['-old', '+new'],
            newLines: 1,
            newStart: 1,
            oldLines: 1,
            oldStart: 1,
          }],
        },
        type: 'tool_result',
      }, msg);

      expect(msg.toolCalls![0]).toMatchObject({
        id: 'migrated-edit',
        name,
        result: 'updated file',
        status: 'completed',
        providerPayload: { rawInput: { path: 'notes/test.md' }, rawName: name.toLowerCase() },
        diffData: {
          filePath: 'notes/test.md',
          stats: { added: 1, removed: 1 },
        },
      });
      expect(updateWriteEditWithDiff).toHaveBeenCalledWith(
        writeEditState,
        msg.toolCalls![0].diffData,
      );
      expect(finalizeWriteEditBlock).toHaveBeenCalledWith(writeEditState, false);
    });

    it('migrates a rendered Write tool back to generic without losing tool state', async () => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createWriteEditBlock } = jest.requireMock('@/features/chat/rendering/WriteEditRenderer');
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const writeEditEl = createMockEl();
      const genericEl = createMockEl();
      const writeEditState = { wrapperEl: writeEditEl, isExpanded: true };
      createWriteEditBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, writeEditEl);
        return writeEditState;
      });
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, genericEl);
        elements.set(toolCall.id, genericEl);
        return genericEl;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        id: 'reverse-migration',
        input: { content: 'draft', file_path: 'notes/test.md' },
        name: 'Write',
        providerPayload: { rawName: 'write_file', rawOutput: { partial: true } },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      const interveningTextEl = parentEl.children[1];
      const toolCall = msg.toolCalls![0];
      const diffData = {
        filePath: 'notes/test.md',
        diffLines: [{ type: 'insert' as const, text: 'draft', newLineNum: 1 }],
        stats: { added: 1, removed: 0 },
      };
      const subagent = {
        id: 'agent-1',
        description: 'Existing agent',
        status: 'completed' as const,
        toolCalls: [],
        isExpanded: true,
      };
      Object.assign(toolCall, {
        diffData,
        isExpanded: true,
        result: 'existing result',
        status: 'completed',
        subagent,
      });
      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'reverse-migration', content: ' queued output' },
        msg,
      );

      await controller.handleStreamChunk({
        id: 'reverse-migration',
        input: { file_path: 'notes/refined.md' },
        name: 'Read',
        providerPayload: { rawInput: { path: 'notes/refined.md' }, rawName: 'read_file' },
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.contentBlocks?.filter(block => block.type === 'tool_use')).toEqual([
        { type: 'tool_use', toolId: 'reverse-migration' },
      ]);
      expect(msg.toolCalls![0]).toBe(toolCall);
      expect(toolCall).toMatchObject({
        diffData,
        input: { content: 'draft', file_path: 'notes/refined.md' },
        isExpanded: true,
        name: 'Read',
        providerPayload: {
          rawInput: { path: 'notes/refined.md' },
          rawName: 'read_file',
          rawOutput: { partial: true },
        },
        result: 'existing result queued output',
        status: 'completed',
        subagent,
      });
      expect(renderToolCall).toHaveBeenCalledWith(
        parentEl,
        toolCall,
        deps.state.toolCallElements,
        { initiallyExpanded: true },
      );
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        'reverse-migration',
        toolCall,
        deps.state.toolCallElements,
      );
      expect(writeEditEl.remove).toHaveBeenCalledTimes(1);
      expect(parentEl.children[0]).toBe(genericEl);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('reverse-migration')).toBe(genericEl);
      expect(deps.state.writeEditStates.has('reverse-migration')).toBe(false);

      jest.advanceTimersByTime(16);
      await Promise.resolve();
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
    });

    it('rebuilds rendered generic tools for forward and reverse normalized-name changes', async () => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      renderToolCall.mockReset();
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const initialEl = createMockEl();
      const bashEl = createMockEl();
      const unknownEl = createMockEl();
      for (const element of [initialEl, bashEl, unknownEl]) {
        renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
          mountMockChild(parent, element);
          elements.set(toolCall.id, element);
          return element;
        });
      }
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'generic-migration', name: 'tool', input: {} },
        msg,
      );
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      const interveningTextEl = parentEl.children[1];
      const toolCall = msg.toolCalls![0];
      const diffData = {
        filePath: 'notes/test.md',
        diffLines: [],
        stats: { added: 0, removed: 0 },
      };
      const subagent = {
        id: 'agent-1',
        description: 'Existing agent',
        status: 'completed' as const,
        toolCalls: [],
        isExpanded: true,
      };
      Object.assign(toolCall, {
        diffData,
        isExpanded: true,
        result: 'existing result',
        status: 'completed',
        subagent,
      });

      await controller.handleStreamChunk({
        id: 'generic-migration',
        input: { command: 'npm test' },
        name: 'Bash',
        providerPayload: { rawName: 'run_terminal_command' },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({
        id: 'generic-migration',
        input: { future: true },
        name: 'future_tool',
        providerPayload: { rawOutput: { complete: true } },
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toEqual([toolCall]);
      expect(msg.contentBlocks?.filter(block => block.type === 'tool_use')).toEqual([
        { type: 'tool_use', toolId: 'generic-migration' },
      ]);
      expect(toolCall).toMatchObject({
        diffData,
        input: { command: 'npm test', future: true },
        isExpanded: true,
        name: 'future_tool',
        providerPayload: {
          rawName: 'run_terminal_command',
          rawOutput: { complete: true },
        },
        result: 'existing result',
        status: 'completed',
        subagent,
      });
      expect(renderToolCall).toHaveBeenCalledTimes(3);
      expect(renderToolCall).toHaveBeenNthCalledWith(
        2,
        parentEl,
        toolCall,
        deps.state.toolCallElements,
        { initiallyExpanded: true },
      );
      expect(renderToolCall).toHaveBeenNthCalledWith(
        3,
        parentEl,
        toolCall,
        deps.state.toolCallElements,
        { initiallyExpanded: true },
      );
      expect(updateToolCallResult).toHaveBeenCalledTimes(2);
      expect(initialEl.remove).toHaveBeenCalledTimes(1);
      expect(bashEl.remove).toHaveBeenCalledTimes(1);
      expect(parentEl.children[0]).toBe(unknownEl);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('generic-migration')).toBe(unknownEl);
      expect(deps.state.writeEditStates.has('generic-migration')).toBe(false);
    });

    it('rebuilds a rendered generic tool as TodoWrite and updates todo state once', async () => {
      const { parseTodoInput } = jest.requireMock('@/core/tools/todo');
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      renderToolCall.mockReset();
      const todos = [{ content: 'Task', status: 'in_progress', activeForm: 'Working' }];
      parseTodoInput.mockReturnValueOnce(todos);
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const initialEl = createMockEl();
      const todoEl = createMockEl();
      for (const element of [initialEl, todoEl]) {
        renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
          mountMockChild(parent, element);
          elements.set(toolCall.id, element);
          return element;
        });
      }
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'todo-migration', name: 'tool', input: {} },
        msg,
      );
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      await controller.handleStreamChunk({
        id: 'todo-migration',
        input: { todos },
        name: TOOL_TODO_WRITE,
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0]).toMatchObject({ name: TOOL_TODO_WRITE, input: { todos } });
      expect(msg.contentBlocks?.filter(block => block.type === 'tool_use')).toHaveLength(1);
      expect(parseTodoInput).toHaveBeenCalledTimes(1);
      expect(parseTodoInput).toHaveBeenCalledWith({ todos });
      expect(deps.state.currentTodos).toEqual(todos);
      expect(initialEl.remove).toHaveBeenCalledTimes(1);
      expect(deps.state.toolCallElements.get('todo-migration')).toBe(todoEl);
    });

    it('rebuilds a rendered generic tool as AskUserQuestion without duplicating result handling', async () => {
      const coreTools = jest.requireMock('@/core/tools/toolInput');
      const { renderToolCall, updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      renderToolCall.mockReset();
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const initialEl = createMockEl();
      const askEl = createMockEl();
      for (const element of [initialEl, askEl]) {
        renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
          mountMockChild(parent, element);
          elements.set(toolCall.id, element);
          return element;
        });
      }
      coreTools.extractResolvedAnswers.mockReturnValueOnce({ color: 'Blue' });
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'ask-migration', name: 'tool', input: {} },
        msg,
      );
      await controller.handleStreamChunk({ type: 'text', content: 'Intervening content' }, msg);
      await controller.handleStreamChunk({
        id: 'ask-migration',
        input: { questions: [{ id: 'color', question: 'Color?' }] },
        name: 'AskUserQuestion',
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({
        content: 'answered',
        id: 'ask-migration',
        toolUseResult: { answers: { color: 'Blue' } },
        type: 'tool_result',
      }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.contentBlocks?.filter(block => block.type === 'tool_use')).toHaveLength(1);
      expect(msg.toolCalls![0]).toMatchObject({
        name: 'AskUserQuestion',
        resolvedAnswers: { color: 'Blue' },
        result: 'answered',
        status: 'completed',
      });
      expect(coreTools.extractResolvedAnswers).toHaveBeenCalledTimes(1);
      expect(initialEl.remove).toHaveBeenCalledTimes(1);
      expect(deps.state.toolCallElements.get('ask-migration')).toBe(askEl);
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        'ask-migration',
        msg.toolCalls![0],
        deps.state.toolCallElements,
      );
    });

    it('preserves result and lifecycle state while refining the normalized name', async () => {
      const msg = createTestMessage();
      const diffData = {
        filePath: 'notes/test.md',
        diffLines: [],
        stats: { added: 1, removed: 0 },
      };
      const subagent = {
        id: 'agent-1',
        description: 'Existing agent',
        status: 'completed',
        toolCalls: [],
        isExpanded: true,
      };
      msg.toolCalls = [{
        id: 'preserved-tool',
        name: 'tool',
        input: { existing: true },
        providerPayload: { rawName: 'tool', rawOutput: { partial: true } },
        status: 'completed',
        result: 'existing result',
        diffData,
        subagent,
        isExpanded: true,
      } as ToolCallInfo];

      await controller.handleStreamChunk({
        id: 'preserved-tool',
        input: { command: 'npm test' },
        name: 'Bash',
        providerPayload: { rawInput: { command: 'npm test' }, rawName: 'run_terminal_command' },
        type: 'tool_use',
      }, msg);

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0]).toMatchObject({
        input: { command: 'npm test', existing: true },
        name: 'Bash',
        providerPayload: {
          rawInput: { command: 'npm test' },
          rawName: 'run_terminal_command',
          rawOutput: { partial: true },
        },
        result: 'existing result',
        status: 'completed',
      });
      expect(msg.toolCalls![0].diffData).toBe(diffData);
      expect(msg.toolCalls![0].subagent).toBe(subagent);
      expect(msg.toolCalls![0].isExpanded).toBe(true);
    });

    it('accepts an unknown refined name but ignores a later blank name', async () => {
      const msg = createTestMessage();
      const rawInput = { opaque: true };
      const rawOutput = { future: ['lossless'] };

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'unknown-tool',
        name: 'execute',
        input: rawInput,
        providerPayload: { rawInput, rawName: 'execute' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'unknown-tool',
        name: 'future_tool',
        input: rawInput,
        providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
      }, msg);
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'unknown-tool', name: '   ', input: { later: true } },
        msg,
      );

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0]).toMatchObject({
        input: { later: true, opaque: true },
        name: 'future_tool',
        providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
      });
    });

    it('second tool_use with same id updates existing tool input and header', async () => {
      const { getToolName, getToolSummary } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      // First tool_use - creates the tool call
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md' } },
        msg
      );

      // Flush the tool so it transitions from pending to rendered
      await controller.handleStreamChunk({ type: 'done' }, msg);

      // Manually set up a rendered tool element with name + summary children
      // (the mock renderToolCall doesn't actually populate toolCallElements)
      const toolEl = createMockEl();
      const nameChild = toolEl.createDiv({ cls: 'claudian-tool-name' });
      nameChild.setText('Read');
      const summaryChild = toolEl.createDiv({ cls: 'claudian-tool-summary' });
      summaryChild.setText('test.md');
      deps.state.toolCallElements.set('read-1', toolEl);

      getToolName.mockReturnValueOnce('Read');
      getToolSummary.mockReturnValueOnce('updated.md');

      // Second tool_use with same id - should update input and header
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'updated.md' } },
        msg
      );

      // Input should be merged
      expect(msg.toolCalls![0].input).toEqual(
        expect.objectContaining({ file_path: 'updated.md' })
      );
      // getToolName/getToolSummary should have been called with updated input
      expect(getToolName).toHaveBeenCalledWith('Read', expect.objectContaining({ file_path: 'updated.md' }));
      expect(getToolSummary).toHaveBeenCalledWith('Read', expect.objectContaining({ file_path: 'updated.md' }));
      // Header texts should be updated
      expect(nameChild.textContent).toBe('Read');
      expect(summaryChild.textContent).toBe('updated.md');
    });

    it('refreshes a rendered header for a title-only name refinement', async () => {
      const { getToolName, getToolSummary } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'title-only', name: 'tool', input: {} },
        msg,
      );
      await controller.handleStreamChunk({ type: 'done' }, msg);

      const toolEl = createMockEl();
      const nameChild = toolEl.createDiv({ cls: 'claudian-tool-name' });
      const summaryChild = toolEl.createDiv({ cls: 'claudian-tool-summary' });
      deps.state.toolCallElements.set('title-only', toolEl);
      getToolName.mockReturnValueOnce('Read');
      getToolSummary.mockReturnValueOnce('');

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'title-only', name: 'Read', input: {} },
        msg,
      );

      expect(msg.toolCalls![0].name).toBe('Read');
      expect(getToolName).toHaveBeenCalledWith('Read', {});
      expect(getToolSummary).toHaveBeenCalledWith('Read', {});
      expect(nameChild.textContent).toBe('Read');
      expect(summaryChild.textContent).toBe('');
    });
  });

  describe('Sync subagent finalization', () => {
    it('tool_result for a sync subagent calls finalizeSyncSubagent and updates Task toolCall', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();

      msg.toolCalls = [
        {
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'Do something' },
          status: 'running',
          subagent: { id: 'task-1', description: 'Do something', status: 'running', toolCalls: [], isExpanded: false },
        } as any,
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
        false,
        undefined
      );

      expect(msg.toolCalls![0].status).toBe('completed');
      expect(msg.toolCalls![0].result).toBe('Task completed successfully');
      expect(msg.toolCalls![0].subagent?.status).toBe('completed');
      expect(msg.toolCalls![0].subagent?.result).toBe('Task completed successfully');
    });
  });

  describe('Codex subagent lifecycle', () => {
    it('renders prompt immediately and final result after wait_agent resolves', async () => {
      const { createSubagentBlock, finalizeSubagentBlock } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();
      deps.getAgentService = () => ({
        providerId: 'codex',
        getCapabilities: jest.fn().mockReturnValue({
          providerId: 'codex',
          supportsPlanMode: true,
          planPathPrefix: '/.codex/plans/',
        }),
      }) as any;

      const subagentState = {
        info: { id: 'spawn-1', description: 'Codex subagent', prompt: '', status: 'running', toolCalls: [] },
        labelEl: { setText: jest.fn() },
      };
      createSubagentBlock.mockReturnValueOnce(subagentState);

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'spawn-1',
          name: TOOL_SPAWN_AGENT,
          input: { message: 'Inspect utils.ts and return the final patch summary.', model: 'gpt-5.4-mini' },
        },
        msg,
      );

      await controller.handleStreamChunk(
        {
          type: 'tool_result',
          id: 'spawn-1',
          content: '{"agent_id":"agent-1","nickname":"Zeno"}',
        },
        msg,
      );

      await controller.handleStreamChunk(
        {
          type: 'tool_use',
          id: 'wait-1',
          name: TOOL_WAIT_AGENT,
          input: { targets: ['agent-1'], timeout_ms: 30000 },
        },
        msg,
      );

      await controller.handleStreamChunk(
        {
          type: 'tool_result',
          id: 'wait-1',
          content: '{"status":{"agent-1":{"completed":"Patched utils.ts and verified imports."}},"timed_out":false}',
        },
        msg,
      );

      expect(createSubagentBlock).toHaveBeenCalledWith(
        expect.anything(),
        'spawn-1',
        expect.objectContaining({
          description: 'Codex subagent (gpt-5.4-mini)',
          prompt: 'Inspect utils.ts and return the final patch summary.',
        }),
      );
      expect(subagentState.info.description).toBe('Zeno (gpt-5.4-mini)');
      expect(finalizeSubagentBlock).toHaveBeenCalledWith(
        subagentState,
        'Patched utils.ts and verified imports.',
        false,
      );
    });
  });

  describe('Grok subagent lifecycle', () => {
    beforeEach(() => {
      const {
        createAsyncSubagentBlock,
        createSubagentBlock,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      createAsyncSubagentBlock.mockReset().mockReturnValue({
        info: { id: 'task-1', description: 'test', mode: 'async', status: 'running', toolCalls: [] },
        labelEl: { setText: jest.fn() },
      });
      createSubagentBlock.mockReset().mockReturnValue({
        info: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
        labelEl: { setText: jest.fn() },
      });
      deps.getAgentService = () => ({
        providerId: 'grok',
        getCapabilities: jest.fn().mockReturnValue({
          providerId: 'grok',
        }),
      }) as any;
    });

    it('converts a pending generic tool into one background subagent block', async () => {
      const {
        createAsyncSubagentBlock,
        finalizeAsyncSubagent,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const wrapperEl = createMockEl();
      const asyncState = {
        wrapperEl,
        info: {
          id: 'late-spawn',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createAsyncSubagentBlock.mockReturnValueOnce(asyncState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'late-spawn',
        name: 'tool',
        input: {},
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'late-spawn',
        name: 'spawn_subagent',
        input: {
          description: 'Inspect tools',
          prompt: 'Inspect them.',
          run_in_background: true,
          task_id: 'task-late',
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'late-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-late'] },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'late-output',
        content: 'Inspection complete.',
        toolUseResult: {
          providerPayload: {
            rawName: 'get_command_or_subagent_output',
            rawOutput: {
              Result: [{ output: 'Inspection complete.', status: 'completed', task_id: 'task-late' }],
            },
          },
        },
      }, msg);

      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.contentBlocks).toEqual([
        { type: 'tool_use', toolId: 'late-spawn' },
        { type: 'tool_use', toolId: 'late-output' },
      ]);
      expect(deps.state.pendingTools.has('late-spawn')).toBe(false);
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Inspection complete.',
        false,
      );
    });

    it('keeps a reclassified pending spawn before later pending tools', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createAsyncSubagentBlock } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const subagentEl = createMockEl();
      const laterToolEl = createMockEl();
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, subagentEl);
        return {
          wrapperEl: subagentEl,
          info: {
            id: 'ordered-spawn',
            description: 'Inspect tools',
            mode: 'async',
            status: 'running',
            toolCalls: [],
          },
          labelEl: { setText: jest.fn() },
        };
      });
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, laterToolEl);
        elements.set(toolCall.id, laterToolEl);
        return laterToolEl;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use', id: 'ordered-spawn', name: 'tool', input: {},
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use', id: 'later-tool', name: 'Read', input: { file_path: 'later.md' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'ordered-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-ordered' },
      }, msg);
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(parentEl.children).toHaveLength(2);
      expect(parentEl.children[0]).toBe(subagentEl);
      expect(parentEl.children[1]).toBe(laterToolEl);
      expect(msg.contentBlocks).toEqual([
        { type: 'tool_use', toolId: 'ordered-spawn' },
        { type: 'tool_use', toolId: 'later-tool' },
      ]);
    });

    it('replaces an already-rendered generic tool at the same DOM position', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createAsyncSubagentBlock } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const genericEl = createMockEl();
      const subagentEl = createMockEl();
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, genericEl);
        elements.set(toolCall.id, genericEl);
        return genericEl;
      });
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, subagentEl);
        return {
          wrapperEl: subagentEl,
          info: {
            id: 'rendered-spawn',
            description: 'Inspect tools',
            mode: 'async',
            status: 'running',
            toolCalls: [],
          },
          labelEl: { setText: jest.fn() },
        };
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use', id: 'rendered-spawn', name: 'tool', input: {},
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'After tool' }, msg);
      const textEl = parentEl.children[1];
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'rendered-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-rendered' },
      }, msg);

      expect(genericEl.remove).toHaveBeenCalled();
      expect(parentEl.children).toEqual([subagentEl, textEl]);
      expect(deps.state.toolCallElements.has('rendered-spawn')).toBe(false);
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
    });

    it('replaces a provisional sync subagent when refined input makes it background', async () => {
      const {
        createAsyncSubagentBlock,
        createSubagentBlock,
        updateAsyncSubagentRunning,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const syncEl = createMockEl();
      const asyncEl = createMockEl();
      const syncState = {
        wrapperEl: syncEl,
        info: {
          id: 'refined-mode-spawn',
          description: 'Inspect tools',
          mode: 'sync',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      const asyncState = {
        wrapperEl: asyncEl,
        info: {
          id: 'refined-mode-spawn',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, syncEl);
        return syncState;
      });
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, asyncEl);
        return asyncState;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'refined-mode-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'refined-mode-spawn',
        name: 'spawn_subagent',
        input: { run_in_background: true, task_id: 'task-refined-mode' },
      }, msg);

      expect(syncEl.remove).toHaveBeenCalled();
      expect(parentEl.children).toEqual([asyncEl]);
      expect(createSubagentBlock).toHaveBeenCalledTimes(1);
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
      expect(updateAsyncSubagentRunning).toHaveBeenCalledWith(
        asyncState,
        'task-refined-mode',
      );
    });

    it('finalizes a generic tool that is reclassified as a completed sync spawn', async () => {
      const {
        createSubagentBlock,
        finalizeSubagentBlock,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const subagentState = {
        wrapperEl: createMockEl(),
        info: {
          id: 'terminal-spawn',
          description: 'Inspect tools',
          mode: 'sync',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createSubagentBlock.mockReturnValueOnce(subagentState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use', id: 'terminal-spawn', name: 'tool', input: {},
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result', id: 'terminal-spawn', content: 'Inspection complete.',
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'terminal-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', prompt: 'Inspect them.' },
      }, msg);

      expect(finalizeSubagentBlock).toHaveBeenCalledWith(
        subagentState,
        'Inspection complete.',
        false,
      );
    });

    it('removes a rendered wait card after a late spawn binding links it', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const {
        createAsyncSubagentBlock,
        finalizeAsyncSubagent,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const waitEl = createMockEl();
      const subagentEl = createMockEl();
      const asyncState = {
        wrapperEl: subagentEl,
        info: {
          id: 'late-binding-spawn',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, waitEl);
        elements.set(toolCall.id, waitEl);
        return waitEl;
      });
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, subagentEl);
        return asyncState;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'early-wait',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-late-binding'] },
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Waiting' }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'late-binding-spawn',
        name: 'spawn_subagent',
        input: {
          description: 'Inspect tools',
          run_in_background: true,
          task_id: 'task-late-binding',
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'early-wait',
        content: 'Inspection complete.',
        toolUseResult: {
          providerPayload: {
            rawName: 'get_command_or_subagent_output',
            rawOutput: {
              Result: [{
                output: 'Inspection complete.',
                status: 'completed',
                task_id: 'task-late-binding',
              }],
            },
          },
        },
      }, msg);

      expect(waitEl.remove).toHaveBeenCalled();
      expect(deps.state.toolCallElements.has('early-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'early-wait' });
      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Inspection complete.',
        false,
      );
    });

    it('removes a rendered generic card when refined wait input links it', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createAsyncSubagentBlock } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const subagentEl = createMockEl();
      const waitEl = createMockEl();
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, subagentEl);
        return {
          wrapperEl: subagentEl,
          info: {
            id: 'refined-wait-spawn',
            description: 'Inspect tools',
            mode: 'async',
            status: 'running',
            toolCalls: [],
          },
          labelEl: { setText: jest.fn() },
        };
      });
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, waitEl);
        elements.set(toolCall.id, waitEl);
        return waitEl;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'refined-wait-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-refined-wait' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use', id: 'refined-wait', name: 'tool', input: {},
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Waiting' }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'refined-wait',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-refined-wait'] },
      }, msg);

      expect(waitEl.remove).toHaveBeenCalled();
      expect(deps.state.toolCallElements.has('refined-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'refined-wait' });
    });

    it('replays a terminal generic result when the call is reclassified as output', async () => {
      const { createAsyncSubagentBlock, finalizeAsyncSubagent } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const asyncState = {
        wrapperEl: createMockEl(),
        info: {
          id: 'terminal-output-spawn',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createAsyncSubagentBlock.mockReturnValueOnce(asyncState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'terminal-output-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-terminal-output' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'terminal-output',
        name: 'tool',
        input: { task_ids: ['task-terminal-output'] },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'terminal-output',
        content: 'Inspection complete.',
        toolUseResult: {
          providerPayload: {
            rawName: 'get_command_or_subagent_output',
            rawOutput: {
              Result: [{
                output: 'Inspection complete.',
                status: 'completed',
                task_id: 'task-terminal-output',
              }],
            },
          },
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'terminal-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-terminal-output'] },
      }, msg);

      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Inspection complete.',
        false,
      );
    });

    it('removes a rendered output card when late raw output identifies its subagent', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const { createAsyncSubagentBlock, finalizeAsyncSubagent } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const parentEl = createMockEl();
      installOrderedMockParent(parentEl);
      deps.state.currentContentEl = parentEl;
      const subagentEl = createMockEl();
      const outputEl = createMockEl();
      createAsyncSubagentBlock.mockImplementationOnce((parent: any) => {
        mountMockChild(parent, subagentEl);
        return {
          wrapperEl: subagentEl,
          info: {
            id: 'raw-output-spawn',
            description: 'Inspect tools',
            mode: 'async',
            status: 'running',
            toolCalls: [],
          },
          labelEl: { setText: jest.fn() },
        };
      });
      renderToolCall.mockImplementationOnce((parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        mountMockChild(parent, outputEl);
        elements.set(toolCall.id, outputEl);
        return outputEl;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'raw-output-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-from-output' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'raw-output-wait',
        name: 'get_command_or_subagent_output',
        input: {},
      }, msg);
      await controller.handleStreamChunk({ type: 'text', content: 'Waiting' }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'raw-output-wait',
        name: 'get_command_or_subagent_output',
        input: {},
        providerPayload: {
          rawName: 'get_command_or_subagent_output',
          rawOutput: {
            Result: [{
              output: 'Inspection complete.',
              status: 'completed',
              task_id: 'task-from-output',
            }],
          },
        },
      }, msg);

      expect(outputEl.remove).toHaveBeenCalled();
      expect(deps.state.toolCallElements.has('raw-output-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'raw-output-wait' });

      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'raw-output-wait',
        content: 'Inspection complete.',
      }, msg);

      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ info: expect.objectContaining({ id: 'raw-output-spawn' }) }),
        'Inspection complete.',
        false,
      );
    });

    it('restores a hidden output card when later evidence reveals a command target', async () => {
      const { renderToolCall } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'mixed-late-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-mixed-late' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'mixed-late-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-mixed-late'] },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'mixed-late-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-mixed-late', 'command-mixed-late'] },
      }, msg);
      await controller.handleStreamChunk({ type: 'done' }, msg);

      expect(msg.contentBlocks).toContainEqual({
        type: 'tool_use',
        toolId: 'mixed-late-output',
      });
      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'mixed-late-output' }),
        expect.any(Map),
        { initiallyExpanded: false },
      );
    });

    it('keeps a mixed command and subagent output card while completing the subagent', async () => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock(
        '@/features/chat/rendering/ToolCallRenderer',
      );
      const {
        createAsyncSubagentBlock,
        finalizeAsyncSubagent,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const outputEl = createMockEl();
      const asyncState = {
        wrapperEl: createMockEl(),
        info: {
          id: 'mixed-spawn',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createAsyncSubagentBlock.mockReturnValueOnce(asyncState);
      renderToolCall.mockImplementationOnce((_parent: any, toolCall: ToolCallInfo, elements: Map<string, any>) => {
        elements.set(toolCall.id, outputEl);
        return outputEl;
      });
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'mixed-spawn',
        name: 'spawn_subagent',
        input: { description: 'Inspect tools', run_in_background: true, task_id: 'task-mixed' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'mixed-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-mixed', 'command-mixed'] },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'mixed-output',
        content: 'Subagent and command finished.',
        toolUseResult: {
          providerPayload: {
            rawName: 'get_command_or_subagent_output',
            rawOutput: {
              Result: [
                { output: 'Inspection complete.', status: 'completed', task_id: 'task-mixed' },
                { output: 'Command complete.', status: 'completed', task_id: 'command-mixed' },
              ],
            },
          },
        },
      }, msg);

      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'mixed-output' });
      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'mixed-output' }),
        expect.any(Map),
        { initiallyExpanded: false },
      );
      expect(updateToolCallResult).toHaveBeenCalledWith(
        'mixed-output',
        expect.objectContaining({ result: 'Subagent and command finished.' }),
        expect.any(Map),
      );
      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Inspection complete.',
        false,
      );
    });

    it('updates one background block across refined spawn input and output completion', async () => {
      const {
        createAsyncSubagentBlock,
        finalizeAsyncSubagent,
        updateAsyncSubagentRunning,
      } = jest.requireMock('@/features/chat/rendering/SubagentRenderer');
      const asyncState = {
        info: {
          id: 'spawn-1',
          description: 'Inspect tools',
          mode: 'async',
          status: 'running',
          toolCalls: [],
        },
        labelEl: { setText: jest.fn() },
      };
      createAsyncSubagentBlock.mockReturnValueOnce(asyncState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'spawn-1',
        name: 'spawn_subagent',
        input: { background: true, description: 'Inspect tools', prompt: 'Inspect them.' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'spawn-1',
        name: 'spawn_subagent',
        input: { run_in_background: true, task_id: 'task-7' },
        providerPayload: {
          rawInput: { run_in_background: true, task_id: 'task-7' },
          rawName: 'spawn_subagent',
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'spawn-1',
        content: 'Spawned task-7',
        toolUseResult: {
          providerPayload: {
            rawInput: { run_in_background: true, task_id: 'task-7' },
            rawName: 'spawn_subagent',
            rawOutput: { text: 'Spawned task-7', type: 'text' },
          },
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'output-1',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-7'], timeout_ms: 30000 },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'output-1',
        content: 'Renderer mappings verified.',
        toolUseResult: {
          providerPayload: {
            rawName: 'get_command_or_subagent_output',
            rawOutput: {
              Result: [{ output: 'Renderer mappings verified.', status: 'completed', task_id: 'task-7' }],
              type: 'task_output',
            },
          },
        },
      }, msg);

      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.toolCalls![0]).toEqual(expect.objectContaining({
        id: 'spawn-1',
        input: expect.objectContaining({ task_id: 'task-7' }),
        providerPayload: expect.objectContaining({
          rawOutput: { text: 'Spawned task-7', type: 'text' },
        }),
      }));
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
      expect(updateAsyncSubagentRunning).toHaveBeenCalledWith(asyncState, 'task-7');
      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Renderer mappings verified.',
        false,
      );
    });

    it('finalizes a foreground spawn directly from its terminal result', async () => {
      const { createSubagentBlock, finalizeSubagentBlock } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const syncState = {
        info: { id: 'spawn-2', description: 'Review code', status: 'running', toolCalls: [] },
        labelEl: { setText: jest.fn() },
      };
      createSubagentBlock.mockReturnValueOnce(syncState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'spawn-2',
        name: 'spawn_subagent',
        input: { description: 'Review code', prompt: 'Review it.', run_in_background: false },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'spawn-2',
        content: 'No material findings.',
        toolUseResult: {
          providerPayload: {
            rawName: 'spawn_subagent',
            rawOutput: { text: 'No material findings.', type: 'text' },
          },
        },
      }, msg);

      expect(finalizeSubagentBlock).toHaveBeenCalledWith(syncState, 'No material findings.', false);
    });

    it('finalizes a killed background task as an error', async () => {
      const { createAsyncSubagentBlock, finalizeAsyncSubagent } = jest.requireMock(
        '@/features/chat/rendering/SubagentRenderer',
      );
      const asyncState = {
        info: { id: 'spawn-3', description: 'Wait', mode: 'async', status: 'running', toolCalls: [] },
        labelEl: { setText: jest.fn() },
      };
      createAsyncSubagentBlock.mockReturnValueOnce(asyncState);
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use', id: 'spawn-3', name: 'task',
        input: { description: 'Wait', run_in_background: true, task_id: 'task-3' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result', id: 'spawn-3', content: 'Started task-3',
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use', id: 'kill-3', name: 'kill_task', input: { task_id: 'task-3' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result', id: 'kill-3', content: 'Task task-3 cancelled',
      }, msg);

      expect(finalizeAsyncSubagent).toHaveBeenCalledWith(
        asyncState,
        'Task task-3 cancelled',
        true,
      );
    });

    it('keeps the shared output tool visible for a background command', async () => {
      const { renderToolCall, updateToolCallResult } = jest.requireMock(
        '@/features/chat/rendering/ToolCallRenderer',
      );
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'output-command',
        name: 'get_command_or_subagent_output',
        input: { task_id: 'command-1', timeout_ms: 30000 },
        providerPayload: {
          rawInput: { task_id: 'command-1', timeout_ms: 30000 },
          rawName: 'get_command_or_subagent_output',
        },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'output-command',
        content: 'Command finished.',
      }, msg);

      expect(msg.contentBlocks).toEqual([{ type: 'tool_use', toolId: 'output-command' }]);
      expect(renderToolCall).toHaveBeenCalled();
      expect(updateToolCallResult).toHaveBeenCalled();
    });
  });

  describe('Async task tool result', () => {
    it('tool_result for a pending async task returns true from handleAsyncTaskToolResult', async () => {
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
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
        undefined,
        undefined
      );

      expect(updateToolCallResult).not.toHaveBeenCalled();
      expect(msg.toolCalls).toEqual([]);
    });

    it('passes structured toolUseResult through to async Task result handler', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = createMockEl();
      (deps.subagentManager.isPendingAsyncTask as jest.Mock).mockReturnValueOnce(true);

      const structured = { data: { agent_id: 'agent-from-structured' } };
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task started', toolUseResult: structured } as any,
        msg
      );

      expect(deps.subagentManager.handleTaskToolResult).toHaveBeenCalledWith(
        'task-1',
        'Task started',
        undefined,
        structured
      );
    });

    it('normalizes structured tool_result content before storing it on tool calls', async () => {
      const { updateToolCallResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      const msg = createTestMessage();
      msg.toolCalls = [
        {
          id: 'mcp-1',
          name: 'mcp__stitch__create_project',
          input: {},
          status: 'running',
          isExpanded: false,
        } as any,
      ];

      await controller.handleStreamChunk(
        {
          type: 'tool_result',
          id: 'mcp-1',
          content: [{ type: 'text', text: 'Created project successfully' }],
        } as any,
        msg,
      );

      expect(msg.toolCalls[0].status).toBe('completed');
      expect(msg.toolCalls[0].result).toBe('Created project successfully');
      expect(updateToolCallResult).toHaveBeenCalled();
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
      const activeWindow = deps.state.currentContentEl!.ownerDocument.defaultView!;
      const clearIntervalSpy = jest.spyOn(activeWindow, 'clearInterval');

      // Manually set a pre-existing interval
      deps.state.setFlavorTimerInterval(activeWindow.setInterval(() => {}, 9999), activeWindow);

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

describe('StreamController - Plan Mode', () => {
  let controller: StreamController;
  let deps: StreamControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    installTestWindow();
    deps = createMockDeps();
    controller = new StreamController(deps);
    deps.state.currentContentEl = createMockEl();
  });

  afterEach(() => {
    deps.state.resetStreamingState();
    restoreTestWindow();
    jest.useRealTimers();
  });

  describe('capturePlanFilePath', () => {
    it('should capture plan file path from Write tool_use', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/home/user/.claude/plans/plan.md' } },
        msg
      );

      expect(deps.state.planFilePath).toBe('/home/user/.claude/plans/plan.md');
    });

    it('should capture plan file path with Windows backslashes', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'C:\\.claude\\plans\\plan.md' } },
        msg
      );

      expect(deps.state.planFilePath).toBe('C:\\.claude\\plans\\plan.md');
    });

    it('should not capture non-plan Write paths', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/home/user/notes/todo.md' } },
        msg
      );

      expect(deps.state.planFilePath).toBeNull();
    });

    it('should not capture plan path from non-Write tools', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/home/user/.claude/plans/plan.md' } },
        msg
      );

      expect(deps.state.planFilePath).toBeNull();
    });

    it('should capture plan file path on subsequent tool_use input update', async () => {
      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'write-1',
        name: 'Write',
        input: { content: 'plan content' },
        status: 'running',
      }];

      // Second tool_use chunk with same ID updates the input (file_path arrives later)
      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/home/user/.claude/plans/plan.md' } },
        msg
      );

      expect(deps.state.planFilePath).toBe('/home/user/.claude/plans/plan.md');
    });
  });

  describe('blocked detection bypass', () => {
    it('persists provider payload from an incomplete tool stream without changing presentation', async () => {
      const rawInput = ['opaque', { nested: true }];
      const rawOutput = { partial: { bytes: [1, 2, 3] } };
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        id: 'future-incomplete',
        input: {},
        name: 'Read',
        providerPayload: { rawInput, rawName: 'future_tool' },
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({
        id: 'future-incomplete',
        input: {},
        name: 'Read',
        providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
        type: 'tool_use',
      }, msg);

      expect(JSON.parse(JSON.stringify(msg)).toolCalls[0]).toMatchObject({
        input: {},
        name: 'Read',
        providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
        status: 'running',
      });
    });

    it('persists provider tool payload without replacing concise presentation', async () => {
      const rawInput = ['opaque', { nested: true }];
      const rawOutput = { future: { bytes: [1, 2, 3] } };
      const msg = createTestMessage();

      await controller.handleStreamChunk({
        id: 'future-1',
        input: {},
        name: 'future_tool',
        type: 'tool_use',
      }, msg);
      await controller.handleStreamChunk({
        content: 'Concise result',
        id: 'future-1',
        toolUseResult: {
          providerPayload: {
            rawInput,
            rawName: 'future_tool',
            rawOutput,
          },
        },
        type: 'tool_result',
      }, msg);

      const persisted = JSON.parse(JSON.stringify(msg));
      expect(persisted.toolCalls[0]).toMatchObject({
        input: {},
        name: 'future_tool',
        providerPayload: {
          rawInput,
          rawName: 'future_tool',
          rawOutput,
        },
        result: 'Concise result',
        status: 'completed',
      });
      expect(persisted.toolCalls[0].result).not.toContain('bytes');
    });

    it('should hydrate AskUserQuestion resolvedAnswers from result text fallback', async () => {
      const coreTools = jest.requireMock('@/core/tools/toolInput');
      (coreTools.extractResolvedAnswers as jest.Mock).mockReturnValueOnce(undefined);
      (coreTools.extractResolvedAnswersFromResultText as jest.Mock).mockReturnValueOnce({
        'Color?': 'Blue',
      });

      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Color?' }] },
        status: 'running',
      }];

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'ask-1', content: '"Color?"="Blue"' },
        msg
      );

      expect(msg.toolCalls![0].resolvedAnswers).toEqual({ 'Color?': 'Blue' });
    });

    it('should not mark AskUserQuestion as blocked even when result looks blocked', async () => {
      const { isBlockedToolResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      (isBlockedToolResult as jest.Mock).mockReturnValueOnce(true);

      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: {},
        status: 'running',
      }];

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'ask-1', content: 'User denied this action.' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('completed');
    });

    it('should not mark ExitPlanMode as blocked even when result looks blocked', async () => {
      const { isBlockedToolResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      (isBlockedToolResult as jest.Mock).mockReturnValueOnce(true);

      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'exit-1',
        name: 'ExitPlanMode',
        input: {},
        status: 'running',
      }];

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'exit-1', content: 'User denied.' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('completed');
    });

    it('should mark regular tool as blocked when result is blocked', async () => {
      const { isBlockedToolResult } = jest.requireMock('@/features/chat/rendering/ToolCallRenderer');
      (isBlockedToolResult as jest.Mock).mockReturnValueOnce(true);

      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'rm -rf /' },
        status: 'running',
      }];

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'bash-1', content: 'Access denied by user approval' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('blocked');
    });
  });
});
