// @vitest-environment jsdom
const mockedTools = vi.mocked(await import('@/features/chat/rendering/tools/ToolCallRenderer'));
const mockedEdits = vi.mocked(await import('@/features/chat/rendering/tools/WriteEditRenderer'));
const mockedThinking = vi.mocked(await import('@/features/chat/rendering/ThinkingBlockRenderer'));
const mockedSubagents = vi.mocked(await import('@/features/chat/subagents/SubagentRenderer'));
import '@/providers';

import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { fireEvent, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';
import type { Mock } from 'vitest';

import {
  TOOL_AGENT_OUTPUT,
  TOOL_APPLY_PATCH,
  TOOL_SPAWN_AGENT,
  TOOL_SUBAGENT,
  TOOL_TODO_WRITE,
  TOOL_WAIT_AGENT,
} from '@/core/tools/toolNames';
import type { ChatMessage, ToolCallInfo } from '@/core/types';
import * as displayOnlyCodeFences from '@/features/chat/rendering/markdown/DisplayOnlyCodeFences';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { ChatState } from '@/features/chat/state/ChatState';
import {
  AsyncSubagentHistoryRecovery,
  type AsyncSubagentHistoryRecoveryDeps,
} from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController, type StreamControllerDeps } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import * as markdownMath from '@/utils/markdownMath';


const realRenderers: MessageRenderer[] = [];
const components: Component[] = [];
function observeRendering() {
  for (const [module, names] of [
    [mockedTools, ['renderToolCall', 'updateToolCallResult', 'refreshToolCallHeader']],
    [mockedEdits, ['createWriteEditBlock', 'finalizeWriteEditBlock', 'updateWriteEditWithDiff']],
    [mockedThinking, ['createThinkingBlock', 'finalizeThinkingBlock', 'cleanupThinkingBlock']],
    [mockedSubagents, ['createSubagentBlock', 'updateSubagentBlock', 'createAsyncSubagentBlock', 'updateAsyncSubagentBlock']],
  ] as const) {
    for (const name of names) vi.spyOn(module as any, name);
  }
}

function renderedTool(parent: HTMLElement, id: string, name: RegExp, expanded = false): HTMLElement {
  const cards = parent.querySelectorAll<HTMLElement>(`[data-tool-id="${id}"]`);
  expect(cards).toHaveLength(1);
  expect(within(cards[0]).getByRole('button', { name, expanded })).toBeDefined();
  return cards[0];
}

function renderedSubagent(parent: HTMLElement, id: string, mode: 'sync' | 'async', label: RegExp, result?: string): HTMLElement {
  const attribute = mode === 'async' ? 'data-async-subagent-id' : 'data-subagent-id';
  const cards = parent.querySelectorAll<HTMLElement>(`[${attribute}="${id}"]`);
  expect(cards).toHaveLength(1);
  expect(within(cards[0]).getByRole('button', { name: label })).toBeDefined();
  if (result !== undefined) expect(within(cards[0]).getByText(result)).toBeDefined();
  return cards[0];
}

type MockStreamControllerDeps = Omit<StreamControllerDeps, 'getMessagesEl'> & {
  renderer: NonNullable<StreamControllerDeps['renderer']>;
  getMessagesEl: () => HTMLElement;
  getProviderSessionId: () => string | null;
  /** The recovery shares the stream's provider, session, manager, and window ports. */
  historyRecovery: AsyncSubagentHistoryRecoveryDeps;
  /** The turn owner the presentation state derives its stream generation from. */
  turns: TurnCoordinator;
};

