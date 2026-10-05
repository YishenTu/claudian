import type {
  ProviderId,
  ProviderSubagentAdapter,
  ProviderSubagentLifecycleAdapter,
} from '@/core/providers/types';
import { resolveToolDiffData } from '@/core/tools/toolDiff';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import { extractToolResultContent } from '@/core/tools/toolResultContent';
import type {
  ChatMessage,
  StreamChunk,
  SubagentInfo,
  SubagentProgress,
  ToolCallInfo,
} from '@/core/types';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { AsyncSubagentHistoryRecovery } from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import { resolveSubagentAdapter } from '@/features/chat/subagents/subagentAdapterResolution';
import { renderSubagentHistory } from '@/features/chat/subagents/SubagentHistoryRenderer';
import type { AsyncSubagentCompletion, SubagentManager } from '@/features/chat/subagents/SubagentManager';
import type { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import {
  applyToolCompletion,
  mergeToolCallChunk,
  mergeToolProviderPayload,
  toolCallFromChunk,
  type ToolCallStream,
} from '@/features/chat/turns/ToolCallStream';

type ToolUseChunk = Extract<StreamChunk, { type: 'tool_use' }>;
type ToolResultChunk = Extract<StreamChunk, { type: 'tool_result' }>;
type SubagentChildChunk = Extract<
  StreamChunk,
  { type: 'subagent_tool_use' | 'subagent_tool_result' | 'subagent_tool_output' }
>;

export interface SubagentStreamRouterDeps {
  state: ChatState;
  /** Shared with other streams of the same owner; managed ids stay per stream. */
  subagentManager: SubagentManager;
  getMessagesEl: () => HTMLElement;
  getProviderId: () => ProviderId;
  /** Recovers finished async subagents from provider history; absent when the owner has none. */
  asyncSubagentHistoryRecovery?: AsyncSubagentHistoryRecovery;
  /** Subagent cards replace or hide the main tool cards they take over. */
  tools: Pick<ToolCallStream, 'flush' | 'flushBefore' | 'detach' | 'remove'>;
  indicator: Pick<ThinkingIndicator, 'show'>;
  scrollToBottom: () => void;
}

/**
 * Routes a stream's subagent tool traffic to the provider's subagent protocol: managed agent
 * tasks (sync, async, and their output tools) and provider lifecycle agents (spawn, wait, close).
 * Records each subagent on its owning message; the SubagentManager owns subagent cards.
 */
export class SubagentStreamRouter {
  /** Agent tasks this stream recorded, released from the shared manager when the stream ends. */
  readonly #managedSubagentIds = new Set<string>();

  constructor(private readonly deps: SubagentStreamRouterDeps) {}

  /** Returns whether the tool belongs to a subagent protocol and was handled here. */
  routeToolUse(chunk: ToolUseChunk, msg: ChatMessage): boolean {
    const adapter = this.#getAdapter(chunk.name);
    if (adapter?.protocol === 'managed-agent') {
      if (adapter.isSpawnTool(chunk.name)) {
        this.deps.tools.flush();
        this.#handleTaskToolUse(chunk, msg);
      } else if (adapter.isOutputTool(chunk.name)) {
        this.deps.subagentManager.handleAgentOutputToolUse(toolCallFromChunk(chunk));
        // Show flavor text while waiting for the output result.
        this.deps.indicator.show();
      }
      return true;
    }
    if (adapter?.protocol === 'lifecycle') {
      if (adapter.isSpawnTool(chunk.name) || this.deps.subagentManager.hasSessionSubagent(chunk.id)) {
        this.#handleLifecycleSpawn(chunk, msg, adapter);
        return true;
      }
      if (
        adapter.isHiddenTool(chunk.name)
        && this.deps.subagentManager.isLifecycleToolOwned(toolCallFromChunk(chunk), adapter)
      ) {
        this.#handleLifecycleHiddenTool(chunk, msg);
        return true;
      }
    }
    return false;
  }

  /** Returns whether a subagent protocol consumed the result. */
  async routeToolResult(chunk: ToolResultChunk, msg: ChatMessage): Promise<boolean> {
    const { subagentManager } = this.deps;

    // A pending task resolves as sync or async from its own result.
    if (subagentManager.hasPendingTask(chunk.id)) {
      this.#recordRenderedPendingTask(
        msg,
        chunk.id,
        subagentManager.renderPendingTaskFromTaskResult(
          chunk.id,
          chunk.content,
          chunk.isError || false,
          this.#getMessageContentEl(msg),
          chunk.providerPayload,
        ),
      );
    }

    if (subagentManager.getSyncSubagent(chunk.id)) {
      this.#finalizeSyncSubagent(chunk, msg);
      return true;
    }

    if (
      await this.#handleAsyncTaskResult(chunk, msg)
      || await this.#handleAgentOutputResult(chunk)
      || this.#handleLifecycleResult(chunk, msg)
    ) {
      this.deps.indicator.show();
      return true;
    }
    return false;
  }

  /** Routes a child tool chunk to its sync subagent; a child confirms a pending task is sync. */
  routeChildChunk(chunk: SubagentChildChunk, msg: ChatMessage): void {
    const parentToolUseId = chunk.subagentId;
    const { subagentManager } = this.deps;

    if (subagentManager.hasPendingTask(parentToolUseId)) {
      this.#recordRenderedPendingTask(
        msg,
        parentToolUseId,
        subagentManager.renderPendingTask(parentToolUseId, this.#getMessageContentEl(msg)),
      );
    }

    const subagentState = subagentManager.getSyncSubagent(parentToolUseId);
    if (!subagentState) return;

    switch (chunk.type) {
      case 'subagent_tool_use':
        subagentManager.addSyncToolCall(parentToolUseId, toolCallFromChunk(chunk));
        this.deps.indicator.show();
        break;

      case 'subagent_tool_output': {
        const toolCall = subagentState.info.toolCalls.find(tc => tc.id === chunk.id);
        if (toolCall) {
          subagentManager.updateSyncToolResult(parentToolUseId, chunk.id, {
            ...toolCall, result: (toolCall.result ?? '') + chunk.content,
          });
        }
        break;
      }

      case 'subagent_tool_result': {
        const existing = subagentState.info.toolCalls.find(tc => tc.id === chunk.id);
        if (existing) {
          const toolCall = { ...existing };
          applyToolCompletion(toolCall, chunk);
          toolCall.diffData = resolveToolDiffData(chunk.resultDetails?.diff, toolCall) ?? toolCall.diffData;
          subagentManager.updateSyncToolResult(parentToolUseId, chunk.id, toolCall);
        }
        break;
      }
    }
  }

  /** Applies a provider session update; returns whether a lifecycle subagent card was placed. */
  handleSubagentUpdate(info: SubagentInfo): boolean {
    this.deps.subagentManager.applySessionUpdate(info);
    for (const message of this.deps.state.messages) {
      const tool = message.toolCalls?.find(candidate => candidate.id === info.id);
      if (!tool) continue;
      const adapter = this.#getAdapter(tool.name);
      if (adapter?.protocol !== 'lifecycle') return false;
      this.#placeLifecycleSubagent(tool, message, adapter);
      return true;
    }
    return false;
  }

  handleSubagentProgress(progress: SubagentProgress): void {
    this.deps.subagentManager.applyProgress(progress);
  }

  async handleAsyncSubagentCompletion(completion: AsyncSubagentCompletion): Promise<boolean> {
    const handled = this.deps.subagentManager.handleAsyncSubagentCompletion(completion);
    await this.deps.asyncSubagentHistoryRecovery?.recover(handled, completion.providerSessionId);
    if (handled) {
      this.deps.indicator.show();
    }
    return handled !== undefined;
  }

  /** Mirrors an async subagent state change into its task tool call; the manager owns the card. */
  onAsyncSubagentStateChange(subagent: SubagentInfo): void {
    const { state } = this.deps;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg.role !== 'assistant') continue;
      const taskToolCall = msg.toolCalls?.find(
        tc => tc.id === subagent.id && tc.name === TOOL_SUBAGENT,
      );
      if (taskToolCall) {
        applySubagentToTaskToolCall(taskToolCall, subagent);
        break;
      }
    }
    this.deps.scrollToBottom();
  }

  /** Releases this stream's agent tasks from the shared manager when its response ends. */
  releaseManaged(): void {
    this.deps.subagentManager.resetStreamingState(this.#managedSubagentIds);
    this.#managedSubagentIds.clear();
  }

  /** Releases managed tasks and the lifecycle state that does not outlive the stream. */
  reset(): void {
    this.releaseManaged();
    this.deps.subagentManager.resetLifecycleState(true);
  }

  #getAdapter(toolName?: string): ProviderSubagentAdapter | null {
    return resolveSubagentAdapter(this.deps.getProviderId(), toolName);
  }

  #getMessageContentEl(message: ChatMessage): HTMLElement | null {
    return this.deps.getMessagesEl().querySelector<HTMLElement>(
      `[data-message-id="${message.id}"] .claudian-message-content`,
    ) ?? this.deps.state.currentContentEl;
  }

  // ============================================
  // Managed agent tasks
  // ============================================

  #handleTaskToolUse(chunk: ToolUseChunk, msg: ChatMessage): void {
    this.#ensureTaskToolCall(msg, chunk.id, chunk.input, chunk.providerPayload);

    const result = this.deps.subagentManager.handleTaskToolUse(
      chunk.id, chunk.input, this.#getMessageContentEl(msg),
    );
    switch (result.action) {
      case 'created_sync':
        this.#recordSubagentInMessage(msg, result.subagentState.info, chunk.id);
        this.deps.indicator.show();
        break;
      case 'created_async':
        this.#recordSubagentInMessage(msg, result.info, chunk.id, 'async');
        this.deps.indicator.show();
        break;
      case 'buffered':
        this.deps.indicator.show();
        break;
      case 'label_updated':
        break;
    }
  }

  #recordRenderedPendingTask(
    msg: ChatMessage,
    toolId: string,
    result: ReturnType<SubagentManager['renderPendingTask']>,
  ): void {
    if (!result) return;
    if (result.mode === 'sync') {
      this.#recordSubagentInMessage(msg, result.subagentState.info, toolId);
    } else {
      this.#recordSubagentInMessage(msg, result.info, toolId, 'async');
    }
  }

  #recordSubagentInMessage(
    msg: ChatMessage,
    info: SubagentInfo,
    toolId: string,
    mode?: 'async',
  ): void {
    const taskToolCall = this.#ensureTaskToolCall(msg, toolId);
    applySubagentToTaskToolCall(taskToolCall, info);

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

  /** Finalizes a sync subagent when its task tool result arrives. */
  #finalizeSyncSubagent(chunk: ToolResultChunk, msg: ChatMessage): void {
    const isError = chunk.isError || false;
    const taskToolCall = this.#ensureTaskToolCall(msg, chunk.id);
    const finalized = this.deps.subagentManager.finalizeSyncSubagent(
      chunk.id, chunk.content, isError, chunk.providerPayload, taskToolCall.subagent,
    );

    taskToolCall.status = isError ? 'error' : 'completed';
    taskToolCall.result = finalized?.result ?? extractToolResultContent(chunk.content, { fallbackIndent: 2 });

    if (finalized) {
      applySubagentToTaskToolCall(taskToolCall, finalized);
      this.#renderManagedSubagentHistory(msg, finalized);
    }

    this.deps.indicator.show();
  }

  /** Managed cards learn their native agent identity from the task result, then show earlier runs of it. */
  #renderManagedSubagentHistory(msg: ChatMessage, info: SubagentInfo | undefined): void {
    const content = this.#getMessageContentEl(msg);
    if (!info?.agentId || !content) return;
    const card = [...content.querySelectorAll<HTMLElement>('[data-subagent-id], [data-async-subagent-id]')]
      .find(element => (element.dataset.subagentId ?? element.dataset.asyncSubagentId) === info.id);
    const { messages } = this.deps.state;
    if (card) renderSubagentHistory(card, info, messages.includes(msg) ? messages : [...messages, msg]);
  }

  async #handleAsyncTaskResult(chunk: ToolResultChunk, msg: ChatMessage): Promise<boolean> {
    const { subagentManager } = this.deps;
    if (
      !subagentManager.isPendingAsyncTask(chunk.id)
      && !subagentManager.getByTaskId(chunk.id)
    ) {
      return false;
    }

    subagentManager.handleTaskToolResult(chunk.id, chunk.content, chunk.isError, chunk.providerPayload);
    await this.deps.asyncSubagentHistoryRecovery?.recover(subagentManager.getByTaskId(chunk.id));
    this.#renderManagedSubagentHistory(msg, subagentManager.getByTaskId(chunk.id));
    return true;
  }

  /** An output tool result finalizes the async subagent it is linked to. */
  async #handleAgentOutputResult(chunk: ToolResultChunk): Promise<boolean> {
    const { subagentManager } = this.deps;
    const isLinked = subagentManager.isLinkedAgentOutputTool(chunk.id);
    const handled = subagentManager.handleAgentOutputToolResult(
      chunk.id,
      chunk.content,
      chunk.isError || false,
      chunk.providerPayload,
    );
    await this.deps.asyncSubagentHistoryRecovery?.recover(handled);
    return isLinked || handled !== undefined;
  }

  #ensureTaskToolCall(
    msg: ChatMessage,
    toolId: string,
    input?: Record<string, unknown>,
    providerPayload?: unknown,
  ): ToolCallInfo {
    this.#managedSubagentIds.add(toolId);
    msg.toolCalls = msg.toolCalls || [];
    const existing = msg.toolCalls.find(tc => tc.id === toolId);
    if (existing) {
      if (input && Object.keys(input).length > 0) {
        existing.input = { ...existing.input, ...input };
      }
      mergeToolProviderPayload(existing, providerPayload);
      if (existing.name !== TOOL_SUBAGENT) {
        existing.name = TOOL_SUBAGENT;
        this.deps.tools.remove(toolId);
      }
      return existing;
    }

    const taskToolCall = toolCallFromChunk({
      id: toolId,
      name: TOOL_SUBAGENT,
      input: input ? { ...input } : {},
      providerPayload,
    });
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  // ============================================
  // Provider lifecycle agents (spawn → wait/close)
  // ============================================

  #handleLifecycleSpawn(
    chunk: ToolUseChunk,
    msg: ChatMessage,
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const existing = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
    if (existing) {
      mergeToolCallChunk(existing, chunk);
      this.#placeLifecycleSubagent(existing, msg, adapter);
      return;
    }

    const toolCall = toolCallFromChunk(chunk);
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });
    this.#placeLifecycleSubagent(toolCall, msg, adapter);
  }

  /** A lifecycle subagent card takes the position of the tool card or restored card it replaces. */
  #placeLifecycleSubagent(
    toolCall: ToolCallInfo,
    msg: ChatMessage,
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const { state, subagentManager, tools } = this.deps;
    const id = toolCall.id;
    const content = this.#getMessageContentEl(msg);
    const restored = content ? [...content.querySelectorAll<HTMLElement>('[data-subagent-id]')]
      .find(element => element.dataset.subagentId === id) : undefined;
    const previous = restored ?? subagentManager.getLifecycleElement(id) ?? state.toolCallElements.get(id);
    const pending = state.pendingTools.get(id);
    const parent = previous?.parentElement ?? pending?.parentEl ?? content;
    if (pending) {
      tools.flushBefore(id);
    } else if (!previous) {
      tools.flush();
    }
    tools.detach(id);
    for (const hiddenId of subagentManager.updateLifecycleSpawn(toolCall, msg.toolCalls ?? [], adapter, parent, previous)) {
      tools.remove(hiddenId);
    }
    const card = subagentManager.getLifecycleElement(id);
    if (card && toolCall.subagent) {
      renderSubagentHistory(card, toolCall.subagent, state.messages);
    }
  }

  #handleLifecycleHiddenTool(chunk: ToolUseChunk, msg: ChatMessage): void {
    const existing = msg.toolCalls?.find(toolCall => toolCall.id === chunk.id);
    if (existing) {
      mergeToolCallChunk(existing, chunk);
      this.deps.tools.remove(chunk.id);
      if (existing.status !== 'running' && existing.result !== undefined) {
        this.#handleLifecycleResult({
          type: 'tool_result',
          id: existing.id,
          content: existing.result,
          isError: existing.status === 'error' || existing.status === 'blocked',
        }, msg);
      }
      return;
    }

    // Track in toolCalls for data completeness, but don't create DOM.
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCallFromChunk(chunk));
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });
  }

  /** Returns whether a lifecycle subagent consumed the result. */
  #handleLifecycleResult(chunk: ToolResultChunk, msg: ChatMessage): boolean {
    const existing = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existing) return false;

    const adapter = this.#getAdapter(existing.name);
    if (!adapter || adapter.protocol !== 'lifecycle') return false;
    const { messages } = this.deps.state;
    const result = this.deps.subagentManager.handleLifecycleResult(
      existing,
      extractToolResultContent(chunk.content, { fallbackIndent: 2 }),
      chunk.isError === true,
      (messages.includes(msg) ? messages : [...messages, msg]).flatMap(message => message.toolCalls ?? []),
      adapter,
    );
    for (const id of result.hiddenToolIds) this.deps.tools.remove(id);
    return result.consumed;
  }
}

function applySubagentToTaskToolCall(taskToolCall: ToolCallInfo, subagent: SubagentInfo): void {
  taskToolCall.subagent = subagent;
  if (subagent.status === 'completed') taskToolCall.status = 'completed';
  else if (subagent.status === 'error') taskToolCall.status = 'error';
  else taskToolCall.status = 'running';
  if (subagent.result !== undefined) {
    taskToolCall.result = subagent.result;
  }
}
