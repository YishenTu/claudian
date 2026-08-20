import { TFile } from 'obsidian';

import type {
  ProviderBackgroundOutputEvent,
  ProviderExecutionEvent,
} from '../../../core/execution';
import { resolveConversationModel } from '../../../core/providers/conversationModel';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderId,
  type ProviderSubagentAdapter,
  type ProviderSubagentLifecycleAdapter,
} from '../../../core/providers/types';
import { parseTodoInput } from '../../../core/tools/todo';
import { extractResolvedAnswers, extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import {
  isEditTool,
  isWriteEditTool,
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_SUBAGENT,
  TOOL_TODO_WRITE,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import {
  extractToolProviderPayload,
  normalizeToolProviderPayload,
} from '../../../core/tools/toolProviderPayload';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type {
  ChatMessage,
  StreamChunk,
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import type { SDKToolUseResult } from '../../../core/types/diff';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { formatDurationMmSs } from '../../../utils/date';
import { extractDiffData } from '../../../utils/diff';
import { hasStreamingMathDelimiters } from '../../../utils/markdownMath';
import { getVaultPath, normalizePathForVault } from '../../../utils/path';
import type { FeatureHost } from '../../FeatureHost';
import { FLAVOR_TEXTS } from '../constants';
import type { MessageRenderer, RenderContentOptions } from '../rendering/MessageRenderer';
import { resolveSubagentAdapter } from '../rendering/subagentAdapterResolution';
import {
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  createSubagentBlock,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  type SubagentState,
  updateAsyncSubagentRunning,
} from '../rendering/SubagentRenderer';
import {
  createThinkingBlock,
  finalizeThinkingBlock,
  type ThinkingBlockState,
} from '../rendering/ThinkingBlockRenderer';
import {
  getToolName,
  getToolSummary,
  renderToolCall,
  updateToolCallResult,
} from '../rendering/ToolCallRenderer';
import {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  updateWriteEditWithDiff,
} from '../rendering/WriteEditRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { AsyncSubagentCompletion } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { FileContextManager } from '../ui/FileContext';
import { StreamingRenderCoordinator } from './StreamingRenderCoordinator';

export interface StreamControllerDeps {
  plugin: FeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getMessagesEl: () => HTMLElement;
  getFileContextManager: () => FileContextManager | null;
  updateQueueIndicator: () => void;
  getProviderId?: () => ProviderId;
  getProviderSessionId?: () => string | null;
  loadSubagentToolCalls?: (
    request: SubagentHistoryRecoveryRequest,
  ) => Promise<ToolCallInfo[] | undefined>;
  loadSubagentFinalResult?: (
    request: SubagentHistoryRecoveryRequest,
  ) => Promise<string | null | undefined>;
  enqueueBackgroundWork?: (work: () => Promise<void>) => Promise<void> | null;
  persistConversation?: () => Promise<void>;
}

export interface SubagentHistoryRecoveryRequest {
  readonly providerId: ProviderId;
  readonly providerSessionId: string;
  readonly subagentId: string;
}

interface StreamingContentSnapshot {
  el: HTMLElement;
  content: string;
  options?: RenderContentOptions;
}

const STREAMING_RENDER_MIN_INTERVAL_MS = 150;

export class StreamController {
  private static readonly ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS = [
    200,
    600,
    1500,
  ] as const;

  private deps: StreamControllerDeps;
  private readonly textRenderCoordinator: StreamingRenderCoordinator<StreamingContentSnapshot>;
  private readonly thinkingRenderCoordinator: StreamingRenderCoordinator<StreamingContentSnapshot>;
  private tabActive = true;
  private viewportVisible = true;
  private pendingToolOutputFrames = new Map<string, ScheduledAnimationFrame>();
  private pendingScrollFrame: ScheduledAnimationFrame | null = null;

  // Provider lifecycle agent tracking (spawn → wait/close lifecycle)
  private lifecycleSubagentStates = new Map<string, SubagentState | AsyncSubagentState>(); // spawn callId → rendered state
  private lifecycleAgentIdToSpawnId = new Map<string, string>();      // agentId → spawn callId

  constructor(deps: StreamControllerDeps) {
    this.deps = deps;
    this.textRenderCoordinator = this.createRenderCoordinator(
      () => this.getStreamingRenderWindow()
    );
    this.thinkingRenderCoordinator = this.createRenderCoordinator(
      () => this.getThinkingRenderWindow()
    );
  }

  private createRenderCoordinator(
    getOwnerWindow: () => Window | null
  ): StreamingRenderCoordinator<StreamingContentSnapshot> {
    return new StreamingRenderCoordinator({
      getOwnerWindow,
      minIntervalMs: STREAMING_RENDER_MIN_INTERVAL_MS,
      render: async ({ el, content, options }) => {
        if (options) {
          await this.deps.renderer.renderContent(el, content, options);
        } else {
          await this.deps.renderer.renderContent(el, content);
        }
        this.scrollToBottom();
      },
    });
  }

  private createStreamingSnapshot(
    el: HTMLElement,
    content: string
  ): StreamingContentSnapshot {
    const options = this.getStreamingRenderOptions(content);
    return options ? { el, content, options } : { el, content };
  }

  private getActiveProviderId(): ProviderId {
    return this.deps.getProviderId?.() ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  private getSubagentAdapter(toolName?: string): ProviderSubagentAdapter | null {
    return resolveSubagentAdapter(this.getActiveProviderId(), toolName);
  }

  private normalizeToolResultContent(content: unknown): string {
    return extractToolResultContent(content, { fallbackIndent: 2 });
  }

  // ============================================
  // Stream Chunk Handling
  // ============================================

  async handleStreamChunk(chunk: StreamChunk, msg: ChatMessage): Promise<void> {
    const { state } = this.deps;

    switch (chunk.type) {
      case 'thinking':
        // Flush pending tools before rendering new content type
        this.flushPendingTools();
        if (state.currentTextEl) {
          await this.finalizeCurrentTextBlock(msg);
        }
        await this.appendThinking(chunk.content);
        break;

      case 'text':
        // Flush pending tools before rendering new content type
        this.flushPendingTools();
        if (state.currentThinkingState) {
          await this.finalizeCurrentThinkingBlock(msg);
        }
        msg.content += chunk.content;
        await this.appendText(chunk.content);
        break;

      case 'citations': {
        this.flushPendingTools();
        if (state.currentThinkingState) {
          await this.finalizeCurrentThinkingBlock(msg);
        }
        await this.finalizeCurrentTextBlock(msg);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'citations', citations: chunk.citations });
        if (state.currentContentEl) {
          this.deps.renderer.renderCitationGroup(state.currentContentEl, chunk.citations);
        }
        break;
      }

      case 'tool_use': {
        if (state.currentThinkingState) {
          await this.finalizeCurrentThinkingBlock(msg);
        }
        await this.finalizeCurrentTextBlock(msg);

        const subagentAdapter = this.getSubagentAdapter(chunk.name);
        if (subagentAdapter?.protocol === 'managed-agent') {
          if (subagentAdapter.isSpawnTool(chunk.name)) {
            this.flushPendingTools();
            this.handleTaskToolUseViaManager(chunk, msg);
          } else if (subagentAdapter.isOutputTool(chunk.name)) {
            this.handleAgentOutputToolUse(chunk, msg);
          }
          break;
        }
        if (subagentAdapter?.protocol === 'lifecycle') {
          if (subagentAdapter.isSpawnTool(chunk.name)) {
            this.handleProviderSubagentSpawn(chunk, msg, subagentAdapter);
            break;
          }
          if (
            subagentAdapter.isHiddenTool(chunk.name)
            && this.isFullyOwnedProviderSubagentTool(chunk, subagentAdapter)
          ) {
            this.handleProviderHiddenSubagentTool(chunk, msg);
            break;
          }
        }

        this.handleRegularToolUse(chunk, msg);
        break;
      }

      case 'tool_result': {
        await this.handleToolResult(chunk, msg);
        break;
      }

      case 'subagent_tool_use':
      case 'subagent_tool_result':
        await this.handleSubagentChunk(chunk, msg);
        break;

      case 'tool_output':
        this.handleToolOutput(chunk, msg);
        break;

      case 'notice':
        this.flushPendingTools();
        await this.appendText(`\n\n⚠️ **${chunk.level === 'warning' ? 'Blocked' : 'Notice'}:** ${chunk.content}`);
        break;

      case 'error':
        // Flush pending tools before rendering error message
        this.flushPendingTools();
        await this.appendText(`\n\n❌ **Error:** ${chunk.content}`);
        break;

      case 'done':
        // Flush any remaining pending tools
        this.flushPendingTools();
        break;

      case 'context_compacted': {
        this.flushPendingTools();
        if (state.currentThinkingState) {
          await this.finalizeCurrentThinkingBlock(msg);
        }
        await this.finalizeCurrentTextBlock(msg);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'context_compacted' });
        this.renderCompactBoundary();
        break;
      }

      case 'usage': {
        // Skip usage updates from other sessions or when flagged (during session reset)
        const currentSessionId = this.deps.getProviderSessionId?.() ?? null;
        const chunkSessionId = chunk.sessionId ?? null;
        if (
          (chunkSessionId && currentSessionId && chunkSessionId !== currentSessionId) ||
          (chunkSessionId && !currentSessionId)
        ) {
          break;
        }
        // Skip usage updates when subagents ran (SDK reports cumulative usage including subagents)
        if (this.deps.subagentManager.subagentsSpawnedThisStream > 0) {
          break;
        }
        if (!state.ignoreUsageUpdates) {
          const activeModel = this.getActiveProviderModel();
          state.usage = activeModel && !chunk.usage.model
            ? { ...chunk.usage, model: activeModel }
            : chunk.usage;
        }
        break;
      }

      default:
        break;
    }

    this.scrollToBottom();
  }

  // ============================================
  // Tool Use Handling
  // ============================================

  /**
   * Handles regular tool_use chunks by buffering them.
   * Tools are rendered when flushPendingTools is called (on next content type or tool_result).
   */
  private handleRegularToolUse(
    chunk: Extract<StreamChunk, { type: 'tool_use' }>,
    msg: ChatMessage
  ): void {
    const { state } = this.deps;

    // Check if this is an update to an existing tool call
    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (existingToolCall) {
      const refinedName = chunk.name.trim();
      const nameChanged = refinedName.length > 0 && refinedName !== existingToolCall.name;
      if (nameChanged) {
        existingToolCall.name = refinedName;
      }
      mergeToolProviderPayload(existingToolCall, chunk.providerPayload);
      const newInput = chunk.input || {};
      const inputChanged = Object.keys(newInput).length > 0;
      if (inputChanged) {
        existingToolCall.input = { ...existingToolCall.input, ...newInput };
      }

      if (nameChanged || inputChanged) {
        // Re-parse TodoWrite on input updates (streaming may complete the input)
        if (existingToolCall.name === TOOL_TODO_WRITE) {
          const todos = parseTodoInput(existingToolCall.input);
          if (todos) {
            this.deps.state.currentTodos = todos;
          }
        }

        // Capture plan file path on input updates (file_path may arrive in a later chunk)
        if (existingToolCall.name === TOOL_WRITE) {
          this.capturePlanFilePath(existingToolCall.input);
        }

        const rendererRebuilt = nameChanged
          && this.rebuildRenderedToolRenderer(existingToolCall);

        // If already rendered, update the header name + summary
        const toolEl = rendererRebuilt ? null : state.toolCallElements.get(chunk.id);
        if (toolEl) {
          const nameEl = toolEl.querySelector('.claudian-tool-name')
            ?? toolEl.querySelector('.claudian-write-edit-name');
          if (nameEl) {
            nameEl.setText(getToolName(existingToolCall.name, existingToolCall.input));
          }
          const summaryEl = toolEl.querySelector('.claudian-tool-summary')
            ?? toolEl.querySelector('.claudian-write-edit-summary');
          if (summaryEl) {
            summaryEl.setText(getToolSummary(existingToolCall.name, existingToolCall.input));
          }
        }
        // If still pending, the updated input is already in the toolCall object
      }
      this.ensureRegularToolCallVisibility(existingToolCall, msg);
      return;
    }

    // Create new tool call
    const providerPayload = normalizeToolProviderPayload(chunk.providerPayload);
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      ...(providerPayload ? { providerPayload } : {}),
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);

    // Add to contentBlocks for ordering
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });

    // TodoWrite: update panel state immediately (side effect), but still buffer render
    if (chunk.name === TOOL_TODO_WRITE) {
      const todos = parseTodoInput(chunk.input);
      if (todos) {
        this.deps.state.currentTodos = todos;
      }
    }

    // Track Write to provider plan directory for plan mode (used by approve-new-session)
    if (chunk.name === TOOL_WRITE) {
      this.capturePlanFilePath(chunk.input);
    }

    // Buffer the tool call instead of rendering immediately
    if (state.currentContentEl) {
      state.pendingTools.set(chunk.id, {
        toolCall,
        parentEl: state.currentContentEl,
      });
      this.showThinkingIndicator();
    }
  }

  private ensureRegularToolCallVisibility(toolCall: ToolCallInfo, msg: ChatMessage): void {
    msg.contentBlocks = msg.contentBlocks || [];
    if (!msg.contentBlocks.some(block => block.type === 'tool_use' && block.toolId === toolCall.id)) {
      msg.contentBlocks.push({ type: 'tool_use', toolId: toolCall.id });
    }

    const { state } = this.deps;
    if (state.pendingTools.has(toolCall.id) || state.toolCallElements.has(toolCall.id)) return;
    if (!state.currentContentEl) return;
    state.pendingTools.set(toolCall.id, {
      toolCall,
      parentEl: state.currentContentEl,
    });
    this.showThinkingIndicator();
  }

  private rebuildRenderedToolRenderer(toolCall: ToolCallInfo): boolean {
    const { state } = this.deps;
    const currentEl = state.toolCallElements.get(toolCall.id);
    if (!currentEl) return false;

    const needsWriteEditRenderer = isWriteEditTool(toolCall.name);

    const parentEl = currentEl.parentElement;
    if (!parentEl) return false;

    this.cancelPendingToolOutputRender(toolCall.id);
    const initiallyExpanded = toolCall.isExpanded === true;
    let replacementEl: HTMLElement;

    if (needsWriteEditRenderer) {
      const writeEditState = createWriteEditBlock(parentEl, toolCall, { initiallyExpanded });
      replacementEl = writeEditState.wrapperEl;
      state.writeEditStates.set(toolCall.id, writeEditState);
      state.toolCallElements.set(toolCall.id, replacementEl);

      if (toolCall.diffData) {
        updateWriteEditWithDiff(writeEditState, toolCall.diffData);
      }
      if (toolCall.status !== 'running') {
        finalizeWriteEditBlock(
          writeEditState,
          toolCall.status === 'error' || toolCall.status === 'blocked',
        );
      }
    } else {
      state.writeEditStates.delete(toolCall.id);
      replacementEl = renderToolCall(parentEl, toolCall, state.toolCallElements, {
        initiallyExpanded,
      });
      state.toolCallElements.set(toolCall.id, replacementEl);
      if (toolCall.result !== undefined || toolCall.status !== 'running') {
        updateToolCallResult(toolCall.id, toolCall, state.toolCallElements);
      }
    }

    parentEl.insertBefore(replacementEl, currentEl);
    currentEl.remove();
    return true;
  }

  private getActiveProviderModel(): string | undefined {
    const conversation = this.deps.state.currentConversationId
      ? this.deps.plugin.getConversationSync(this.deps.state.currentConversationId)
      : null;
    if (conversation) {
      return resolveConversationModel(
        this.deps.plugin.settings,
        conversation.providerId,
        conversation,
      ).model;
    }

    const providerId = this.getActiveProviderId();
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.deps.plugin.settings,
      providerId,
    );
    return typeof settings.model === 'string' ? settings.model : undefined;
  }

  private shouldDeferMathRendering(): boolean {
    return this.deps.plugin.settings.deferMathRenderingDuringStreaming !== false;
  }

  private shouldExpandFileEditsByDefault(): boolean {
    return this.deps.plugin.settings.expandFileEditsByDefault === true;
  }

  private getStreamingRenderOptions(content: string): RenderContentOptions | undefined {
    return this.shouldDeferMathRendering() && hasStreamingMathDelimiters(content)
      ? { deferMath: true }
      : undefined;
  }

  private capturePlanFilePath(input: Record<string, unknown>): void {
    const filePath = input.file_path as string | undefined;
    if (!filePath) return;

    const planPathPrefix = ProviderRegistry.getCapabilities(
      this.getActiveProviderId(),
    ).planPathPrefix;
    if (planPathPrefix && filePath.replace(/\\/g, '/').includes(planPathPrefix)) {
      this.deps.state.planFilePath = filePath;
    }
  }

  /**
   * Flushes all pending tool calls by rendering them.
   * Called when a different content type arrives or stream ends.
   */
  private flushPendingTools(): void {
    const { state } = this.deps;

    if (state.pendingTools.size === 0) {
      return;
    }

    // Render pending tools in order (Map preserves insertion order)
    for (const toolId of state.pendingTools.keys()) {
      this.renderPendingTool(toolId);
    }

    state.pendingTools.clear();
  }

  private flushPendingToolsBefore(toolId: string): void {
    const { state } = this.deps;
    for (const pendingToolId of [...state.pendingTools.keys()]) {
      if (pendingToolId === toolId) return;
      this.renderPendingTool(pendingToolId);
    }
  }

  /**
   * Renders a single pending tool call and moves it from pending to rendered state.
   */
  private renderPendingTool(toolId: string): void {
    const { state } = this.deps;
    const pending = state.pendingTools.get(toolId);
    if (!pending) return;

    const { toolCall, parentEl } = pending;
    if (!parentEl) return;
    if (isWriteEditTool(toolCall.name)) {
      const writeEditState = createWriteEditBlock(parentEl, toolCall, {
        initiallyExpanded: this.shouldExpandFileEditsByDefault(),
      });
      state.writeEditStates.set(toolId, writeEditState);
      state.toolCallElements.set(toolId, writeEditState.wrapperEl);
    } else {
      renderToolCall(parentEl, toolCall, state.toolCallElements, {
        initiallyExpanded: toolCall.name === TOOL_APPLY_PATCH && this.shouldExpandFileEditsByDefault(),
      });
    }
    state.pendingTools.delete(toolId);
  }

  private handleToolOutput(
    chunk: { type: 'tool_output'; id: string; content: string },
    msg: ChatMessage,
  ): void {
    const { state } = this.deps;

    if (state.pendingTools.has(chunk.id)) {
      this.renderPendingTool(chunk.id);
    }

    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existingToolCall) {
      return;
    }

    existingToolCall.result = (existingToolCall.result ?? '') + chunk.content;
    this.scheduleToolOutputRender(chunk.id, existingToolCall);
    this.showThinkingIndicator();
  }

  // ============================================
  // Provider lifecycle subagents (spawn → wait/close)
  // ============================================

  private handleProviderSubagentSpawn(
    chunk: Extract<StreamChunk, { type: 'tool_use' }>,
    msg: ChatMessage,
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const existingToolCall = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
    if (existingToolCall) {
      existingToolCall.name = chunk.name.trim() || existingToolCall.name;
      existingToolCall.input = { ...existingToolCall.input, ...chunk.input };
      mergeToolProviderPayload(existingToolCall, chunk.providerPayload);
      const subagentInfo = adapter.buildSubagentInfo(existingToolCall, msg.toolCalls ?? []);
      existingToolCall.subagent = subagentInfo;
      this.ensureProviderSubagentState(chunk.id, subagentInfo);
      this.bindProviderSubagentId(chunk.id, subagentInfo.agentId, msg, adapter);
      return;
    }

    const providerPayload = normalizeToolProviderPayload(chunk.providerPayload);
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      ...(providerPayload ? { providerPayload } : {}),
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });

    const subagentInfo = adapter.buildSubagentInfo(toolCall, msg.toolCalls);
    toolCall.subagent = subagentInfo;
    this.ensureProviderSubagentState(chunk.id, subagentInfo);
    this.bindProviderSubagentId(chunk.id, subagentInfo.agentId, msg, adapter);
  }

  private ensureProviderSubagentState(
    spawnId: string,
    subagentInfo: SubagentInfo,
  ): void {
    const existingSubagentState = this.lifecycleSubagentStates.get(spawnId);
    const existingMode = existingSubagentState?.info.mode ?? 'sync';
    const nextMode = subagentInfo.mode ?? 'sync';
    if (existingSubagentState && existingMode === nextMode) {
      this.updateProviderSubagentState(spawnId, subagentInfo);
      return;
    }

    const { state } = this.deps;
    const regularToolEl = state.toolCallElements.get(spawnId);
    const previousEl = existingSubagentState?.wrapperEl ?? regularToolEl;
    const pendingSpawn = state.pendingTools.get(spawnId);
    const parentEl = previousEl?.parentElement
      ?? pendingSpawn?.parentEl
      ?? state.currentContentEl;
    if (!parentEl) return;

    this.cancelPendingToolOutputRender(spawnId);
    if (pendingSpawn) {
      this.flushPendingToolsBefore(spawnId);
      state.pendingTools.delete(spawnId);
    } else if (!previousEl) {
      this.flushPendingTools();
    }
    state.writeEditStates.delete(spawnId);
    state.toolCallElements.delete(spawnId);

    const subagentState = subagentInfo.mode === 'async'
      ? createAsyncSubagentBlock(parentEl, spawnId, {
        description: subagentInfo.description,
        prompt: subagentInfo.prompt,
      })
      : createSubagentBlock(parentEl, spawnId, {
        description: subagentInfo.description,
        prompt: subagentInfo.prompt,
      });
    if (previousEl?.parentElement === parentEl) {
      parentEl.insertBefore(subagentState.wrapperEl, previousEl);
    }
    previousEl?.remove();

    this.lifecycleSubagentStates.set(spawnId, subagentState);
    this.updateProviderSubagentState(spawnId, subagentInfo);
    if (subagentInfo.status === 'completed' || subagentInfo.status === 'error') {
      this.finalizeProviderSubagentState(
        spawnId,
        subagentInfo.result || (subagentInfo.status === 'error' ? 'Error' : 'DONE'),
        subagentInfo.status === 'error',
      );
    }
  }

  private handleProviderHiddenSubagentTool(
    chunk: Extract<StreamChunk, { type: 'tool_use' }>,
    msg: ChatMessage
  ): void {
    const existingToolCall = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
    if (existingToolCall) {
      existingToolCall.name = chunk.name.trim() || existingToolCall.name;
      existingToolCall.input = { ...existingToolCall.input, ...chunk.input };
      mergeToolProviderPayload(existingToolCall, chunk.providerPayload);
      this.removeProviderSubagentToolCard(chunk.id);
      if (existingToolCall.status !== 'running' && existingToolCall.result !== undefined) {
        this.handleProviderSubagentResult({
          type: 'tool_result',
          id: existingToolCall.id,
          content: existingToolCall.result,
          isError: existingToolCall.status === 'error' || existingToolCall.status === 'blocked',
        }, msg);
      }
      return;
    }

    // Track in toolCalls for data completeness, but don't create DOM or content block
    const providerPayload = normalizeToolProviderPayload(chunk.providerPayload);
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      ...(providerPayload ? { providerPayload } : {}),
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });
  }

  private isFullyOwnedProviderSubagentTool(
    chunk: Extract<StreamChunk, { type: 'tool_use' }>,
    adapter: ProviderSubagentLifecycleAdapter,
  ): boolean {
    const providerPayload = normalizeToolProviderPayload(chunk.providerPayload);
    const candidate: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      ...(providerPayload ? { providerPayload } : {}),
      status: 'running',
      isExpanded: false,
    };
    return adapter.isToolCallFullyOwned(candidate, this.lifecycleAgentIdToSpawnId);
  }

  /**
   * Handles tool_result for provider lifecycle subagent tools.
   * Returns true if the result was consumed (caller should return early).
   */
  private handleProviderSubagentResult(
    chunk: Extract<StreamChunk, { type: 'tool_result' }>,
    msg: ChatMessage
  ): boolean {
    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existingToolCall) return false;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);

    const adapter = this.getSubagentAdapter(existingToolCall.name);
    if (!adapter || adapter.protocol !== 'lifecycle') return false;
    const resolvedToolCall: ToolCallInfo = {
      ...existingToolCall,
      result: normalizedContent,
      status: chunk.isError ? 'error' : 'completed',
    };
    const linkedSpawnIds = adapter.resolveSpawnToolIds(
      resolvedToolCall,
      this.lifecycleAgentIdToSpawnId,
    );
    const isFullyOwned = adapter.isToolCallFullyOwned(
      resolvedToolCall,
      this.lifecycleAgentIdToSpawnId,
    );
    if (adapter.isHiddenTool(existingToolCall.name) && isFullyOwned) {
      this.removeProviderSubagentToolCard(chunk.id);
    }
    if (
      adapter.isHiddenTool(existingToolCall.name)
      && linkedSpawnIds.length === 0
    ) {
      return false;
    }

    if (adapter.isSpawnTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;

      const spawnResult = adapter.extractSpawnResult(normalizedContent, existingToolCall);

      const subagentInfo = adapter.buildSubagentInfo(existingToolCall, msg.toolCalls ?? []);
      existingToolCall.subagent = subagentInfo;
      this.updateProviderSubagentState(chunk.id, subagentInfo);
      this.bindProviderSubagentId(
        chunk.id,
        spawnResult.agentId ?? subagentInfo.agentId,
        msg,
        adapter,
      );

      if (subagentInfo.status === 'completed' || subagentInfo.status === 'error') {
        this.finalizeProviderSubagentState(
          chunk.id,
          subagentInfo.result || (subagentInfo.status === 'error' ? 'Error' : 'DONE'),
          subagentInfo.status === 'error',
        );
      }
      return true;
    }

    if (adapter.isWaitTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;

      for (const spawnId of linkedSpawnIds) {
        const spawnToolCall = msg.toolCalls?.find(tc => tc.id === spawnId);
        const subagentState = this.lifecycleSubagentStates.get(spawnId);
        if (!spawnToolCall || !subagentState) continue;

        const subagentInfo = adapter.buildSubagentInfo(spawnToolCall, msg.toolCalls ?? []);
        spawnToolCall.subagent = subagentInfo;
        this.updateProviderSubagentState(spawnId, subagentInfo);

        if (subagentInfo.status === 'completed' || subagentInfo.status === 'error') {
          this.finalizeProviderSubagentState(
            spawnId,
            subagentInfo.result || (subagentInfo.status === 'error' ? 'Error' : 'DONE'),
            subagentInfo.status === 'error',
          );
        }
      }
      return adapter.isHiddenTool(existingToolCall.name) && isFullyOwned;
    }

    if (adapter.isCloseTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;
      for (const spawnId of linkedSpawnIds) {
        const spawnToolCall = msg.toolCalls?.find(toolCall => toolCall.id === spawnId);
        if (!spawnToolCall) continue;
        const subagentInfo = adapter.buildSubagentInfo(spawnToolCall, msg.toolCalls ?? []);
        spawnToolCall.subagent = subagentInfo;
        this.updateProviderSubagentState(spawnId, subagentInfo);
        this.finalizeProviderSubagentState(
          spawnId,
          subagentInfo.result || 'Task cancelled',
          true,
        );
      }
      return isFullyOwned;
    }

    return false;
  }

  private bindProviderSubagentId(
    spawnId: string,
    agentId: string | undefined,
    msg?: ChatMessage,
    adapter?: ProviderSubagentLifecycleAdapter,
  ): void {
    if (!agentId) return;
    const isNewBinding = this.lifecycleAgentIdToSpawnId.get(agentId) !== spawnId;
    this.lifecycleAgentIdToSpawnId.set(agentId, spawnId);
    const state = this.lifecycleSubagentStates.get(spawnId);
    if (state?.info.mode === 'async' && isNewBinding) {
      updateAsyncSubagentRunning(state as AsyncSubagentState, agentId);
    }
    if (isNewBinding && msg && adapter) {
      this.hideNewlyLinkedProviderSubagentTools(spawnId, msg, adapter);
    }
  }

  private hideNewlyLinkedProviderSubagentTools(
    spawnId: string,
    msg: ChatMessage,
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const hiddenToolIds = new Set(
      (msg.toolCalls ?? [])
        .filter(toolCall => (
          adapter.isHiddenTool(toolCall.name)
          && adapter.isToolCallFullyOwned(toolCall, this.lifecycleAgentIdToSpawnId)
          && adapter.resolveSpawnToolIds(toolCall, this.lifecycleAgentIdToSpawnId).includes(spawnId)
        ))
        .map(toolCall => toolCall.id),
    );
    if (hiddenToolIds.size === 0) return;

    for (const toolId of hiddenToolIds) {
      this.removeProviderSubagentToolCard(toolId);
    }
  }

  private removeProviderSubagentToolCard(toolId: string): void {
    this.removeToolCardRenderer(toolId);
  }

  private updateProviderSubagentState(spawnId: string, info: SubagentInfo): void {
    const state = this.lifecycleSubagentStates.get(spawnId);
    if (!state) return;
    Object.assign(state.info, info);
    state.labelEl.setText(
      info.description.length > 40
        ? info.description.substring(0, 40) + '...'
        : info.description,
    );
  }

  private finalizeProviderSubagentState(
    spawnId: string,
    result: string,
    isError: boolean,
  ): void {
    const state = this.lifecycleSubagentStates.get(spawnId);
    if (!state) return;
    if (state.info.mode === 'async') {
      finalizeAsyncSubagent(state as AsyncSubagentState, result, isError);
      return;
    }
    finalizeSubagentBlock(state as SubagentState, result, isError);
  }

  private async handleToolResult(
    chunk: {
      type: 'tool_result';
      id: string;
      content: string;
      isError?: boolean;
      isBlocked?: boolean;
      toolUseResult?: SDKToolUseResult;
    },
    msg: ChatMessage
  ): Promise<void> {
    const { state, subagentManager } = this.deps;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);

    const lifecycleToolCall = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
    const lifecycleAdapter = lifecycleToolCall
      ? this.getSubagentAdapter(lifecycleToolCall.name)
      : null;
    if (lifecycleToolCall && lifecycleAdapter?.protocol === 'lifecycle') {
      mergeToolProviderPayload(lifecycleToolCall, chunk.toolUseResult?.providerPayload);
    }

    // Resolve pending Task before processing result.
    if (subagentManager.hasPendingTask(chunk.id)) {
      this.renderPendingTaskFromTaskResultViaManager(chunk, msg);
    }

    // Check if it's a sync subagent result
    const subagentState = subagentManager.getSyncSubagent(chunk.id);
    if (subagentState) {
      this.finalizeSubagent(chunk, msg);
      return;
    }

    // Check if it's an async task result
    if (await this.handleAsyncTaskToolResult(chunk)) {
      this.showThinkingIndicator();
      return;
    }

    // Check if it's an agent output result
    if (await this.handleAgentOutputToolResult(chunk)) {
      this.showThinkingIndicator();
      return;
    }

    if (this.handleProviderSubagentResult(chunk, msg)) {
      this.showThinkingIndicator();
      return;
    }

    // Check if tool is still pending (buffered) - render it now before applying result
    if (state.pendingTools.has(chunk.id)) {
      this.renderPendingTool(chunk.id);
    }

    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);

    // Completion outcomes come from the provider boundary. Result content is
    // arbitrary user/tool data and must never be interpreted as status metadata.
    const isBlocked = chunk.isBlocked === true;

    if (existingToolCall) {
      const providerPayload = extractToolProviderPayload(chunk.toolUseResult);
      if (providerPayload) {
        existingToolCall.providerPayload = {
          ...existingToolCall.providerPayload,
          ...providerPayload,
        };
      }
      if (isBlocked) {
        existingToolCall.status = 'blocked';
      } else if (chunk.isError) {
        existingToolCall.status = 'error';
      } else {
        existingToolCall.status = 'completed';
      }
      existingToolCall.result = normalizedContent;

      if (existingToolCall.name === TOOL_ASK_USER_QUESTION) {
        const answers =
          extractResolvedAnswers(chunk.toolUseResult) ??
          extractResolvedAnswersFromResultText(normalizedContent);
        if (answers) existingToolCall.resolvedAnswers = answers;
      }

      const writeEditState = state.writeEditStates.get(chunk.id);
      if (writeEditState && isWriteEditTool(existingToolCall.name)) {
        if (!chunk.isError && !isBlocked) {
          const diffData = extractDiffData(chunk.toolUseResult, existingToolCall);
          if (diffData) {
            existingToolCall.diffData = diffData;
            updateWriteEditWithDiff(writeEditState, diffData);
          }
        }
        finalizeWriteEditBlock(writeEditState, chunk.isError || isBlocked);
      } else {
        this.cancelPendingToolOutputRender(chunk.id);
        updateToolCallResult(chunk.id, existingToolCall, state.toolCallElements);
      }

      // Notify Obsidian vault so the file tree refreshes after Write/Edit/NotebookEdit
      if (!chunk.isError && !isBlocked && isEditTool(existingToolCall.name)) {
        this.notifyVaultFileChange(existingToolCall.input);
      }

      // Runtime apply_patch: refresh each changed file path
      if (!chunk.isError && !isBlocked && existingToolCall.name === TOOL_APPLY_PATCH) {
        this.notifyApplyPatchFileChanges(existingToolCall.input);
      }
    }

    this.showThinkingIndicator();
  }

  // ============================================
  // Text Block Management
  // ============================================

  async appendText(text: string): Promise<void> {
    const { state } = this.deps;
    if (!state.currentContentEl) return;

    this.hideThinkingIndicator();

    if (!state.currentTextEl) {
      this.textRenderCoordinator.cancel();
      state.currentTextEl = state.currentContentEl.createDiv({ cls: 'claudian-text-block' });
      state.currentTextContent = '';
    }

    state.currentTextContent += text;
    this.textRenderCoordinator.request(
      this.createStreamingSnapshot(state.currentTextEl, state.currentTextContent)
    );
  }

  async finalizeCurrentTextBlock(msg?: ChatMessage): Promise<void> {
    const { state, renderer } = this.deps;
    const textEl = state.currentTextEl;
    const content = state.currentTextContent;

    if (
      textEl
      && this.shouldDeferMathRendering()
      && hasStreamingMathDelimiters(content)
    ) {
      this.textRenderCoordinator.request({ el: textEl, content });
    }
    await this.textRenderCoordinator.flush();

    if (msg && content) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'text', content });
      // Copy button added here (not during streaming) to match history-loaded messages
      if (textEl) {
        renderer.addTextCopyButton(textEl, content);
      }
    }
    this.textRenderCoordinator.cancel();
    state.currentTextEl = null;
    state.currentTextContent = '';
  }

  private scheduleToolOutputRender(toolId: string, toolCall: ToolCallInfo): void {
    if (this.pendingToolOutputFrames.has(toolId)) return;

    const frame = scheduleAnimationFrame(() => {
      this.pendingToolOutputFrames.delete(toolId);
      updateToolCallResult(toolId, toolCall, this.deps.state.toolCallElements);
      this.scrollToBottom();
    }, this.getMessagesWindow());
    this.pendingToolOutputFrames.set(toolId, frame);
  }

  private cancelPendingToolOutputRender(toolId: string): void {
    const frame = this.pendingToolOutputFrames.get(toolId);
    if (!frame) return;

    cancelScheduledAnimationFrame(frame);
    this.pendingToolOutputFrames.delete(toolId);
  }

  private cancelPendingToolOutputRenders(): void {
    for (const frame of this.pendingToolOutputFrames.values()) {
      cancelScheduledAnimationFrame(frame);
    }
    this.pendingToolOutputFrames.clear();
  }

  // ============================================
  // Thinking Block Management
  // ============================================

  async appendThinking(content: string): Promise<void> {
    const { state } = this.deps;
    if (!state.currentContentEl) return;

    this.hideThinkingIndicator();
    if (!state.currentThinkingState) {
      this.thinkingRenderCoordinator.cancel();
      const thinkingState = createThinkingBlock(state.currentContentEl, {
        onToggle: (isExpanded) => {
          this.handleThinkingToggle(thinkingState, isExpanded);
        },
      });
      state.currentThinkingState = thinkingState;
      this.syncThinkingRenderAvailability();
    }

    state.currentThinkingState.content += content;
    this.thinkingRenderCoordinator.request(
      this.createStreamingSnapshot(
        state.currentThinkingState.contentEl,
        state.currentThinkingState.content
      )
    );
  }

  async finalizeCurrentThinkingBlock(msg?: ChatMessage): Promise<void> {
    const { state } = this.deps;
    if (!state.currentThinkingState) return;

    const thinkingState = state.currentThinkingState;
    if (this.getStreamingRenderOptions(thinkingState.content)) {
      this.thinkingRenderCoordinator.request({
        el: thinkingState.contentEl,
        content: thinkingState.content,
      });
    }
    await this.thinkingRenderCoordinator.flush();

    const durationSeconds = finalizeThinkingBlock(thinkingState);

    if (msg && thinkingState.content) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({
        type: 'thinking',
        content: thinkingState.content,
        durationSeconds,
      });
    }

    state.currentThinkingState = null;
    this.thinkingRenderCoordinator.cancel();
  }

  private handleThinkingToggle(
    thinkingState: ThinkingBlockState,
    isExpanded: boolean
  ): void {
    if (this.deps.state.currentThinkingState !== thinkingState) return;

    thinkingState.isExpanded = isExpanded;
    this.syncThinkingRenderAvailability();
  }

  // ============================================
  // Subagent Tool Handling (via SubagentManager)
  // ============================================

  /** Delegates Agent tool_use to SubagentManager and updates message based on result. */
  private handleTaskToolUseViaManager(
    chunk: Extract<StreamChunk, { type: 'tool_use' }>,
    msg: ChatMessage
  ): void {
    const { state, subagentManager } = this.deps;
    this.ensureTaskToolCall(msg, chunk.id, chunk.input, chunk.providerPayload);

    const result = subagentManager.handleTaskToolUse(chunk.id, chunk.input, state.currentContentEl);

    switch (result.action) {
      case 'created_sync':
        this.recordSubagentInMessage(msg, result.subagentState.info, chunk.id);
        this.showThinkingIndicator();
        break;
      case 'created_async':
        this.recordSubagentInMessage(msg, result.info, chunk.id, 'async');
        this.showThinkingIndicator();
        break;
      case 'buffered':
        this.showThinkingIndicator();
        break;
      case 'label_updated':
        break;
    }
  }

  /** Renders a pending Agent tool call via SubagentManager and updates message. */
  private renderPendingTaskViaManager(toolId: string, msg: ChatMessage): void {
    const result = this.deps.subagentManager.renderPendingTask(toolId, this.deps.state.currentContentEl);
    if (!result) return;

    if (result.mode === 'sync') {
      this.recordSubagentInMessage(msg, result.subagentState.info, toolId);
    } else {
      this.recordSubagentInMessage(msg, result.info, toolId, 'async');
    }
  }

  /** Resolves a pending Agent tool call when its own tool_result arrives. */
  private renderPendingTaskFromTaskResultViaManager(
    chunk: { id: string; content: string; isError?: boolean; toolUseResult?: unknown },
    msg: ChatMessage
  ): void {
    const result = this.deps.subagentManager.renderPendingTaskFromTaskResult(
      chunk.id,
      chunk.content,
      chunk.isError || false,
      this.deps.state.currentContentEl,
      chunk.toolUseResult
    );
    if (!result) return;

    if (result.mode === 'sync') {
      this.recordSubagentInMessage(msg, result.subagentState.info, chunk.id);
    } else {
      this.recordSubagentInMessage(msg, result.info, chunk.id, 'async');
    }
  }

  private recordSubagentInMessage(
    msg: ChatMessage,
    info: SubagentInfo,
    toolId: string,
    mode?: 'async'
  ): void {
    const taskToolCall = this.ensureTaskToolCall(msg, toolId);
    this.applySubagentToTaskToolCall(taskToolCall, info);

    msg.contentBlocks = msg.contentBlocks || [];
    const existingBlockIndex = msg.contentBlocks.findIndex(
      block => block.type === 'subagent' && block.subagentId === toolId,
    );
    const toolBlockIndex = msg.contentBlocks.findIndex(
      block => block.type === 'tool_use' && block.toolId === toolId,
    );
    const subagentBlock = mode
      ? { type: 'subagent' as const, subagentId: toolId, mode }
      : { type: 'subagent' as const, subagentId: toolId };
    if (existingBlockIndex >= 0) {
      const existingBlock = msg.contentBlocks[existingBlockIndex];
      if (mode && existingBlock.type === 'subagent') {
        existingBlock.mode = mode;
      }
      if (toolBlockIndex >= 0 && toolBlockIndex !== existingBlockIndex) {
        msg.contentBlocks.splice(toolBlockIndex, 1);
      }
    } else if (toolBlockIndex >= 0) {
      msg.contentBlocks.splice(toolBlockIndex, 1, subagentBlock);
    } else {
      msg.contentBlocks.push(subagentBlock);
    }
  }

  private async handleSubagentChunk(
    chunk: Extract<StreamChunk, { type: 'subagent_tool_use' | 'subagent_tool_result' }>,
    msg: ChatMessage,
  ): Promise<void> {
    const parentToolUseId = chunk.subagentId;
    const { subagentManager } = this.deps;

    // If parent Agent call is still pending, child chunk confirms it's sync - render now
    if (subagentManager.hasPendingTask(parentToolUseId)) {
      this.renderPendingTaskViaManager(parentToolUseId, msg);
    }

    const subagentState = subagentManager.getSyncSubagent(parentToolUseId);

    if (!subagentState) {
      return;
    }

    switch (chunk.type) {
      case 'subagent_tool_use': {
        const toolCall: ToolCallInfo = {
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          status: 'running',
          isExpanded: false,
        };
        subagentManager.addSyncToolCall(parentToolUseId, toolCall);
        this.showThinkingIndicator();
        break;
      }

      case 'subagent_tool_result': {
        const toolCall = subagentState.info.toolCalls.find((tc: ToolCallInfo) => tc.id === chunk.id);
        if (toolCall) {
          const normalizedContent = this.normalizeToolResultContent(chunk.content);
          toolCall.status = chunk.isBlocked
            ? 'blocked'
            : (chunk.isError ? 'error' : 'completed');
          toolCall.result = normalizedContent;
          subagentManager.updateSyncToolResult(parentToolUseId, chunk.id, toolCall);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Finalizes a sync subagent when its Agent tool_result is received. */
  private finalizeSubagent(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown },
    msg: ChatMessage
  ): void {
    const isError = chunk.isError || false;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);
    const finalized = this.deps.subagentManager.finalizeSyncSubagent(
      chunk.id, chunk.content, isError, chunk.toolUseResult
    );

    const extractedResult = finalized?.result ?? normalizedContent;

    const taskToolCall = this.ensureTaskToolCall(msg, chunk.id);
    taskToolCall.status = isError ? 'error' : 'completed';
    taskToolCall.result = extractedResult;
    if (taskToolCall.subagent) {
      taskToolCall.subagent.status = isError ? 'error' : 'completed';
      taskToolCall.subagent.result = extractedResult;
    }

    if (finalized) {
      this.applySubagentToTaskToolCall(taskToolCall, finalized);
    }

    this.showThinkingIndicator();
  }

  // ============================================
  // Async Subagent Handling
  // ============================================

  /** Handles TaskOutput tool_use (invisible, links to async subagent). */
  private handleAgentOutputToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    _msg: ChatMessage
  ): void {
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };

    this.deps.subagentManager.handleAgentOutputToolUse(toolCall);

    // Show flavor text while waiting for TaskOutput result
    this.showThinkingIndicator();
  }

  private async handleAsyncTaskToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown }
  ): Promise<boolean> {
    const { subagentManager } = this.deps;
    if (
      !subagentManager.isPendingAsyncTask(chunk.id)
      && !subagentManager.getByTaskId(chunk.id)
    ) {
      return false;
    }

    subagentManager.handleTaskToolResult(chunk.id, chunk.content, chunk.isError, chunk.toolUseResult);
    await this.hydrateAsyncSubagentHistory(
      subagentManager.getByTaskId(chunk.id),
    );
    return true;
  }

  /** Handles TaskOutput result to finalize async subagent. */
  private async handleAgentOutputToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown }
  ): Promise<boolean> {
    const { subagentManager } = this.deps;
    const isLinked = subagentManager.isLinkedAgentOutputTool(chunk.id);

    const handled = subagentManager.handleAgentOutputToolResult(
      chunk.id,
      chunk.content,
      chunk.isError || false,
      chunk.toolUseResult
    );

    await this.hydrateAsyncSubagentHistory(handled);

    return isLinked || handled !== undefined;
  }

  public async handleAsyncSubagentCompletion(
    completion: AsyncSubagentCompletion,
  ): Promise<boolean> {
    const handled = this.deps.subagentManager.handleAsyncSubagentCompletion(completion);
    await this.hydrateAsyncSubagentHistory(
      handled,
      completion.providerSessionId,
    );
    if (handled) {
      this.showThinkingIndicator();
    }
    return handled !== undefined;
  }

  private async hydrateAsyncSubagentHistory(
    subagent: SubagentInfo | undefined,
    providerSessionId?: string,
  ): Promise<void> {
    if (!this.canRecoverAsyncSubagent(subagent)) return;
    if (
      !this.deps.loadSubagentToolCalls
      && !this.deps.loadSubagentFinalResult
    ) return;

    const providerId = this.getActiveProviderId();
    const ownerSessionId = providerSessionId
      ?? this.deps.getProviderSessionId?.()
      ?? null;
    if (
      !ownerSessionId
      || !this.ownsAsyncSubagent(
        subagent,
        providerId,
        ownerSessionId,
      )
    ) return;

    const result = await this.tryHydrateAsyncSubagent(
      subagent,
      providerId,
      ownerSessionId,
      true,
    );
    if (!result.isCurrent) return;
    if (result.hasHydrated) {
      this.deps.subagentManager.refreshAsyncSubagent(subagent);
    }
    if (!result.finalResultHydrated) {
      this.scheduleAsyncSubagentResultRetry(
        subagent,
        providerId,
        ownerSessionId,
        0,
      );
    }
  }

  private async tryHydrateAsyncSubagent(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    hydrateToolCalls: boolean,
  ): Promise<{
    finalResultHydrated: boolean;
    hasHydrated: boolean;
    isCurrent: boolean;
  }> {
    const request: SubagentHistoryRecoveryRequest = {
      providerId,
      providerSessionId,
      subagentId: subagent.agentId ?? '',
    };
    let hasHydrated = false;

    if (
      hydrateToolCalls
      && !subagent.toolCalls?.length
      && this.deps.loadSubagentToolCalls
    ) {
      const recoveredToolCalls = await this.deps.loadSubagentToolCalls(request);
      if (!this.ownsAsyncSubagent(subagent, providerId, providerSessionId)) {
        return {
          finalResultHydrated: false,
          hasHydrated: false,
          isCurrent: false,
        };
      }
      if (recoveredToolCalls === undefined) {
        return {
          finalResultHydrated: true,
          hasHydrated: false,
          isCurrent: true,
        };
      }
      if (recoveredToolCalls.length > 0) {
        subagent.toolCalls = recoveredToolCalls.map((toolCall) => ({
          ...toolCall,
          input: { ...toolCall.input },
        }));
        hasHydrated = true;
      }
    }

    if (!this.deps.loadSubagentFinalResult) {
      return { finalResultHydrated: true, hasHydrated, isCurrent: true };
    }
    const recoveredFinalResult = await this.deps.loadSubagentFinalResult(request);
    if (!this.ownsAsyncSubagent(subagent, providerId, providerSessionId)) {
      return {
        finalResultHydrated: false,
        hasHydrated: false,
        isCurrent: false,
      };
    }
    if (recoveredFinalResult === undefined) {
      return { finalResultHydrated: true, hasHydrated, isCurrent: true };
    }
    const finalResultHydrated = Boolean(recoveredFinalResult?.trim());
    if (finalResultHydrated && recoveredFinalResult !== subagent.result) {
      subagent.result = recoveredFinalResult ?? undefined;
      hasHydrated = true;
    }
    return { finalResultHydrated, hasHydrated, isCurrent: true };
  }

  private canRecoverAsyncSubagent(
    subagent: SubagentInfo | undefined,
  ): subagent is SubagentInfo & { agentId: string } {
    if (!subagent || subagent.mode !== 'async' || !subagent.agentId) return false;
    const status = subagent.asyncStatus ?? subagent.status;
    return status === 'completed' || status === 'error';
  }

  private ownsAsyncSubagent(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
  ): boolean {
    return this.getActiveProviderId() === providerId
      && this.deps.getProviderSessionId?.() === providerSessionId
      && this.deps.subagentManager.getByTaskId(subagent.id) === subagent;
  }

  private scheduleAsyncSubagentResultRetry(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    attempt: number,
  ): void {
    if (
      !subagent.agentId
      || attempt >= StreamController.ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS.length
    ) return;

    const delay = StreamController.ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS[attempt];
    const ownerWindow = this.deps.getMessagesEl().ownerDocument.defaultView
      ?? window;
    ownerWindow.setTimeout(() => {
      const work = () => this.retryAsyncSubagentResult(
        subagent,
        providerId,
        providerSessionId,
        attempt,
      );
      const pending = this.deps.enqueueBackgroundWork
        ? this.deps.enqueueBackgroundWork(work)
        : work();
      void pending?.catch(() => undefined);
    }, delay);
  }

  private async retryAsyncSubagentResult(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    attempt: number,
  ): Promise<void> {
    if (
      !this.canRecoverAsyncSubagent(subagent)
      || !this.ownsAsyncSubagent(subagent, providerId, providerSessionId)
    ) return;

    const result = await this.tryHydrateAsyncSubagent(
      subagent,
      providerId,
      providerSessionId,
      false,
    );
    if (!result.isCurrent) return;
    if (result.hasHydrated) {
      this.deps.subagentManager.refreshAsyncSubagent(subagent);
      await this.deps.persistConversation?.();
    }
    if (!result.finalResultHydrated) {
      this.scheduleAsyncSubagentResultRetry(
        subagent,
        providerId,
        providerSessionId,
        attempt + 1,
      );
    }
  }

  /** Callback from SubagentManager when async state changes. Updates messages only (DOM handled by manager). */
  onAsyncSubagentStateChange(subagent: SubagentInfo): void {
    this.updateSubagentInMessages(subagent);
    this.scrollToBottom();
  }

  private updateSubagentInMessages(subagent: SubagentInfo): void {
    const { state } = this.deps;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg.role !== 'assistant') continue;
      if (this.linkTaskToolCallToSubagent(msg, subagent)) {
        return;
      }
    }
  }

  private ensureTaskToolCall(
    msg: ChatMessage,
    toolId: string,
    input?: Record<string, unknown>,
    providerPayload?: unknown,
  ): ToolCallInfo {
    msg.toolCalls = msg.toolCalls || [];
    const existing = msg.toolCalls.find(tc => tc.id === toolId);
    if (existing) {
      if (input && Object.keys(input).length > 0) {
        existing.input = { ...existing.input, ...input };
      }
      mergeToolProviderPayload(existing, providerPayload);
      if (existing.name !== TOOL_SUBAGENT) {
        existing.name = TOOL_SUBAGENT;
        this.removeToolCardRenderer(toolId);
      }
      return existing;
    }

    const normalizedProviderPayload = normalizeToolProviderPayload(providerPayload);
    const taskToolCall: ToolCallInfo = {
      id: toolId,
      name: TOOL_SUBAGENT,
      input: input ? { ...input } : {},
      ...(normalizedProviderPayload ? { providerPayload: normalizedProviderPayload } : {}),
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  private removeToolCardRenderer(toolId: string): void {
    const { state } = this.deps;
    this.cancelPendingToolOutputRender(toolId);
    state.pendingTools.delete(toolId);
    state.writeEditStates.delete(toolId);
    const toolEl = state.toolCallElements.get(toolId);
    state.toolCallElements.delete(toolId);
    toolEl?.remove();
  }

  private applySubagentToTaskToolCall(taskToolCall: ToolCallInfo, subagent: SubagentInfo): void {
    taskToolCall.subagent = subagent;
    if (subagent.status === 'completed') taskToolCall.status = 'completed';
    else if (subagent.status === 'error') taskToolCall.status = 'error';
    else taskToolCall.status = 'running';
    if (subagent.result !== undefined) {
      taskToolCall.result = subagent.result;
    }
  }

  private linkTaskToolCallToSubagent(msg: ChatMessage, subagent: SubagentInfo): boolean {
    const taskToolCall = msg.toolCalls?.find(
      tc => tc.id === subagent.id && tc.name === TOOL_SUBAGENT
    );
    if (!taskToolCall) return false;
    this.applySubagentToTaskToolCall(taskToolCall, subagent);
    return true;
  }

  // ============================================
  // Thinking Indicator
  // ============================================

  /** Debounce delay before showing thinking indicator (ms). */
  private static readonly THINKING_INDICATOR_DELAY = 400;

  /**
   * Schedules showing the thinking indicator after a delay.
   * If content arrives before the delay, the indicator won't show.
   * This prevents the indicator from appearing during active streaming.
   * Note: Flavor text is hidden when model thinking block is active (thinking takes priority).
   */
  showThinkingIndicator(overrideText?: string, overrideCls?: string): void {
    const { state } = this.deps;

    // Early return if no content element
    if (!state.currentContentEl) return;

    // Clear any existing timeout
    if (state.thinkingIndicatorTimeout) {
      const timerWindow = state.currentContentEl.ownerDocument.defaultView ?? window;
      state.clearThinkingIndicatorTimeout(timerWindow);
    }

    // Don't show flavor text while model thinking block is active
    if (state.currentThinkingState) {
      return;
    }

    // If indicator already exists, just re-append it to the bottom
    if (state.thinkingEl) {
      state.currentContentEl.appendChild(state.thinkingEl);
      this.deps.updateQueueIndicator();
      this.scrollToBottom();
      return;
    }

    // Schedule showing the indicator after a delay
    const timerWindow = state.currentContentEl.ownerDocument.defaultView ?? window;
    state.setThinkingIndicatorTimeout(timerWindow.setTimeout(() => {
      state.setThinkingIndicatorTimeout(null, null);
      // Double-check we still have a content element, no indicator exists, and no thinking block
      if (!state.currentContentEl || state.thinkingEl || state.currentThinkingState) return;

      const cls = overrideCls
        ? `claudian-thinking ${overrideCls}`
        : 'claudian-thinking';
      state.thinkingEl = state.currentContentEl.createDiv({ cls });
      const text = overrideText || FLAVOR_TEXTS[Math.floor(Math.random() * FLAVOR_TEXTS.length)];
      state.thinkingEl.createSpan({ text });

      // Create timer span with initial value
      const timerSpan = state.thinkingEl.createSpan({ cls: 'claudian-thinking-hint' });
      const updateTimer = () => {
        if (!state.responseStartTime) return;
        // Check if element is still connected to DOM (prevents orphaned interval updates)
        if (!timerSpan.isConnected) {
          if (state.flavorTimerInterval) {
            state.clearFlavorTimerInterval();
          }
          return;
        }
        const elapsedSeconds = Math.floor((performance.now() - state.responseStartTime) / 1000);
        timerSpan.setText(` (esc to interrupt · ${formatDurationMmSs(elapsedSeconds)})`);
      };
      updateTimer(); // Initial update

      // Start interval to update timer every second
      if (state.flavorTimerInterval) {
        state.clearFlavorTimerInterval();
      }
      const thinkingWindow = state.currentContentEl.ownerDocument.defaultView ?? timerWindow;
      state.setFlavorTimerInterval(thinkingWindow.setInterval(updateTimer, 1000), thinkingWindow);
      this.scrollToBottom();
    }, StreamController.THINKING_INDICATOR_DELAY), timerWindow);
  }

  /** Hides the thinking indicator and cancels any pending show timeout. */
  hideThinkingIndicator(): void {
    const { state } = this.deps;

    // Cancel any pending show timeout
    if (state.thinkingIndicatorTimeout) {
      const activeWindow = this.deps.getMessagesEl().ownerDocument.defaultView ?? window;
      state.clearThinkingIndicatorTimeout(activeWindow);
    }

    // Clear timer interval (but preserve responseStartTime for duration capture)
    state.clearFlavorTimerInterval();

    if (state.thinkingEl) {
      state.thinkingEl.remove();
      state.thinkingEl = null;
    }
  }

  // ============================================
  // Compact Boundary
  // ============================================

  private renderCompactBoundary(): void {
    const { state } = this.deps;
    if (!state.currentContentEl) return;
    this.hideThinkingIndicator();
    const el = state.currentContentEl.createDiv({ cls: 'claudian-compact-boundary' });
    el.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
  }

  // ============================================
  // Utilities
  // ============================================

  /**
   * Nudges Obsidian's vault after a Write/Edit/NotebookEdit so the file tree
   * refreshes. Direct `fs` writes bypass the Vault API, and macOS + iCloud
   * FSWatcher often misses the event.
   */
  private notifyVaultFileChange(input: Record<string, unknown>): void {
    const rawPathValue = input.file_path ?? input.notebook_path;
    const rawPath = typeof rawPathValue === 'string' ? rawPathValue : undefined;
    const vaultPath = getVaultPath(this.deps.plugin.app);
    const relativePath = normalizePathForVault(rawPath, vaultPath);
    if (!relativePath || relativePath.startsWith('/')) return;

    window.setTimeout(() => {
      const { vault } = this.deps.plugin.app;
      const file = vault.getAbstractFileByPath(relativePath);
      if (file instanceof TFile) {
        // Existing file — tell listeners the content changed
        vault.trigger('modify', file);
      } else {
        // New file — scan parent directory so Obsidian discovers it
        const parentDir = relativePath.includes('/')
          ? relativePath.substring(0, relativePath.lastIndexOf('/'))
          : '';
        vault.adapter.list(parentDir).catch(() => { /* ignore */ });
      }
    }, 200);
  }

  /** Refreshes vault for each file path in an apply_patch changes array or patch text. */
  private notifyApplyPatchFileChanges(input: Record<string, unknown>): void {
    const notified = new Set<string>();

    // Legacy changes array
    const changes = input.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (change && typeof change === 'object' && !Array.isArray(change)) {
          const changeRecord = change as Record<string, unknown>;
          if (typeof changeRecord.path === 'string') {
            notified.add(changeRecord.path);
            this.notifyVaultFileChange({ file_path: changeRecord.path });
          }
        }
      }
    }

    // Parse file paths from patch text markers (current custom_tool_call format)
    const patchText = typeof input.patch === 'string' ? input.patch : '';
    if (patchText) {
      for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        const filePath = match[1]?.trim();
        if (filePath && !notified.has(filePath)) {
          this.notifyVaultFileChange({ file_path: filePath });
        }
      }
    }
  }

  /** Scrolls messages to bottom if auto-scroll is enabled. */
  private scrollToBottom(): void {
    if (this.pendingScrollFrame !== null) return;

    this.pendingScrollFrame = scheduleAnimationFrame(() => {
      this.pendingScrollFrame = null;
      this.applyScrollToBottom();
    }, this.getMessagesWindow());
  }

  private applyScrollToBottom(): void {
    const { state, plugin } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    const messagesEl = this.deps.getMessagesEl();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private cancelPendingScroll(): void {
    if (this.pendingScrollFrame === null) return;

    cancelScheduledAnimationFrame(this.pendingScrollFrame);
    this.pendingScrollFrame = null;
  }

  setTabActive(active: boolean): void {
    this.tabActive = active;
    this.syncRenderAvailability();
  }

  setViewportVisible(visible: boolean): void {
    this.viewportVisible = visible;
    this.syncRenderAvailability();
  }

  private syncRenderAvailability(): void {
    const visible = this.tabActive && this.viewportVisible;
    this.textRenderCoordinator.setAvailable(visible);
    this.syncThinkingRenderAvailability();
  }

  private syncThinkingRenderAvailability(): void {
    const thinkingExpanded = this.deps.state.currentThinkingState?.isExpanded === true;
    this.thinkingRenderCoordinator.setAvailable(
      this.tabActive && this.viewportVisible && thinkingExpanded
    );
  }

  private getMessagesWindow(): Window | null {
    return this.deps.getMessagesEl().ownerDocument.defaultView ?? null;
  }

  private getStreamingRenderWindow(): Window | null {
    const { state } = this.deps;
    return state.currentTextEl?.ownerDocument?.defaultView
      ?? state.currentContentEl?.ownerDocument?.defaultView
      ?? this.getMessagesWindow();
  }

  private getThinkingRenderWindow(): Window | null {
    const { state } = this.deps;
    return state.currentThinkingState?.contentEl.ownerDocument?.defaultView
      ?? state.currentContentEl?.ownerDocument?.defaultView
      ?? this.getMessagesWindow();
  }

  resetStreamingState(): void {
    const { state } = this.deps;
    this.textRenderCoordinator.cancel();
    this.thinkingRenderCoordinator.cancel();
    this.cancelPendingToolOutputRenders();
    this.cancelPendingScroll();
    this.hideThinkingIndicator();
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
    this.deps.subagentManager.resetStreamingState();
    this.lifecycleSubagentStates.clear();
    this.lifecycleAgentIdToSpawnId.clear();
    state.pendingTools.clear();
    // Reset response timer (duration already captured at this point)
    state.responseStartTime = null;
  }

  dispose(): void {
    this.textRenderCoordinator.dispose();
    this.thinkingRenderCoordinator.dispose();
    this.cancelPendingToolOutputRenders();
    this.cancelPendingScroll();
  }
}