async function createMockDeps(): Promise<MockStreamControllerDeps> {
  const turns = new TurnCoordinator();
  const state = new ChatState({}, undefined, turns);
  const messagesEl = document.body.createDiv();
  const subagentManager = new SubagentManager(() => undefined);
  for (const name of ['isPendingAsyncTask', 'isLinkedAgentOutputTool', 'handleAgentOutputToolResult',
    'handleAgentOutputToolUse', 'handleAsyncSubagentCompletion', 'handleTaskToolUse', 'handleTaskToolResult',
    'getByTaskId', 'refreshAsyncSubagent', 'hasPendingTask', 'resolvePendingTask', 'resolvePendingTaskFromTaskResult',
    'getSyncSubagent', 'addSyncToolCall', 'updateSyncToolResult', 'finalizeSyncSubagent',
    'resetStreamingState', 'resetLifecycleState'] as const) vi.spyOn(subagentManager, name);
  const plugin = await createChatFeatureHost({ app: new App(), settings: { permissionMode: 'yolo' } });
  const component = new Component();
  components.push(component);
  const renderer = new MessageRenderer(plugin, component, messagesEl);
  realRenderers.push(renderer);
  vi.spyOn(renderer, 'renderContent');
  vi.spyOn(renderer, 'addTextCopyButton');

  const deps: MockStreamControllerDeps = {
    plugin,
    state,
    renderer,
    subagentManager,
    getMessagesEl: () => messagesEl,
    updateQueueIndicator: vi.fn(),
    getProviderId: () => 'claude',
    getProviderSessionId: () => 'session-1',
    turns,
    historyRecovery: {
      subagentManager,
        getProviderId: () => deps.getProviderId?.() ?? 'claude',
      getProviderSessionId: () => deps.getProviderSessionId?.() ?? null,
      loadSubagentFinalResult: vi.fn().mockResolvedValue(null),
      loadSubagentToolCalls: vi.fn().mockResolvedValue([]),
      enqueueBackgroundWork: work => work(),
      persistConversation: vi.fn().mockResolvedValue(undefined),
    },
  };
  deps.asyncSubagentHistoryRecovery = new AsyncSubagentHistoryRecovery(deps.historyRecovery);
  return deps;
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
  let deps: MockStreamControllerDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    observeRendering();
    deps = await createMockDeps();
    vi.useFakeTimers();
    controller = new StreamController(deps);
    deps.state.currentContentEl = document.body.createDiv();
  });

  afterEach(() => {
    deps.state.clearThinkingIndicatorTimeout();
    deps.state.clearFlavorTimerInterval();
    controller.dispose();
    realRenderers.splice(0).forEach(renderer => renderer.dispose());
    components.splice(0).forEach(component => component.unload());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Text streaming', () => {
    it('should accumulate text across multiple chunks', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = document.body.createDiv();

      const chunks = ['This ', 'is ', 'a ', 'test.'];
      for (const chunk of chunks) {
        await controller.handleStreamChunk({ type: 'text', content: chunk }, msg);
      }

      expect(msg.content).toBe('This is a test.');
    });

    it('should coalesce text renders until the next animation frame', async () => {
      deps.state.currentTextEl = document.body.createDiv();

      await controller.appendText('Hello ');
      await controller.appendText('World');

      expect(deps.renderer.renderContent).not.toHaveBeenCalled();

      vi.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Hello World', { deferMath: true, deferDiagrams: true }
      );
    });

    it('should throttle successive streaming text renders', async () => {
      deps.state.currentTextEl = document.body.createDiv();

      await controller.appendText('First');
      await vi.advanceTimersByTimeAsync(16);
      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);

      await controller.appendText(' second');
      await vi.advanceTimersByTimeAsync(16);
      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(150);
      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(2);
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(
        deps.state.currentTextEl,
        'First second', { deferMath: true, deferDiagrams: true }
      );
    });

    it('forwards streaming policies without separate math or diagram scans', async () => {
      const mathSpy = vi.spyOn(markdownMath, 'hasStreamingMathDelimiters');
      const diagramSpy = vi.spyOn(displayOnlyCodeFences, 'hasDeferredDiagramFence');
      try {
        deps.state.currentTextEl = document.body.createDiv();
        controller.setTabActive(false);
        for (let i = 0; i < 20; i += 1) {
          await controller.appendText('$x$ ');
        }
        vi.advanceTimersByTime(500);
        await Promise.resolve();

        expect(deps.renderer.renderContent).not.toHaveBeenCalled();
        expect(mathSpy).not.toHaveBeenCalled();
        expect(diagramSpy).not.toHaveBeenCalled();

        controller.setTabActive(true);
        vi.advanceTimersByTime(16);
        await Promise.resolve();
        expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
        expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(
          deps.state.currentTextEl, '$x$ '.repeat(20), { deferMath: true, deferDiagrams: true }
        );
        expect(mathSpy).not.toHaveBeenCalled();
        expect(diagramSpy).not.toHaveBeenCalled();

        for (let i = 0; i < 20; i += 1) {
          await controller.appendText('$y$ ');
        }
        vi.advanceTimersByTime(16);
        await Promise.resolve();
        expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
        expect(mathSpy).not.toHaveBeenCalled();
        expect(diagramSpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(150);
        await Promise.resolve();
        expect(deps.renderer.renderContent).toHaveBeenCalledTimes(2);
        expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(
          deps.state.currentTextEl, '$x$ '.repeat(20) + '$y$ '.repeat(20), { deferMath: true, deferDiagrams: true }
        );
        expect(mathSpy).not.toHaveBeenCalled();
      } finally {
        mathSpy.mockRestore();
        diagramSpy.mockRestore();
      }
    });

    it('should catch up with the latest text when a hidden tab becomes active', async () => {
      deps.state.currentTextEl = document.body.createDiv();
      controller.setTabActive(false);

      await controller.appendText('Hidden ');
      await controller.appendText('content');
      vi.advanceTimersByTime(500);
      await Promise.resolve();

      expect(deps.renderer.renderContent).not.toHaveBeenCalled();

      controller.setTabActive(true);
      vi.advanceTimersByTime(16);
      await Promise.resolve();

      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        deps.state.currentTextEl,
        'Hidden content', { deferMath: true, deferDiagrams: true }
      );
    });

    it('should force the final text render while its viewport is hidden', async () => {
      const msg = createTestMessage();
      deps.state.currentTextEl = document.body.createDiv();
      controller.setViewportVisible(false);

      await controller.appendText('Final hidden content');
      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        expect.anything(),
        'Final hidden content', { deferMath: true, deferDiagrams: true }
      );
    });

    it.each(['```mermaid', '> ```Mermaid title="example"', '- ~~~MERMAID'])('defers %s until text finalization', async opener => {
      deps.state.currentTextEl = document.body.createDiv();
      const content = `${opener}\ngraph TD\nA --> B`;
      await controller.appendText(content);
      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(
        deps.state.currentTextEl, content, { deferMath: true, deferDiagrams: true }
      );
      const target = deps.state.currentTextEl;
      await controller.finalizeCurrentTextBlock(createTestMessage());
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(target, content);
    });

    it.each([
      '```Vega-Lite\n{"mark": "bar"',
      // Raw HTML is escaped before rendering, which exposes the fence to the renderer.
      '<div>\n```vega-lite\n{"mark": "bar"',
      '> <div>\n> ```vega-lite\n> {"mark": "bar"',
    ])('defers listed plugin fence languages until text finalization: %s', async content => {
      (deps.plugin.settings as any).pluginRenderedFenceLanguages = ['vega-lite'];
      deps.state.currentTextEl = document.body.createDiv();
      await controller.appendText(content);
      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(
        deps.state.currentTextEl, content, { deferMath: true, deferDiagrams: true }
      );
      const target = deps.state.currentTextEl;
      await controller.finalizeCurrentTextBlock(createTestMessage());
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(target, content);
    });

    it('should flush a pending text render before finalizing text', async () => {
      const msg = createTestMessage();

      await controller.appendText('Hello');
      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.state.currentTextEl).toBeNull();
      expect(deps.state.currentTextContent).toBe('');

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(
        expect.anything(),
        'Hello', { deferMath: true, deferDiagrams: true }
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

    it('should coalesce a pending deferred render into the final math render', async () => {
      const msg = createTestMessage();

      await controller.appendText('Final $x^2$');
      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.renderContent).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'Final $x^2$'
      );
      expect(deps.renderer.renderContent).toHaveBeenCalledTimes(1);
      expect(deps.renderer.addTextCopyButton).toHaveBeenCalledWith(
        expect.anything(),
        'Final $x^2$'
      );
    });
  });

  describe('Text block finalization', () => {
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
      deps.state.currentTextEl = document.body.createDiv();
      deps.state.currentTextContent = '';

      await controller.finalizeCurrentTextBlock(msg);

      expect(deps.renderer.addTextCopyButton).not.toHaveBeenCalled();
      expect(msg.contentBlocks).toEqual([]);
    });
  });

  describe('context_compacted handling', () => {
    it('should record a context_compacted block on the message', async () => {
      const msg = createTestMessage();

      await controller.handleStreamChunk({ type: 'context_compacted' }, msg);

      expect(msg.contentBlocks).toContainEqual({ type: 'context_compacted' });
    });
  });

  describe('citation handling', () => {
    it('finalizes text and records a rendered citation block', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk({ type: 'text', content: 'Answer' }, msg);
      await controller.handleStreamChunk({
        type: 'citations',
        citations: {
          kind: 'memory',
          entries: [{
            path: 'MEMORY.md',
            lineStart: 10,
            lineEnd: 12,
            note: 'Used project conventions',
          }],
        },
      }, msg);

      expect(msg.contentBlocks).toEqual([
        { type: 'text', content: 'Answer' },
        {
          type: 'citations',
          citations: {
            kind: 'memory',
            entries: [{
              path: 'MEMORY.md',
              lineStart: 10,
              lineEnd: 12,
              note: 'Used project conventions',
            }],
          },
        },
      ]);
      const group = deps.state.currentContentEl!.querySelector('.claudian-citations');
      expect(group).not.toBeNull();
      expect(group!.querySelector('.claudian-citation-location')?.textContent).toBe('MEMORY.md:10\u201312');
      expect(group!.querySelector('.claudian-citation-note')?.textContent).toBe('Used project conventions');
    });
  });

  describe('Usage handling', () => {
    it('should update usage', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('preserves unknown usage identity instead of deriving it from global settings', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage({ model: undefined });
      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);
      expect(deps.state.usage).toEqual(usage);
    });

  });

  describe('Tool handling', () => {
    it('should add subagent entry to contentBlocks for Task tool', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      // Configure mock to return created_sync when run_in_background is known


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
        deps.state.currentContentEl = document.body.createDiv();
        deps.getProviderId = () => 'grok';

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
      const { renderToolCall } = mockedTools;
      vi.mocked(renderToolCall).mockClear();
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;
      deps.getProviderId = () => 'opencode';

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

      await controller.handleStreamChunk({ type: 'subagent_tool_use', subagentId: 'opencode-agent', id: 'child-read', name: 'Read', input: {} }, msg);
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
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.has('opencode-agent')).toBe(false);
      expect(deps.state.writeEditStates.has('opencode-agent')).toBe(false);
      renderedSubagent(deps.state.currentContentEl!, 'opencode-agent', 'sync', /^Subagent task:/);
    });

    it('routes the current Claude Agent tool through the managed subagent protocol', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();


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

    it.each([
      { changes: [{ path: 'notes/new.md', kind: 'add' }] },
      { patch: '*** Begin Patch\n*** Add File: notes/new.md\n+hello\n*** End Patch' },
    ])('refreshes the vault after successful current apply_patch input: %j', async (input) => {
      const vault = deps.plugin.app.vault;
      vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      vault.adapter.list = vi.fn().mockResolvedValue({ files: [], folders: [] });
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'patch-refresh', name: TOOL_APPLY_PATCH, input }, msg,
      );
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'patch-refresh', content: 'Success' }, msg,
      );
      await vi.advanceTimersByTimeAsync(200);

      expect(vault.getAbstractFileByPath).toHaveBeenCalledWith('notes/new.md');
      expect(vault.adapter.list).toHaveBeenCalledWith('notes');
    });

    it('refreshes the vault for files a script changed through nested calls, even when the script failed', async () => {
      const vault = deps.plugin.app.vault;
      vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      vault.adapter.list = vi.fn().mockResolvedValue({ files: [], folders: [] });
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'script-refresh', name: 'exec', input: { code: 'await tools.write({})' } }, msg,
      );
      await controller.handleStreamChunk({
        type: 'tool_result', id: 'script-refresh', content: 'Script error', isError: true,
        resultDetails: { scriptToolCalls: [
          { name: 'Write', input: { file_path: 'notes/new.md', content: 'hi' }, status: 'completed' },
          { name: TOOL_APPLY_PATCH, input: { patch: '*** Begin Patch\n*** Add File: drafts/plan.md\n+x\n*** End Patch' }, status: 'completed' },
          { name: 'Edit', input: { file_path: 'failed/edit.md' }, status: 'error' },
          { name: 'Read', input: { file_path: 'read/only.md' }, status: 'completed' },
        ] },
      }, msg);
      await vi.advanceTimersByTimeAsync(200);

      expect((vault.adapter.list as Mock).mock.calls.map(([dir]) => dir).sort()).toEqual(['drafts', 'notes']);
    });

    it('refreshes each nested file change once as script progress and completion arrive', async () => {
      const vault = deps.plugin.app.vault;
      vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      vault.adapter.list = vi.fn().mockResolvedValue({ files: [], folders: [] });
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();
      const write = { name: 'Write', input: { file_path: 'notes/new.md', content: 'hi' } };
      const edit = { name: 'Edit', input: { file_path: 'drafts/plan.md' } };
      const refreshedDirs = () => (vault.adapter.list as Mock).mock.calls.map(([dir]) => dir);

      await controller.handleStreamChunk({ type: 'tool_use', id: 'script-progress', name: 'exec', input: { code: '' } }, msg);
      await controller.handleStreamChunk({ type: 'tool_output', id: 'script-progress', content: '',
        resultDetails: { scriptToolCalls: [{ ...write, status: 'running' }] } }, msg);
      await controller.handleStreamChunk({ type: 'tool_output', id: 'script-progress', content: '',
        resultDetails: { scriptToolCalls: [{ ...write, status: 'completed' }, { ...edit, status: 'running' }] } }, msg);
      await vi.advanceTimersByTimeAsync(200);
      expect(refreshedDirs()).toEqual(['notes']);
      expect(msg.toolCalls?.[0].scriptToolCalls?.map(call => call.status)).toEqual(['completed', 'running']);

      await controller.handleStreamChunk({ type: 'tool_result', id: 'script-progress', content: 'done',
        resultDetails: { scriptToolCalls: [{ ...write, status: 'completed' }, { ...edit, status: 'completed' }] } }, msg);
      await vi.advanceTimersByTimeAsync(200);
      expect(refreshedDirs()).toEqual(['notes', 'drafts']);
    });

    it('should render a pending tool on tool_output and append incremental output', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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

      vi.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('bash-1'),
        expect.objectContaining({
          id: 'bash-1',
          status: 'running',
          result: 'line 1\n',
        })
      );

      await controller.handleStreamChunk(
        { type: 'tool_output', id: 'bash-1', content: 'line 2\n' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('running');
      expect(msg.toolCalls![0].result).toBe('line 1\nline 2\n');
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenLastCalledWith(
        deps.state.toolCallElements.get('bash-1'),
        expect.objectContaining({
          id: 'bash-1',
          status: 'running',
          result: 'line 1\nline 2\n',
        })
      );
      const card = renderedTool(deps.state.currentContentEl!, 'bash-1', /^Bash: npm test/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('line 1')).toBeDefined();
      expect(within(card).getByText('line 2')).toBeDefined();
    });

    it('should coalesce tool_output renders until the next animation frame', async () => {
      const { updateToolCallResult } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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

      vi.advanceTimersByTime(16);
      await Promise.resolve();

      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('bash-1'),
        expect.objectContaining({
          result: 'line 1\nline 2\n',
          status: 'running',
        })
      );
      const card = renderedTool(deps.state.currentContentEl!, 'bash-1', /^Bash: npm test/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('line 1')).toBeDefined();
      expect(within(card).getByText('line 2')).toBeDefined();
    });

    it('should flush pending tools before Task tool renders', async () => {
      const { renderToolCall } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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
      const read = renderedTool(deps.state.currentContentEl!, 'read-1', /^Read: test.md/);
      const task = renderedSubagent(deps.state.currentContentEl!, 'task-1', 'sync', /^Subagent task:/);
      expect(Array.from(deps.state.currentContentEl!.children)).toEqual([read, task]);
    });

    it('should clear pendingTools on resetStreamingState', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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
    it('should scroll to a newly shown thinking indicator when auto-scroll is enabled', () => {
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1_000, configurable: true });
      messagesEl.scrollTop = 0;

      controller.thinkingIndicator.show();
      vi.advanceTimersByTime(416);

      expect(deps.state.thinkingEl).not.toBeNull();
      expect(messagesEl.scrollTop).toBe(1_000);
    });

    it('should not scroll to a newly shown thinking indicator when auto-scroll is paused', () => {
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1_000, configurable: true });
      messagesEl.scrollTop = 0;
      deps.state.autoScrollEnabled = false;

      controller.thinkingIndicator.show();
      vi.advanceTimersByTime(416);

      expect(deps.state.thinkingEl).not.toBeNull();
      expect(messagesEl.scrollTop).toBe(0);
    });

    it('should clear timer interval in resetStreamingState', () => {
      deps.state.responseStartTime = performance.now();

      controller.thinkingIndicator.show();
      vi.advanceTimersByTime(500);
      expect(deps.state.flavorTimerInterval).not.toBeNull();

      controller.resetStreamingState();

      expect(deps.state.flavorTimerInterval).toBeNull();
    });
  });

  describe('Usage handling - edge cases', () => {
    it('should skip usage when subagentsSpawnedThisStream > 0', async () => {
      const msg = createTestMessage();
      vi.spyOn(deps.subagentManager, 'subagentsSpawnedThisStream', 'get').mockReturnValue(1);

      const usage = createMockUsage({ inputTokens: 100, contextWindow: 200, contextTokens: 100, percentage: 50 });

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toBeNull();
    });

    it('should update usage when no sessionId on chunk', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage();

      await controller.handleStreamChunk({ type: 'usage', usage } as any, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('uses reported usage chunks directly', async () => {
      const msg = createTestMessage();
      const usage = createMockUsage({
        model: TEST_CODEX_MODEL,
        contextWindow: 258400,
        contextTokens: 129200,
        percentage: 50,
      });

      await controller.handleStreamChunk({ type: 'usage', usage, sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toEqual(usage);
    });

    it('retains the same-model reported window when a partial update omits it', async () => {
      const msg = createTestMessage();
      await controller.handleStreamChunk({ type: 'usage', usage: createMockUsage({
        model: TEST_CODEX_MODEL, contextWindow: 200_000, contextTokens: 50_000, percentage: 25,
      }), sessionId: 'session-1' }, msg);

      await controller.handleStreamChunk({ type: 'usage', usage: createMockUsage({
        model: TEST_CODEX_MODEL, contextWindow: 0, contextTokens: 100_000, percentage: 0,
      }), sessionId: 'session-1' }, msg);

      expect(deps.state.usage).toMatchObject({ contextWindow: 200_000, contextTokens: 100_000, percentage: 50 });
    });


  });

  describe('Thinking indicator - edge cases', () => {
    it('drops explicit compaction status once the compaction boundary renders', async () => {
      const msg = createTestMessage();
      controller.thinkingIndicator.show('Compacting...', 'claudian-thinking--compact');
      vi.advanceTimersByTime(500);
      expect(deps.state.waitingStatus).toBe('Compacting...');

      await controller.handleStreamChunk({ type: 'context_compacted' }, msg);
      controller.thinkingIndicator.show();
      vi.advanceTimersByTime(500);

      expect(deps.state.waitingStatus).not.toBeNull();
      expect(deps.state.waitingStatus).not.toBe('Compacting...');
    });

    it('cancels a pending or visible indicator on dispose', () => {
      controller.thinkingIndicator.show();
      controller.dispose();
      vi.advanceTimersByTime(500);
      expect(deps.state.thinkingEl).toBeNull();
      expect(deps.state.waitingStatus).toBeNull();

      const visible = new StreamController(deps);
      visible.thinkingIndicator.show();
      vi.advanceTimersByTime(500);
      expect(deps.state.waitingStatus).not.toBeNull();
      visible.dispose();
      expect(deps.state.thinkingEl).toBeNull();
      expect(deps.state.waitingStatus).toBeNull();
      expect(deps.state.flavorTimerInterval).toBeNull();
    });

  });

  describe('scrollToBottom - settings', () => {
    it('scrolls after rendered snapshots instead of every text chunk', async () => {
      const messagesEl = deps.getMessagesEl();
      const readHeight = vi.fn(() => 1000);
      Object.defineProperty(messagesEl, 'scrollHeight', { get: readHeight, configurable: true });
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();
      deps.state.currentTextEl = document.body.createDiv();

      for (let index = 0; index < 60; index += 1) {
        await controller.handleStreamChunk({ type: 'text', content: 'chunk ' }, msg);
        await vi.advanceTimersByTimeAsync(20);
      }
      await controller.finalizeCurrentTextBlock(msg);
      await vi.advanceTimersByTimeAsync(20);

      expect(deps.renderer.renderContent).toHaveBeenCalledWith(expect.anything(), 'chunk '.repeat(60), { deferMath: true, deferDiagrams: true });
      expect(messagesEl.scrollTop).toBe(1000);
      expect(readHeight.mock.calls.length).toBeLessThanOrEqual(vi.mocked(deps.renderer.renderContent).mock.calls.length);
    });

    it('should not scroll when enableAutoScroll setting is false', async () => {
      (deps.plugin.settings as any).enableAutoScroll = false;
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      messagesEl.scrollTop = 0;

      const msg = createTestMessage();
      deps.state.currentTextEl = document.body.createDiv();
      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(messagesEl.scrollTop).toBe(0);

      (deps.plugin.settings as any).enableAutoScroll = true;
      await controller.handleStreamChunk({ type: 'text', content: ' again' }, msg);
      await vi.advanceTimersByTimeAsync(200);
      expect(messagesEl.scrollTop).toBe(1000);
    });

    it('should not scroll when autoScrollEnabled state is false', async () => {
      deps.state.autoScrollEnabled = false;
      const messagesEl = deps.getMessagesEl();
      Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
      messagesEl.scrollTop = 0;

      const msg = createTestMessage();
      deps.state.currentTextEl = document.body.createDiv();
      await controller.handleStreamChunk({ type: 'text', content: 'Hello' }, msg);

      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(messagesEl.scrollTop).toBe(0);

      deps.state.autoScrollEnabled = true;
      await controller.handleStreamChunk({ type: 'text', content: ' again' }, msg);
      await vi.advanceTimersByTimeAsync(200);
      expect(messagesEl.scrollTop).toBe(1000);
    });
  });

  describe('Subagent chunk handling', () => {
    it('routes provider child output and native completion payloads to the child tool', async () => {
      const msg = createTestMessage();
      await controller.handleStreamChunk({ type: 'tool_use', id: 'parent', name: TOOL_SUBAGENT, input: { description: 'Read notes', run_in_background: false } }, msg);
      await controller.handleStreamChunk({ type: 'subagent_tool_use', id: 'read', name: 'Read', input: {}, subagentId: 'parent' }, msg);
      const scope = { kind: 'requested' as const, sessionInstanceId: 's', executionId: 'e', turnId: 't', sequence: 1 };
      const toolScope = { kind: 'subagent' as const, subagentId: 'parent' };
      const output = providerOutputEventToStreamChunk({ type: 'tool_output', toolCallId: 'read', toolScope, scope, content: 'partial' })!;
      await controller.handleStreamChunk(output, msg);
      expect(deps.subagentManager.updateSyncToolResult).toHaveBeenLastCalledWith(
        'parent', 'read', expect.objectContaining({ status: 'running', result: 'partial' }),
      );
      const completion = providerOutputEventToStreamChunk({ type: 'tool_completed', toolCallId: 'read', toolScope, scope, content: 'complete', providerPayload: { rawOutput: { native: true } } })!;
      await controller.handleStreamChunk(completion, msg);
      expect(deps.subagentManager.updateSyncToolResult).toHaveBeenLastCalledWith(
        'parent', 'read', expect.objectContaining({ status: 'completed', result: 'complete', providerPayload: { rawOutput: { native: true } } }),
      );
      expect(msg.toolCalls?.map(tool => tool.id)).toEqual(['parent']);
      expect(msg.toolCalls?.[0].subagent?.toolCalls[0]).toMatchObject({ id: 'read', result: 'complete', status: 'completed', providerPayload: { rawOutput: { native: true } } });
    });

    it('should handle subagent tool_result chunk', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk({ type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { description: 'Read notes', run_in_background: false } }, msg);
      await controller.handleStreamChunk({ type: 'subagent_tool_use', id: 'read-1', name: 'Read', input: {}, subagentId: 'task-1' }, msg);
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
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk({ type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { description: 'Read notes', run_in_background: false } }, msg);
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
      deps.state.currentContentEl = document.body.createDiv();

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
      deps.state.currentContentEl = document.body.createDiv();

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
      deps.state.currentContentEl = document.body.createDiv();

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

  describe('Thinking block finalization', () => {
    it('should not add to contentBlocks when no thinking content', async () => {
      const msg = createTestMessage();
      await controller.appendThinking('');

      await controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });

    it('should be a no-op when no thinking state', async () => {
      const msg = createTestMessage();
      deps.state.currentThinkingState = null;

      await controller.finalizeCurrentThinkingBlock(msg);

      expect(msg.contentBlocks).toEqual([]);
    });

    it('defers Mermaid in thinking and renders it at finalization', async () => {
      const { createThinkingBlock } = mockedThinking;


      const content = '> ```mermaid\n> graph TD\n> A --> B';
      await controller.appendThinking(content);
      fireEvent.click(within(vi.mocked(createThinkingBlock).mock.results[0].value.wrapperEl).getByRole('button'));
      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(vi.mocked(createThinkingBlock).mock.results[0].value.contentEl, content, { deferMath: true, deferDiagrams: true });
      await controller.finalizeCurrentThinkingBlock(createTestMessage());
      expect(deps.renderer.renderContent).toHaveBeenLastCalledWith(vi.mocked(createThinkingBlock).mock.results[0].value.contentEl, content);
    });

    it('does not scan collapsed thinking deltas for deferred math or diagrams', async () => {
      const mathSpy = vi.spyOn(markdownMath, 'hasStreamingMathDelimiters');
      const diagramSpy = vi.spyOn(displayOnlyCodeFences, 'hasDeferredDiagramFence');
      try {
        const msg = createTestMessage();
        for (let i = 0; i < 20; i += 1) {
          await controller.handleStreamChunk({ type: 'thinking', content: '$x$ ' }, msg);
        }
        vi.advanceTimersByTime(500);
        await Promise.resolve();

        expect(deps.renderer.renderContent).not.toHaveBeenCalled();
        expect(mathSpy).not.toHaveBeenCalled();
        expect(diagramSpy).not.toHaveBeenCalled();
      } finally {
        mathSpy.mockRestore();
        diagramSpy.mockRestore();
      }
    });

  });

  describe('Pending Task tool handling', () => {
    it('should render pending Task as sync when child chunk arrives', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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


      // Also configure getSyncSubagent for the child chunk routing


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
      expect(deps.subagentManager.resolvePendingTask).toHaveBeenCalledWith('task-1', deps.state.currentContentEl);
    });

    it('should resolve pending Task as async via tool_result and continue async lifecycle', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something' } },
        msg
      );

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: '{"agent_id":"agent-1"}' },
        msg
      );

      expect(deps.subagentManager.resolvePendingTaskFromTaskResult).toHaveBeenCalledWith(
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

    it('should pass the task provider payload into pending Task resolver', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { prompt: 'Do something' } },
        msg
      );

      const providerPayload = { rawOutput: { isAsync: true, status: 'async_launched', agentId: 'agent-1' } };

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Launching...', providerPayload },
        msg
      );

      expect(deps.subagentManager.resolvePendingTaskFromTaskResult).toHaveBeenCalledWith(
        'task-1',
        'Launching...',
        false,
        deps.state.currentContentEl,
        providerPayload
      );
    });
  });

  describe('Agent output tool use/result', () => {
    it('TOOL_AGENT_OUTPUT chunk creates tool call and delegates to subagentManager.handleAgentOutputToolUse', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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
      const { updateToolCallResult } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'agent-out-1', content: 'agent result', providerPayload: { rawOutput: { foo: 'bar' } } },
        msg
      );

      expect(deps.subagentManager.handleAgentOutputToolResult).toHaveBeenCalledWith(
        'agent-out-1',
        'agent result',
        false,
        { rawOutput: { foo: 'bar' } }
      );
      expect(updateToolCallResult).not.toHaveBeenCalled();
    });

  });

  describe('Tool header update on input re-dispatch', () => {
    it.each([
      ['Bash', { command: 'npm test' }],
      ['Read', { file_path: 'notes/test.md' }],
    ])('refines a pending generic tool to %s without duplicating it', async (name, input) => {
      const { renderToolCall } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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
        expect.objectContaining({ initiallyExpanded: false }),
      );
      renderedTool(deps.state.currentContentEl!, 'refined-tool', name === 'Bash' ? /^Bash: npm test/ : /^Read: notes\/test.md/);
    });

    it('selects the Edit renderer after a pending generic tool is refined', async () => {
      const { renderToolCall } = mockedTools;
      const { createWriteEditBlock } = mockedEdits;

      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

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
        expect.objectContaining({ initiallyExpanded: false }),
      );
      expect(renderToolCall).not.toHaveBeenCalled();
      renderedTool(deps.state.currentContentEl!, 'edit-refined', /^Edit: notes\/test.md/);
    });

    it.each(['Edit', 'Write'])('migrates a rendered generic tool in place to %s and finalizes its diff', async (name) => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      const {
        createWriteEditBlock,
        finalizeWriteEditBlock,
        updateWriteEditWithDiff,
      } = mockedEdits;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(parentEl.children[0]).toBe(vi.mocked(createWriteEditBlock).mock.results[0].value.wrapperEl);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('migrated-edit')).toBe(vi.mocked(createWriteEditBlock).mock.results[0].value.wrapperEl);
      expect(deps.state.writeEditStates.get('migrated-edit')).toBe(vi.mocked(createWriteEditBlock).mock.results[0].value);
      expect(updateToolCallResult).not.toHaveBeenCalled();

      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(updateToolCallResult).not.toHaveBeenCalled();

      await controller.handleStreamChunk({
        content: 'updated file',
        id: 'migrated-edit',
        resultDetails: {
          diff: {
            filePath: 'notes/test.md',
            diffLines: [
              { type: 'delete', text: 'old', oldLineNum: 1 },
              { type: 'insert', text: 'new', newLineNum: 1 },
            ],
            stats: { added: 1, removed: 1 },
          },
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
        vi.mocked(createWriteEditBlock).mock.results[0].value,
        msg.toolCalls![0].diffData,
      );
      expect(finalizeWriteEditBlock).toHaveBeenCalledWith(vi.mocked(createWriteEditBlock).mock.results[0].value, false);
      const card = renderedTool(parentEl, 'migrated-edit', name === 'Edit' ? /^Edit: notes\/test.md/ : /^Write: notes\/test.md/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('old')).toBeDefined();
      expect(within(card).getByText('new')).toBeDefined();
    });

    it('migrates a rendered Write tool back to generic without losing tool state', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      const { createWriteEditBlock } = mockedEdits;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
        expect.objectContaining({ initiallyExpanded: true }),
      );
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('reverse-migration'),
        toolCall,
      );
      expect(vi.mocked(createWriteEditBlock).mock.results[0].value.wrapperEl.isConnected).toBe(false);
      expect(parentEl.children[0]).toBe(vi.mocked(renderToolCall).mock.results[0].value);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('reverse-migration')).toBe(vi.mocked(renderToolCall).mock.results[0].value);
      expect(deps.state.writeEditStates.has('reverse-migration')).toBe(false);

      vi.advanceTimersByTime(16);
      await Promise.resolve();
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      const card = renderedTool(parentEl, 'reverse-migration', /^Read: notes\/refined.md/, true);
      expect(within(card).getByText('existing result queued output')).toBeDefined();
    });

    it('rebuilds rendered generic tools for forward and reverse normalized-name changes', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      vi.mocked(renderToolCall).mockClear();
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
      renderedTool(parentEl, 'generic-migration', /^Bash: npm test/, true);
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
        expect.objectContaining({ initiallyExpanded: true }),
      );
      expect(renderToolCall).toHaveBeenNthCalledWith(
        3,
        parentEl,
        toolCall,
        expect.objectContaining({ initiallyExpanded: true }),
      );
      expect(updateToolCallResult).toHaveBeenCalledTimes(2);
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(vi.mocked(renderToolCall).mock.results[1].value.isConnected).toBe(false);
      expect(parentEl.children[0]).toBe(vi.mocked(renderToolCall).mock.results[2].value);
      expect(parentEl.children[1]).toBe(interveningTextEl);
      expect(deps.state.toolCallElements.get('generic-migration')).toBe(vi.mocked(renderToolCall).mock.results[2].value);
      expect(deps.state.writeEditStates.has('generic-migration')).toBe(false);
      const card = renderedTool(parentEl, 'generic-migration', /^future_tool/, true);
      expect(within(card).getByText('existing result')).toBeDefined();
    });

    it('rebuilds a rendered generic tool as TodoWrite', async () => {
      const { renderToolCall } = mockedTools;
      vi.mocked(renderToolCall).mockClear();
      const todos = [{ content: 'Task', status: 'in_progress', activeForm: 'Working' }];
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.get('todo-migration')).toBe(vi.mocked(renderToolCall).mock.results[1].value);
      const card = renderedTool(parentEl, 'todo-migration', /^Tasks \(0\/1\)/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('Working', { selector: '.claudian-todo-text' })).toBeDefined();
    });

    it('rebuilds a rendered generic tool as AskUserQuestion without duplicating result handling', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      vi.mocked(renderToolCall).mockClear();
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
        resultDetails: { resolvedAnswers: { color: 'Blue' } },
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
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.get('ask-migration')).toBe(vi.mocked(renderToolCall).mock.results[1].value);
      expect(updateToolCallResult).toHaveBeenCalledTimes(1);
      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('ask-migration'),
        msg.toolCalls![0],
      );
      const card = renderedTool(parentEl, 'ask-migration', /Question/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('Color?')).toBeDefined();
      expect(within(card).getByText('Blue')).toBeDefined();
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

    it('dispatches a merged same-id input refinement to the rendered header owner', async () => {
      const { renderToolCall, refreshToolCallHeader } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.md', offset: 4 } },
        msg
      );

      await controller.handleStreamChunk({ type: 'done' }, msg);
      const tool = msg.toolCalls![0];

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'updated.md' } },
        msg
      );

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0]).toBe(tool);
      expect(tool.input).toEqual({ file_path: 'updated.md', offset: 4 });
      expect(tool.status).toBe('running');
      expect(refreshToolCallHeader).toHaveBeenCalledWith(vi.mocked(renderToolCall).mock.results[0].value);
      expect(renderToolCall).toHaveBeenCalledTimes(1);
      renderedTool(deps.state.currentContentEl!, 'read-1', /^Read: updated.md/);
    });

    it('dispatches a title-only name refinement without losing the logical tool input', async () => {
      const { renderToolCall } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'title-only', name: 'tool', input: { file_path: 'retained.md' } },
        msg,
      );
      await controller.handleStreamChunk({ type: 'done' }, msg);

      const tool = msg.toolCalls![0];

      await controller.handleStreamChunk(
        { type: 'tool_use', id: 'title-only', name: 'Read', input: {} },
        msg,
      );

      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0]).toBe(tool);
      expect(tool).toMatchObject({ id: 'title-only', name: 'Read', input: { file_path: 'retained.md' }, status: 'running' });
      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(within(deps.state.currentContentEl!).getByRole('button', { name: /Read: retained.md/ })).toBeDefined();
    });
  });

  describe('Sync subagent finalization', () => {
    it('tool_result for a sync subagent calls finalizeSyncSubagent and updates Task toolCall', async () => {

      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk({ type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { description: 'Do something', run_in_background: false } }, msg);

      // getSyncSubagent returns a subagent state (indicating this is a sync subagent)


      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task completed successfully' },
        msg
      );

      expect(deps.subagentManager.finalizeSyncSubagent).toHaveBeenCalledWith(
        'task-1',
        'Task completed successfully',
        false,
        undefined,
        expect.objectContaining({ id: 'task-1' }),
      );

      expect(msg.toolCalls![0].status).toBe('completed');
      expect(msg.toolCalls![0].result).toBe('Task completed successfully');
      expect(msg.toolCalls![0].subagent?.status).toBe('completed');
      expect(msg.toolCalls![0].subagent?.result).toBe('Task completed successfully');
      renderedSubagent(deps.state.currentContentEl!, 'task-1', 'sync', /^Subagent task: Do something - Status: completed/, 'Task completed successfully');
    });
  });

  describe('Codex subagent lifecycle', () => {
    it('renders prompt immediately and final result after wait_agent resolves', async () => {
      const { createSubagentBlock, updateSubagentBlock } = mockedSubagents;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();
      deps.getProviderId = () => 'codex';

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

      expect(createSubagentBlock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          description: 'Codex subagent (gpt-5.4-mini)',
          prompt: 'Inspect utils.ts and return the final patch summary.',
        }));
      expect(vi.mocked(createSubagentBlock).mock.results[0].value.info.description).toBe('Zeno (gpt-5.4-mini)');
      expect(updateSubagentBlock).toHaveBeenCalledWith(vi.mocked(createSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Patched utils.ts and verified imports.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'spawn-1', 'sync', /^Subagent task: Zeno \(gpt-5.4-mini\) - Status: completed/, 'Patched utils.ts and verified imports.');
    });

    it('updates current task-name agents from list_agents after global wait timeouts', async () => {
      const { createSubagentBlock, updateSubagentBlock } = mockedSubagents;
      const { updateToolCallResult } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();
      deps.getProviderId = () => 'codex';

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'spawn-current',
        name: TOOL_SPAWN_AGENT,
        input: { message: 'Review the provider integration.', task_name: 'provider_review' },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'spawn-current',
        content: '{"task_name":"provider_review"}',
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'wait-current',
        name: TOOL_WAIT_AGENT,
        input: { timeout_ms: 10_000 },
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'wait-current',
        content: '{"message":"Agents are still running.","timed_out":true}',
      }, msg);

      expect(msg.toolCalls?.find(tool => tool.id === 'spawn-current')?.subagent?.status).toBe('running');

      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'list-current',
        name: 'list_agents',
        input: {},
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'list-current',
        content: JSON.stringify({
          agents: [{
            agent_name: 'provider_review',
            agent_status: { completed: 'Provider integration is sound.' },
          }],
        }),
      }, msg);

      expect(updateSubagentBlock).toHaveBeenCalledWith(vi.mocked(createSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Provider integration is sound.', status: 'completed' }));
      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('list-current'),
        expect.objectContaining({
          name: 'list_agents',
          status: 'completed',
        }),
      );
      renderedSubagent(deps.state.currentContentEl!, 'spawn-current', 'sync', /^Subagent task: provider_review - Status: completed/, 'Provider integration is sound.');
    });

    it('does not infer list_agents status from nested agent result prose', async () => {
      const msg = createTestMessage();
      deps.getProviderId = () => 'codex';
      msg.toolCalls = [{
        id: 'list-current',
        input: {},
        name: 'list_agents',
        status: 'running',
      }];

      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'list-current',
        content: JSON.stringify({
          agents: [{
            agent_name: '/root/reviewer',
            agent_status: {
              completed: 'The approval-denied path is handled correctly.',
            },
          }],
        }),
      }, msg);

      expect(msg.toolCalls[0].status).toBe('completed');
    });
  });

  describe('Grok subagent lifecycle', () => {
    beforeEach(() => {


      deps.getProviderId = () => 'grok';
    });

    it('converts a pending generic tool into one background subagent block', async () => {
      const {
        createAsyncSubagentBlock,
        updateAsyncSubagentBlock,
      } = mockedSubagents;


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
        providerPayload: {
          rawName: 'get_command_or_subagent_output',
          rawOutput: {
            Result: [{ output: 'Inspection complete.', status: 'completed', task_id: 'task-late' }],
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
      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'late-spawn', 'async', /^Background task: Inspect tools - Completed/, 'Inspection complete.');
    });

    it('keeps a reclassified pending spawn before later pending tools', async () => {
      const { renderToolCall } = mockedTools;
      const { createAsyncSubagentBlock } = mockedSubagents;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
      expect(parentEl.children[0]).toBe(vi.mocked(createAsyncSubagentBlock).mock.results[0].value.wrapperEl);
      expect(parentEl.children[1]).toBe(vi.mocked(renderToolCall).mock.results[0].value);
      expect(msg.contentBlocks).toEqual([
        { type: 'tool_use', toolId: 'ordered-spawn' },
        { type: 'tool_use', toolId: 'later-tool' },
      ]);
      renderedSubagent(deps.state.currentContentEl!, 'ordered-spawn', 'async', /^Background task: Inspect tools/);
    });

    it('replaces an already-rendered generic tool at the same DOM position', async () => {
      const { renderToolCall } = mockedTools;
      const { createAsyncSubagentBlock } = mockedSubagents;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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

      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(Array.from(parentEl.children)).toEqual([vi.mocked(createAsyncSubagentBlock).mock.results[0].value.wrapperEl, textEl]);
      expect(deps.state.toolCallElements.has('rendered-spawn')).toBe(false);
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
      renderedSubagent(deps.state.currentContentEl!, 'rendered-spawn', 'async', /^Background task: Inspect tools/);
    });

    it('replaces a provisional sync subagent when refined input makes it background', async () => {
      const {
        createAsyncSubagentBlock,
        createSubagentBlock,
        } = mockedSubagents;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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

      expect(vi.mocked(createSubagentBlock).mock.results[0].value.wrapperEl.isConnected).toBe(false);
      expect(Array.from(parentEl.children)).toEqual([vi.mocked(createAsyncSubagentBlock).mock.results[0].value.wrapperEl]);
      expect(createSubagentBlock).toHaveBeenCalledTimes(1);
      expect(createAsyncSubagentBlock).toHaveBeenCalledTimes(1);
      expect(createAsyncSubagentBlock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: 'task-refined-mode' }));
      renderedSubagent(deps.state.currentContentEl!, 'refined-mode-spawn', 'async', /^Background task: Inspect tools/);
    });

    it('finalizes a generic tool that is reclassified as a completed sync spawn', async () => {
      const {
        createSubagentBlock,
      } = mockedSubagents;


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

      expect(createSubagentBlock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'terminal-spawn', 'sync', /^Subagent task: Inspect tools - Status: completed/, 'Inspection complete.');
    });

    it('removes a rendered wait card after a late spawn binding links it', async () => {
      const { renderToolCall } = mockedTools;
      const {
        createAsyncSubagentBlock,
        updateAsyncSubagentBlock,
      } = mockedSubagents;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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
      }, msg);

      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.has('early-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'early-wait' });
      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'late-binding-spawn', 'async', /^Background task: Inspect tools - Completed/, 'Inspection complete.');
    });

    it('removes a rendered generic card when refined wait input links it', async () => {
      const { renderToolCall } = mockedTools;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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

      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.has('refined-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'refined-wait' });
      renderedSubagent(deps.state.currentContentEl!, 'refined-wait-spawn', 'async', /^Background task: Inspect tools/);
    });

    it('replays a terminal generic result when the call is reclassified as output', async () => {
      const { createAsyncSubagentBlock, updateAsyncSubagentBlock } = mockedSubagents;


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
      }, msg);
      await controller.handleStreamChunk({
        type: 'tool_use',
        id: 'terminal-output',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-terminal-output'] },
      }, msg);

      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'terminal-output-spawn', 'async', /^Background task: Inspect tools - Completed/, 'Inspection complete.');
    });

    it('removes a rendered output card when late raw output identifies its subagent', async () => {
      const { renderToolCall } = mockedTools;
      const { updateAsyncSubagentBlock } = mockedSubagents;
      const parentEl = document.body.createDiv();
      deps.state.currentContentEl = parentEl;

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

      expect(vi.mocked(renderToolCall).mock.results[0].value.isConnected).toBe(false);
      expect(deps.state.toolCallElements.has('raw-output-wait')).toBe(false);
      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'raw-output-wait' });

      await controller.handleStreamChunk({
        type: 'tool_result',
        id: 'raw-output-wait',
        content: 'Inspection complete.',
      }, msg);

      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(expect.objectContaining({ info: expect.objectContaining({ id: 'raw-output-spawn' }) }), expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'raw-output-spawn', 'async', /^Background task: Inspect tools - Completed/, 'Inspection complete.');
    });

    it('restores a hidden output card when later evidence reveals a command target', async () => {
      const { renderToolCall } = mockedTools;
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
        expect.objectContaining({ initiallyExpanded: false }),
      );
      renderedTool(deps.state.currentContentEl!, 'mixed-late-output', /^get_command_or_subagent_output/);
      expect(within(deps.state.currentContentEl!).getByRole('button', { name: /^Background task: Inspect tools/ })).toBeDefined();
    });

    it('keeps a mixed command and subagent output card while completing the subagent', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
      const {
        createAsyncSubagentBlock,
        updateAsyncSubagentBlock,
      } = mockedSubagents;

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
        providerPayload: {
          rawName: 'get_command_or_subagent_output',
          rawOutput: {
            Result: [
              { output: 'Inspection complete.', status: 'completed', task_id: 'task-mixed' },
              { output: 'Command complete.', status: 'completed', task_id: 'command-mixed' },
            ],
          },
        },
      }, msg);

      expect(msg.contentBlocks).toContainEqual({ type: 'tool_use', toolId: 'mixed-output' });
      expect(renderToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'mixed-output' }),
        expect.objectContaining({ initiallyExpanded: false }),
      );
      expect(updateToolCallResult).toHaveBeenCalledWith(
        deps.state.toolCallElements.get('mixed-output'),
        expect.objectContaining({ result: 'Subagent and command finished.' }),
      );
      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Inspection complete.', status: 'completed' }));
      const card = renderedTool(deps.state.currentContentEl!, 'mixed-output', /^get_command_or_subagent_output/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('Subagent and command finished.')).toBeDefined();
      const child = deps.state.currentContentEl!.querySelector<HTMLElement>('[data-async-subagent-id="mixed-spawn"]')!;
      expect(within(child).getByRole('button', { name: /^Background task: Inspect tools - Completed/ })).toBeDefined();
      expect(within(child).getByText('Inspection complete.')).toBeDefined();
    });

    it('updates one background block across refined spawn input and output completion', async () => {
      const {
        createAsyncSubagentBlock,
        updateAsyncSubagentBlock,
        } = mockedSubagents;


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
        providerPayload: {
          rawInput: { run_in_background: true, task_id: 'task-7' },
          rawName: 'spawn_subagent',
          rawOutput: { text: 'Spawned task-7', type: 'text' },
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
        providerPayload: {
          rawName: 'get_command_or_subagent_output',
          rawOutput: {
            Result: [{ output: 'Renderer mappings verified.', status: 'completed', task_id: 'task-7' }],
            type: 'task_output',
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
      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ agentId: 'task-7' }));
      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Renderer mappings verified.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'spawn-1', 'async', /^Background task: Inspect tools - Completed/, 'Renderer mappings verified.');
    });

    it('finalizes a foreground spawn directly from its terminal result', async () => {
      const { createSubagentBlock, updateSubagentBlock } = mockedSubagents;


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
        providerPayload: {
          rawName: 'spawn_subagent',
          rawOutput: { text: 'No material findings.', type: 'text' },
        },
      }, msg);

      expect(updateSubagentBlock).toHaveBeenCalledWith(vi.mocked(createSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'No material findings.', status: 'completed' }));
      renderedSubagent(deps.state.currentContentEl!, 'spawn-2', 'sync', /^Subagent task: Review code - Status: completed/, 'No material findings.');
    });

    it('finalizes a killed background task as an error', async () => {
      const { createAsyncSubagentBlock, updateAsyncSubagentBlock } = mockedSubagents;


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

      expect(updateAsyncSubagentBlock).toHaveBeenCalledWith(vi.mocked(createAsyncSubagentBlock).mock.results[0].value, expect.objectContaining({ result: 'Task task-3 cancelled', status: 'error' }));
      renderedSubagent(deps.state.currentContentEl!, 'spawn-3', 'async', /^Background task: Wait - Error/, 'Task task-3 cancelled');
    });

    it('keeps the shared output tool visible for a background command', async () => {
      const { renderToolCall, updateToolCallResult } = mockedTools;
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
      const card = renderedTool(deps.state.currentContentEl!, 'output-command', /^get_command_or_subagent_output/);
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('Command finished.')).toBeDefined();
    });
  });

  describe('Async task tool result', () => {
    it('tool_result for a pending async task returns true from handleAsyncTaskToolResult', async () => {
      const { updateToolCallResult } = mockedTools;
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();

      await controller.handleStreamChunk({ type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { description: 'Background work', run_in_background: true } }, msg);
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
      expect(msg.toolCalls?.[0].subagent).toMatchObject({ id: 'task-1', mode: 'async' });
    });

    it('passes the provider payload through to async Task result handler', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = document.body.createDiv();


      const structured = { rawOutput: { data: { agent_id: 'agent-from-structured' } } };
      await controller.handleStreamChunk({ type: 'tool_use', id: 'task-1', name: TOOL_SUBAGENT, input: { description: 'Background work', run_in_background: true } }, msg);
      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'task-1', content: 'Task started', providerPayload: structured },
        msg
      );

      expect(msg.toolCalls?.[0].subagent?.agentId).toBe('agent-from-structured');
      expect(deps.subagentManager.handleTaskToolResult).toHaveBeenCalledWith(
        'task-1',
        'Task started',
        undefined,
        structured
      );
    });

    it('normalizes structured tool_result content before storing it on tool calls', async () => {
      const { updateToolCallResult } = mockedTools;
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

  describe('appendThinking - no currentContentEl', () => {
    it('should not create thinking state when currentContentEl is null', async () => {
      const msg = createTestMessage();
      deps.state.currentContentEl = null;

      await controller.handleStreamChunk({ type: 'thinking', content: 'test thinking' }, msg);

      // No thinking DOM should be created
      expect(deps.state.currentThinkingState).toBeNull();
    });
  });

});

