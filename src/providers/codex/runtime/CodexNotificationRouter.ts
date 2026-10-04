import type { StreamChunk } from '@/core/types';
import { parseCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';
import {
  CODEX_ASYNC_QUESTION_RESULT,
  normalizeCodexToolInput,
  normalizeCodexWebSearchInput,
} from '@/providers/codex/normalization/codexToolNormalization';
import { extractCodexUserVisibleText, joinCodexUserTextParts } from '@/providers/codex/normalization/codexUserText';

import type {
  AgentMessageItem,
  CollabAgentToolCallItem,
  CommandExecutionItem,
  DynamicToolCallItem,
  ErrorNotification,
  FileChangeItem,
  FileChangePatchUpdatedNotification,
  ImageViewItem,
  ItemCompletedNotification,
  ItemStartedNotification,
  MCPToolCallItem,
  TokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  UserMessageItem,
  WebSearchItem,
} from './codexAppServerTypes';
import { CodexAssistantTextTracker } from './notifications/CodexAssistantTextTracker';
import { CodexCommandCorrelator } from './notifications/CodexCommandCorrelator';
import { CodexDeferredExecCorrelator } from './notifications/CodexDeferredExecCorrelator';
import {
  buildCanonicalToolProjection,
  buildFileChangeInput,
  FILE_CHANGE_TOOL_NAME,
  hasWebSearchRequest,
  isCanonicalToolItem,
  projectCollabAgentToolResult,
  projectCollabAgentToolUse,
  projectCommandToolUse,
  projectDynamicToolResult,
  projectFileChangeToolResult,
  projectImageViewToolUse,
  projectMCPToolResult,
  projectMCPToolUse,
  projectPlanUpdate,
  projectTokenUsage,
  projectWebSearchToolResult,
} from './notifications/codexItemToolProjection';
import { asRecord, firstString, getItemId } from './notifications/codexNotificationValues';
import { CodexRawToolCallTracker } from './notifications/CodexRawToolCallTracker';
import {
  type CodexToolChunkSink,
  CodexToolLedger,
  type CodexToolUseChunk,
} from './notifications/CodexToolLedger';

type ChunkEmitter = (chunk: StreamChunk) => void;

/**
 * Projects one thread's app-server notifications into stream chunks.
 *
 * Dispatches notifications, publishes canonical items, and owns the turn lifecycle.
 * Raw response items, deferred script calls, command pairing, and assistant text
 * deduplication are delegated to turn-scoped collaborators sharing one tool ledger.
 */
export class CodexNotificationRouter {
  #seenWebSearchIds = new Set<string>();
  #planUpdateCounter = 0;
  #startedUserMessageIds = new Set<string>();
  readonly #ledger = new CodexToolLedger();
  readonly #assistantText: CodexAssistantTextTracker;
  readonly #commands: CodexCommandCorrelator;
  readonly #deferred: CodexDeferredExecCorrelator;
  readonly #raw: CodexRawToolCallTracker;

  constructor(
    private readonly emitChunk: ChunkEmitter,
    private readonly workingDirectory?: string,
    streamRawExecCalls = false,
  ) {
    const sink: CodexToolChunkSink = {
      emit: chunk => this.#emit(chunk),
      emitToolUse: chunk => this.#emitToolUse(chunk),
    };
    this.#assistantText = new CodexAssistantTextTracker(chunk => this.#emit(chunk));
    this.#commands = new CodexCommandCorrelator(
      sink,
      this.#ledger,
      callId => this.#raw.releaseCommandCall(callId),
      workingDirectory,
    );
    this.#deferred = new CodexDeferredExecCorrelator(sink, this.#ledger, {
      workingDirectory,
      streamRawExecCalls,
      onCanonicalClaimed: itemId => this.#commands.dropUnmatchedCanonical(itemId),
      onWebSearchClaimed: (itemId, requestedInput) => this.#adoptRequestedWebSearch(itemId, requestedInput),
    });
    this.#raw = new CodexRawToolCallTracker(sink, this.#ledger, this.#commands, this.#deferred);
  }

  beginTurn(): void {
    this.#resetTurn();
  }

  endTurn(): void {
    this.#resetTurn();
  }

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const { itemId, delta } = params as { itemId: string; delta: string };
        this.#assistantText.appendDelta(itemId, delta);
        break;
      }
      case 'item/started':
        this.#onItemStarted(params as ItemStartedNotification);
        break;
      case 'item/completed':
        this.#onItemCompleted(params as ItemCompletedNotification);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.#emit({ type: 'thinking', content: (params as { delta: string }).delta });
        break;
      case 'item/plan/delta':
        this.#emit({ type: 'text', content: (params as { delta: string }).delta });
        break;
      case 'item/commandExecution/outputDelta':
        this.#commands.handleOutputDelta(params as { itemId: string; delta: string }, true);
        break;
      case 'item/fileChange/outputDelta':
        this.#commands.handleOutputDelta(params as { itemId: string; delta: string }, false);
        break;
      case 'item/fileChange/patchUpdated':
        this.#onFileChangePatchUpdated(params as FileChangePatchUpdatedNotification);
        break;
      case 'rawResponseItem/completed':
        this.#onRawResponseItemCompleted(params);
        break;
      case 'event_msg':
        this.#onEventMsg(params);
        break;
      case 'thread/tokenUsage/updated': {
        const usageParams = params as TokenUsageUpdatedNotification;
        this.#emit({ type: 'usage', usage: projectTokenUsage(usageParams), sessionId: usageParams.threadId });
        break;
      }
      case 'turn/plan/updated':
        this.#onPlanUpdated(params as TurnPlanUpdatedNotification);
        break;
      case 'turn/completed':
        this.#onTurnCompleted(params as TurnCompletedNotification);
        break;
      case 'error':
        this.#onError(params as ErrorNotification);
        break;
      default:
        break;
    }
  }

  #resetTurn(): void {
    this.#startedUserMessageIds.clear();
    this.#ledger.clear();
    this.#assistantText.reset();
    this.#commands.reset();
    this.#deferred.reset();
    this.#raw.reset();
  }

  #emit(chunk: StreamChunk): void {
    if (chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'tool_output') {
      const id = this.#deferred.aliasFor(chunk.id);
      if (id) {
        this.emitChunk({ ...chunk, id });
        return;
      }
    }
    this.emitChunk(chunk);
  }

  /** The single assistant-text boundary: a published tool card ends the current text segment. */
  #emitToolUse(chunk: CodexToolUseChunk): void {
    this.#assistantText.endSegment();
    this.#emit(chunk);
  }

  #onItemStarted(params: ItemStartedNotification): void {
    const item = params.item;
    if (item.type === 'agentMessage' && this.#handleAsyncQuestion(item, false)) return;
    const itemId = getItemId(item);
    const deferredOwned = this.#claimDeferredItem(item, false);
    if (item.type === 'commandExecution' && !deferredOwned && this.#commands.claimPendingRawCommand(item)) {
      this.#deferred.release(item.id);
      this.#commands.flushPendingOutput(item.id);
      return;
    }
    if (itemId && this.#ledger.rawStartedIds.has(itemId)) {
      this.#commands.flushPendingOutput(itemId);
      return;
    }
    if (itemId && isCanonicalToolItem(item)) {
      if (this.#ledger.canonicalStartedIds.has(itemId)) {
        return;
      }
      this.#ledger.canonicalStartedIds.add(itemId);
    }

    switch (item.type) {
      case 'userMessage':
        this.#emitUserMessageBoundary(item);
        break;

      case 'agentMessage':
        this.#assistantText.startMessage(item.id);
        break;

      case 'commandExecution':
        this.#emitCommandToolUse(item);
        if (!deferredOwned) {
          this.#commands.trackCanonicalCommand(item);
        }
        break;

      case 'fileChange':
        this.#emitFileChangeToolUse(item);
        break;

      case 'imageView':
        this.#emitImageViewToolUse(item);
        break;

      case 'webSearch':
        this.#emitWebSearchToolUse(item, true);
        break;

      case 'collabAgentToolCall':
        this.#emitCollabAgentToolUse(item);
        break;

      case 'mcpToolCall':
        this.#emitMCPToolUse(item);
        break;

      case 'dynamicToolCall':
        this.#emitDynamicToolUse(item);
        break;

      default:
        break;
    }
    if (itemId && isCanonicalToolItem(item)) {
      this.#commands.flushPendingOutput(itemId);
    }
  }

  #onItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item;
    if (item.type === 'agentMessage' && this.#handleAsyncQuestion(item, true)) return;
    if (item.type === 'subAgentActivity') {
      // Resumed threads can omit raw function calls. Keep an interaction anchor so
      // session-owned child updates have a tool to attach to when work starts.
      if (item.kind === 'interacted' && !this.#ledger.rawStartedIds.has(item.id)) {
        this.#emit({ type: 'tool_use', id: item.id, name: 'send_input', input: { id: item.agentThreadId } });
        this.#emit({ type: 'tool_result', id: item.id, content: '', isError: false });
      }
      if (item.kind === 'started' && !this.#ledger.canonicalCompletedIds.has(item.id)) {
        this.#ledger.canonicalCompletedIds.add(item.id);
        this.#emit({ type: 'tool_use', id: item.id, name: 'spawn_agent', input: normalizeCodexToolInput('spawn_agent', {
          task_name: item.agentPath, ...this.#ledger.requestedInputs.get(item.id),
        }) });
        this.#emit({ type: 'tool_result', id: item.id, content: JSON.stringify({
          agent_id: item.agentThreadId, task_name: item.agentPath,
        }), isError: false });
      }
      return;
    }
    const itemId = getItemId(item);
    if (itemId && isCanonicalToolItem(item)) {
      if (this.#ledger.canonicalCompletedIds.has(itemId)) {
        return;
      }
      this.#ledger.canonicalCompletedIds.add(itemId);
      this.#ledger.inFlightRawCallIds.delete(itemId);
    }
    const deferredOwned = this.#claimDeferredItem(item, true);
    if (itemId && deferredOwned) {
      this.#deferred.markCanonicalCompleted(itemId);
    }
    const rawResult = item.type !== 'commandExecution' && itemId
      ? this.#ledger.consumeRawResult(itemId)
      : undefined;
    const hadCanonicalToolUse = itemId
      ? this.#ledger.canonicalStartedIds.has(itemId)
      : false;
    const completedCommandRawProjection = item.type === 'commandExecution' && !deferredOwned
      ? this.#commands.resolveCompletedRawCommand(item)
      : undefined;
    if (item.type === 'commandExecution') {
      if (!this.#ledger.canonicalStartedIds.has(item.id) && !completedCommandRawProjection) {
        this.#ledger.canonicalStartedIds.add(item.id);
        this.#emitCommandToolUse(item);
      } else if (completedCommandRawProjection) {
        this.#ledger.canonicalStartedIds.add(item.id);
      }
    } else {
      this.#ensureCanonicalToolUseFromCompletion(item);
    }
    if (itemId && isCanonicalToolItem(item)) {
      this.#commands.flushPendingOutput(itemId);
    }

    switch (item.type) {
      case 'userMessage':
        this.#emitUserMessageBoundary(item);
        break;

      case 'agentMessage':
        this.#assistantText.completeMessage(item);
        break;

      case 'commandExecution':
        this.#commands.complete(item, completedCommandRawProjection);
        break;

      case 'fileChange':
        if (hadCanonicalToolUse) {
          this.#emitFileChangeToolUse(item);
        }
        this.#emit({
          type: 'tool_result',
          id: item.id,
          ...projectFileChangeToolResult(item, this.#rememberFileChangeInput(item.id, item.changes)),
        });
        break;

      case 'imageView':
        this.#emit({ type: 'tool_result', id: item.id, content: item.path, isError: false });
        break;

      case 'webSearch':
        this.#emitWebSearchToolUse(item);
        this.#emit({ type: 'tool_result', id: item.id, ...projectWebSearchToolResult(item) });
        break;

      case 'collabAgentToolCall':
        if ((hadCanonicalToolUse || this.#ledger.rawStartedIds.has(item.id))
          && (item.prompt || item.model || item.reasoningEffort
            || (item.tool === 'spawnAgent' && this.#ledger.requestedInputs.has(item.id)))) {
          this.#emitCollabAgentToolUse(item);
        }
        this.#emit({ type: 'tool_result', id: item.id, ...projectCollabAgentToolResult(item, rawResult) });
        break;

      case 'mcpToolCall':
        this.#emit({ type: 'tool_result', id: item.id, ...projectMCPToolResult(item) });
        break;

      case 'dynamicToolCall':
        this.#emitDynamicToolResult(item);
        break;

      case 'contextCompaction':
        this.#emit({ type: 'context_compacted' });
        break;

      default:
        if (itemId && rawResult) {
          this.#emit({ type: 'tool_result', id: itemId, ...rawResult });
        }
        break;
    }

    if (
      itemId
      && item.type !== 'commandExecution'
      && this.#ledger.rawStartedIds.has(itemId)
      && !rawResult
    ) {
      this.#raw.ignoreLateOutput(itemId);
    }
  }

  #onRawResponseItemCompleted(params: unknown): void {
    const item = asRecord(asRecord(params)?.item);
    const itemType = typeof item?.type === 'string' ? item.type : undefined;
    if (!item || !itemType) {
      return;
    }

    switch (itemType) {
      case 'function_call':
        this.#raw.handleFunctionCall(item);
        this.#raw.replayPendingOutput(item);
        break;

      case 'custom_tool_call':
        this.#raw.handleCustomToolCall(item);
        this.#raw.replayPendingOutput(item);
        break;

      case 'function_call_output':
      case 'custom_tool_call_output':
        this.#raw.handleOutput(item);
        break;

      case 'agent_message':
      case 'agentMessage':
      case 'message':
        if (this.#handleAsyncQuestion(item as unknown as AgentMessageItem, true)) break;
        this.#assistantText.completeRawMessage(item);
        break;

      default:
        break;
    }
  }

  #onEventMsg(params: unknown): void {
    const payload = asRecord(params);
    if (payload?.type !== 'agent_message') {
      return;
    }

    this.#assistantText.completeTurnMessage(
      firstString(payload.text, payload.message),
      payload.memory_citation ?? payload.memoryCitation,
    );
  }

  /** Returns whether a deferred script call owns this canonical item. */
  #claimDeferredItem(item: ItemStartedNotification['item'], completed: boolean): boolean {
    const projection = item.type === 'fileChange'
      ? { itemId: item.id, name: 'apply_patch', input: this.#rememberFileChangeInput(item.id, item.changes) }
      : buildCanonicalToolProjection(item, this.workingDirectory);
    return projection ? this.#deferred.claimItem(projection, completed) : false;
  }

  #ensureCanonicalToolUseFromCompletion(item: ItemCompletedNotification['item']): void {
    const itemId = getItemId(item);
    if (
      !itemId
      || !isCanonicalToolItem(item)
      || this.#ledger.canonicalStartedIds.has(itemId)
    ) {
      return;
    }
    this.#ledger.canonicalStartedIds.add(itemId);
    if (this.#ledger.rawStartedIds.has(itemId)) {
      return;
    }

    switch (item.type) {
      case 'fileChange':
        this.#emitFileChangeToolUse(item);
        break;
      case 'imageView':
        this.#emitImageViewToolUse(item);
        break;
      case 'webSearch':
        this.#emitWebSearchToolUse(item);
        break;
      case 'collabAgentToolCall':
        this.#emitCollabAgentToolUse(item);
        break;
      case 'mcpToolCall':
        this.#emitMCPToolUse(item);
        break;
      case 'dynamicToolCall':
        this.#emitDynamicToolUse(item);
        break;
      default:
        break;
    }
  }

  // -- canonical tool items ---------------------------------------------------

  #emitCommandToolUse(item: CommandExecutionItem): void {
    this.#emitToolUse({ type: 'tool_use', id: item.id, ...projectCommandToolUse(item) });
  }

  #rememberFileChangeInput(itemId: string, changes: unknown): Record<string, unknown> {
    return this.#ledger.rememberFileChangeInput(itemId, buildFileChangeInput(changes ?? []));
  }

  #emitFileChangeToolUse(item: FileChangeItem): void {
    this.#emitToolUse({
      type: 'tool_use',
      id: item.id,
      name: FILE_CHANGE_TOOL_NAME,
      input: this.#rememberFileChangeInput(item.id, item.changes),
    });
  }

  #onFileChangePatchUpdated(params: FileChangePatchUpdatedNotification): void {
    const itemId = firstString(params.itemId);
    if (!itemId) {
      return;
    }

    const input = this.#rememberFileChangeInput(itemId, params.changes);
    this.#deferred.claimItem({ itemId, name: 'apply_patch', input }, false);
    this.#ledger.canonicalStartedIds.add(itemId);
    this.#emitToolUse({ type: 'tool_use', id: itemId, name: FILE_CHANGE_TOOL_NAME, input });
    this.#commands.flushPendingOutput(itemId);
  }

  #emitImageViewToolUse(item: ImageViewItem): void {
    this.#emitToolUse({ type: 'tool_use', id: item.id, ...projectImageViewToolUse(item) });
  }

  #emitWebSearchToolUse(item: WebSearchItem, started = false): void {
    if (this.#seenWebSearchIds.has(item.id)) return;
    const input = this.#ledger.requestedInputs.get(item.id) ?? normalizeCodexWebSearchInput(item);
    // Native searches start before their request is known. Publishing then would
    // leave an empty card beside the raw exec card that completion later claims.
    if (started && !hasWebSearchRequest(input)) return;
    this.#seenWebSearchIds.add(item.id);
    this.#emitToolUse({ type: 'tool_use', id: item.id, name: 'WebSearch', input });
  }

  /** A deferred script call's request replaces the abbreviated native web action. */
  #adoptRequestedWebSearch(itemId: string, requestedInput: Record<string, unknown>): void {
    this.#ledger.requestedInputs.set(itemId, requestedInput);
    if (this.#seenWebSearchIds.has(itemId)) {
      this.#emit({ type: 'tool_use', id: itemId, name: 'WebSearch', input: requestedInput });
    }
  }

  #emitCollabAgentToolUse(item: CollabAgentToolCallItem): void {
    this.#emitToolUse({
      type: 'tool_use',
      id: item.id,
      ...projectCollabAgentToolUse(item, this.#ledger.requestedInputs.get(item.id)),
    });
  }

  #emitMCPToolUse(item: MCPToolCallItem): void {
    this.#emitToolUse({ type: 'tool_use', id: item.id, ...projectMCPToolUse(item) });
  }

  #emitDynamicToolUse(item: DynamicToolCallItem): void {
    this.#raw.startCall(item.id, item.tool, asRecord(item.arguments) ?? {}, true);
  }

  #emitDynamicToolResult(item: DynamicToolCallItem): void {
    if (this.#ledger.emittedResultIds.has(item.id)) return;
    this.#ledger.emittedResultIds.add(item.id);
    this.#emit({ type: 'tool_result', id: item.id, ...projectDynamicToolResult(item) });
  }

  // -- messages ---------------------------------------------------------------

  #emitUserMessageBoundary(item: UserMessageItem): void {
    if (this.#startedUserMessageIds.has(item.id)) {
      return;
    }

    const rawContent = joinCodexUserTextParts(
      item.content.map((part) => (part.type === 'text' ? part.text : '')),
      '\n\n',
    );
    const visibleContent = extractCodexUserVisibleText(rawContent);
    const isQuestionReply = parseCodexQuestionReply(rawContent).length > 0;
    this.#startedUserMessageIds.add(item.id);

    if (visibleContent === null && rawContent.trim() && !isQuestionReply) {
      return;
    }

    this.#emit({
      type: 'user_message_start',
      itemId: item.id,
      content: visibleContent ?? (isQuestionReply ? '' : rawContent),
    });
  }

  #handleAsyncQuestion(item: AgentMessageItem, completed: boolean): boolean {
    if (item.delivery !== 'async' || !Array.isArray(item.questions) || item.questions.length === 0) return false;
    this.#raw.startCall(item.id, 'request_user_input_async', { questions: item.questions });
    if (completed && !this.#ledger.emittedResultIds.has(item.id)) {
      this.#ledger.emittedResultIds.add(item.id);
      this.#ledger.pendingRawResults.delete(item.id);
      this.#emit({ type: 'tool_result', id: item.id, content: CODEX_ASYNC_QUESTION_RESULT, isError: false });
    }
    return true;
  }

  // -- turn/plan/updated (update_plan) ----------------------------------------

  #onPlanUpdated(params: TurnPlanUpdatedNotification): void {
    this.#planUpdateCounter += 1;
    const syntheticId = `plan-update-${params.turnId ?? 'turn'}-${this.#planUpdateCounter}`;
    const { input, requestInput } = projectPlanUpdate(params);
    this.#deferred.claimPlanUpdate(syntheticId, requestInput);
    this.#emitToolUse({ type: 'tool_use', id: syntheticId, name: 'TodoWrite', input });
    this.#emit({ type: 'tool_result', id: syntheticId, content: 'Plan updated', isError: false });
  }

  // -- turn end ---------------------------------------------------------------

  #closeOpenTools(terminalError: boolean): void {
    this.#deferred.flush(terminalError);
    this.#raw.flush(terminalError);
  }

  #onTurnCompleted(params: TurnCompletedNotification): void {
    const turn = params.turn;
    this.#closeOpenTools(turn.status === 'failed');
    if (turn.status === 'failed' && turn.error) {
      this.#emit({ type: 'error', content: turn.error.message });
    } else {
      this.#emit({ type: 'done' });
    }
  }

  #onError(params: ErrorNotification): void {
    if (params.willRetry) return;
    this.#closeOpenTools(true);
    this.#emit({ type: 'error', content: params.error.message });
  }
}