export function providerOutputEventToStreamChunk(
  event: ProviderExecutionEvent | ProviderBackgroundOutputEvent,
): StreamChunk | null {
  switch (event.type) {
    case 'text_delta':
      return { content: event.text, type: 'text' };
    case 'thinking_delta':
      return { content: event.text, type: 'thinking' };
    case 'citations':
      return { citations: event.citations, type: 'citations' };
    case 'tool_started':
      return event.toolScope.kind === 'subagent'
        ? {
          id: event.toolCallId,
          input: { ...event.input },
          name: event.name,
          subagentId: event.toolScope.subagentId,
          type: 'subagent_tool_use',
        }
        : {
          id: event.toolCallId,
          input: { ...event.input },
          name: event.name,
          ...(event.providerPayload ? { providerPayload: event.providerPayload } : {}),
          type: 'tool_use',
        };
    case 'tool_output':
      return { content: event.content, id: event.toolCallId, type: 'tool_output' };
    case 'tool_completed':
      return event.toolScope.kind === 'subagent'
        ? {
          content: event.content ?? '',
          id: event.toolCallId,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.isBlocked !== undefined ? { isBlocked: event.isBlocked } : {}),
          subagentId: event.toolScope.subagentId,
          ...(event.toolUseResult ? { toolUseResult: event.toolUseResult } : {}),
          type: 'subagent_tool_result',
        }
        : {
          content: event.content ?? '',
          id: event.toolCallId,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.isBlocked !== undefined ? { isBlocked: event.isBlocked } : {}),
          ...(event.toolUseResult ? { toolUseResult: event.toolUseResult } : {}),
          type: 'tool_result',
        };
    case 'usage_updated':
      return { type: 'usage', usage: event.usage };
    case 'context_compacted':
      return { type: 'context_compacted' };
    case 'notice':
      return {
        content: event.message,
        ...(event.level ? { level: event.level } : {}),
        type: 'notice',
      };
    default:
      return null;
  }
}

function mergeToolProviderPayload(toolCall: ToolCallInfo, value: unknown): void {
  const providerPayload = normalizeToolProviderPayload(value);
  if (!providerPayload) return;
  toolCall.providerPayload = {
    ...toolCall.providerPayload,
    ...providerPayload,
  };
}