describe('StreamController - Tool completion', () => {
  let controller: StreamController;
  let deps: MockStreamControllerDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    observeRendering();
    deps = await createMockDeps();
    vi.useFakeTimers();
    controller = new StreamController(deps);
    deps.state.currentContentEl = document.body.createDiv();
  });

  afterEach(() => {
    deps.state.clearThinkingIndicatorTimeout();
    deps.state.clearFlavorTimerInterval();
    controller.dispose();
    realRenderers.splice(0).forEach(renderer => renderer.dispose());
    components.splice(0).forEach(component => component.unload());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('tool completion outcomes', () => {
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
        providerPayload: {
          rawInput,
          rawName: 'future_tool',
          rawOutput,
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

    it('should not infer AskUserQuestion status from result text', async () => {
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

    it('should not infer ExitPlanMode status from result text', async () => {
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

    it('should complete a successful Read whose file content discusses approval', async () => {
      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'read-1',
        name: 'Read',
        input: { file_path: 'repro-a.md' },
        status: 'running',
      }];

      await controller.handleStreamChunk(
        { type: 'tool_result', id: 'read-1', content: 'wait for explicit approval' },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('completed');
    });

    it('should mark a tool as blocked only when the provider reports that outcome', async () => {
      const msg = createTestMessage();
      msg.toolCalls = [{
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'rm -rf /' },
        status: 'running',
      }];

      await controller.handleStreamChunk(
        {
          type: 'tool_result',
          id: 'bash-1',
          content: 'The tool was not run.',
          isBlocked: true,
        },
        msg
      );

      expect(msg.toolCalls![0].status).toBe('blocked');
    });
  });
});
