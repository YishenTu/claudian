import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import type {
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import {
  addSubagentToolCall,
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  createSubagentBlock,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  markAsyncSubagentOrphaned,
  type SubagentState,
  updateAsyncSubagentRunning,
  updateSubagentToolResult,
} from '../rendering/SubagentRenderer';
import type { PendingToolCall } from '../state/types';

export type SubagentStateChangeCallback = (subagent: SubagentInfo) => void;

export interface AsyncSubagentCompletion {
  type: 'async_subagent_completion';
  providerSessionId: string;
  taskId: string;
  toolUseId?: string;
  status: 'completed' | 'error';
  result?: string;
}

interface AsyncSubagentRecord {
  info: SubagentInfo;
  terminalSource?: 'local_error' | 'notification' | 'tool_output';
  nativeCompletion?: Pick<AsyncSubagentCompletion, 'taskId' | 'status' | 'result'>;
}

export type HandleTaskResult =
  | { action: 'buffered' }
  | { action: 'created_sync'; subagentState: SubagentState }
  | { action: 'created_async'; info: SubagentInfo; domState: AsyncSubagentState }
  | { action: 'label_updated' };

export type RenderPendingResult =
  | { mode: 'sync'; subagentState: SubagentState }
  | { mode: 'async'; info: SubagentInfo; domState: AsyncSubagentState };

export class SubagentManager {
  private static readonly MAX_DEFERRED_ASYNC_COMPLETIONS = 128;

  private syncSubagents: Map<string, SubagentState> = new Map();
  private pendingTasks: Map<string, PendingToolCall> = new Map();
  private _spawnedThisStream = 0;

  private asyncSubagents: Map<string, AsyncSubagentRecord> = new Map();
  private providerIdentifierToToolUseIds: Map<string, Set<string>> = new Map();
  private deferredAsyncCompletions: Map<string, AsyncSubagentCompletion> = new Map();
  private outputToolToTaskToolUseId: Map<string, string> = new Map();
  private asyncDomStates: Map<string, AsyncSubagentState> = new Map();

  private readonly onStateChange: SubagentStateChangeCallback;
  private taskResultInterpreter: ProviderTaskResultInterpreter;

  constructor(
    onStateChange: SubagentStateChangeCallback,
    taskResultInterpreter: ProviderTaskResultInterpreter = ProviderRegistry.getTaskResultInterpreter(),
  ) {
    this.onStateChange = onStateChange;
    this.taskResultInterpreter = taskResultInterpreter;
  }

  public setTaskResultInterpreter(interpreter: ProviderTaskResultInterpreter): void {
    this.taskResultInterpreter = interpreter;
  }

  // ============================================
  // Unified Subagent Entry Point
  // ============================================

  /**
   * Handles an Agent tool_use chunk with minimal buffering to determine sync vs async.
   * Returns a typed result so StreamController can update messages accordingly.
   */
  public handleTaskToolUse(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    currentContentEl: HTMLElement | null
  ): HandleTaskResult {
    // Already rendered as sync → update label (no parentEl needed)
    const existingSyncState = this.syncSubagents.get(taskToolId);
    if (existingSyncState) {
      this.#updateSubagentLabel(existingSyncState.wrapperEl, existingSyncState.info, taskInput);
      return { action: 'label_updated' };
    }

    // Already rendered as async → update label (no parentEl needed)
    const existingAsyncState = this.asyncDomStates.get(taskToolId);
    if (existingAsyncState) {
      this.#updateSubagentLabel(existingAsyncState.wrapperEl, existingAsyncState.info, taskInput);
      // Sync to canonical SubagentInfo so status transitions don't revert updates
      const canonical = this.getByTaskId(taskToolId);
      if (canonical && canonical !== existingAsyncState.info) {
        const task = this.taskResultInterpreter.describeTask(taskInput);
        if (task.description) canonical.description = task.description;
        if (task.prompt) canonical.prompt = task.prompt;
      }
      return { action: 'label_updated' };
    }

    // Already buffered → merge input and try to render
    const pending = this.pendingTasks.get(taskToolId);
    if (pending) {
      const newInput = taskInput || {};
      if (Object.keys(newInput).length > 0) {
        pending.toolCall.input = { ...pending.toolCall.input, ...newInput };
      }
      if (currentContentEl) {
        pending.parentEl = currentContentEl;
      }

      // Keep partial inputs pending until the provider can determine their mode.
      // Sync fallback is handled when child chunks/tool_result confirm sync.
      if (this.taskResultInterpreter.describeTask(pending.toolCall.input).mode) {
        const result = this.renderPendingTask(taskToolId, currentContentEl);
        if (result) {
          return result.mode === 'sync'
            ? { action: 'created_sync', subagentState: result.subagentState }
            : { action: 'created_async', info: result.info, domState: result.domState };
        }
      }
      return { action: 'buffered' };
    }

    // New Task without a content element — buffer for later rendering
    if (!currentContentEl) {
      const toolCall: ToolCallInfo = {
        id: taskToolId,
        name: TOOL_SUBAGENT,
        input: taskInput || {},
        status: 'running',
        isExpanded: false,
      };
      this.pendingTasks.set(taskToolId, { toolCall, parentEl: null });
      return { action: 'buffered' };
    }

    const mode = this.taskResultInterpreter.describeTask(taskInput).mode;
    if (!mode) {
      const toolCall: ToolCallInfo = {
        id: taskToolId,
        name: TOOL_SUBAGENT,
        input: taskInput || {},
        status: 'running',
        isExpanded: false,
      };
      this.pendingTasks.set(taskToolId, { toolCall, parentEl: currentContentEl });
      return { action: 'buffered' };
    }

    this._spawnedThisStream++;
    if (mode === 'async') {
      return this.#createAsyncTask(taskToolId, taskInput, currentContentEl);
    }
    return this.#createSyncTask(taskToolId, taskInput, currentContentEl);
  }

  // ============================================
  // Pending Task Resolution
  // ============================================

  public hasPendingTask(toolId: string): boolean {
    return this.pendingTasks.has(toolId);
  }

  /**
   * Renders a buffered pending task. Called when a child chunk or tool_result
   * confirms the task is synchronous, or when the provider resolves its mode.
   * Uses the optional parentEl override, falling back to the stored parentEl.
   */
  public renderPendingTask(
    toolId: string,
    parentElOverride?: HTMLElement | null
  ): RenderPendingResult | null {
    const pending = this.pendingTasks.get(toolId);
    if (!pending) return null;

    const input = pending.toolCall.input;
    const targetEl = parentElOverride ?? pending.parentEl;
    if (!targetEl) return null;

    this.pendingTasks.delete(toolId);

    try {
      if (this.taskResultInterpreter.describeTask(input).mode === 'async') {
        const result = this.#createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.#createSyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_sync') {
          this._spawnedThisStream++;
          return { mode: 'sync', subagentState: result.subagentState };
        }
      }
    } catch {
      // Non-fatal: task appears incomplete but doesn't crash the stream
    }

    return null;
  }

  /**
   * Resolves a pending Task when its own tool_result arrives.
   * If mode is still unknown, use the provider launch outcome,
   * otherwise fall back to sync so it never remains pending indefinitely.
   */
  public renderPendingTaskFromTaskResult(
    toolId: string,
    taskResult: unknown,
    isError: boolean,
    parentElOverride?: HTMLElement | null,
    taskToolUseResult?: unknown
  ): RenderPendingResult | null {
    const pending = this.pendingTasks.get(toolId);
    if (!pending) return null;

    const input = pending.toolCall.input;
    const targetEl = parentElOverride ?? pending.parentEl;
    if (!targetEl) return null;

    const inferredMode = this.taskResultInterpreter.describeTask(input).mode
      ?? this.taskResultInterpreter.interpretLaunch(taskResult, isError, taskToolUseResult).mode;

    this.pendingTasks.delete(toolId);

    try {
      if (inferredMode === 'async') {
        const result = this.#createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.#createSyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_sync') {
          this._spawnedThisStream++;
          return { mode: 'sync', subagentState: result.subagentState };
        }
      }
    } catch {
      // Non-fatal: task appears incomplete but doesn't crash the stream
    }

    return null;
  }

  // ============================================
  // Sync Subagent Operations
  // ============================================

  public getSyncSubagent(toolId: string): SubagentState | undefined {
    return this.syncSubagents.get(toolId);
  }

  public addSyncToolCall(parentToolUseId: string, toolCall: ToolCallInfo): void {
    const subagentState = this.syncSubagents.get(parentToolUseId);
    if (!subagentState) return;
    addSubagentToolCall(subagentState, toolCall);
  }

  public updateSyncToolResult(
    parentToolUseId: string,
    toolId: string,
    toolCall: ToolCallInfo
  ): void {
    const subagentState = this.syncSubagents.get(parentToolUseId);
    if (!subagentState) return;
    updateSubagentToolResult(subagentState, toolId, toolCall);
  }

  public finalizeSyncSubagent(
    toolId: string,
    result: unknown,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | null {
    const subagentState = this.syncSubagents.get(toolId);
    if (!subagentState) return null;

    const extractedResult = this.taskResultInterpreter.interpretResult(result, isError, { mode: 'sync' }, toolUseResult).result;
    finalizeSubagentBlock(subagentState, extractedResult, isError);
    this.syncSubagents.delete(toolId);

    return subagentState.info;
  }

  // ============================================
  // Async Subagent Lifecycle
  // ============================================

  public handleTaskToolResult(
    taskToolId: string,
    result: unknown,
    isError?: boolean,
    toolUseResult?: unknown
  ): void {
    const record = this.asyncSubagents.get(taskToolId);
    if (!record) return;
    const launch = this.taskResultInterpreter.interpretLaunch(result, isError === true, toolUseResult);
    const resultText = launch.result;

    if (isError) {
      if (!record.terminalSource) {
        this.#transitionToError(record, resultText || 'Task failed to start');
      }
      return;
    }

    const agentId = launch.agentId;

    if (!agentId) {
      if (record.terminalSource) return;
      const truncatedResult = resultText.length > 100 ? resultText.substring(0, 100) + '...' : resultText;
      this.#transitionToError(record, `Failed to parse agent_id. Result: ${truncatedResult}`);
      return;
    }

    record.info.agentId = agentId;
    record.info.startedAt ??= Date.now();
    this.#bindProviderIdentifier(agentId, taskToolId);

    if (!record.terminalSource) {
      record.info.asyncStatus = 'running';
    }
    this.#publishAsyncState(record.info);

    const deferred = this.#takeDeferredAsyncCompletion(taskToolId, agentId);
    if (deferred) {
      this.#applyAsyncSubagentCompletion(record, deferred);
    }
  }

  public handleAgentOutputToolUse(toolCall: ToolCallInfo): void {
    const agentId = this.taskResultInterpreter.getOutputTaskId(toolCall.input);
    if (!agentId) return;

    const record = this.#resolveByProviderIdentifier(agentId);
    if (!record) return;

    record.info.outputToolId = toolCall.id;
    this.outputToolToTaskToolUseId.set(toolCall.id, record.info.id);
  }

  public handleAgentOutputToolResult(
    toolId: string,
    result: unknown,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | undefined {
    const taskToolUseId = this.outputToolToTaskToolUseId.get(toolId);
    let record = taskToolUseId ? this.asyncSubagents.get(taskToolUseId) : undefined;
    let agentId = record?.info.agentId;

    if (!record) {
      const inferredAgentId = this.taskResultInterpreter.getOutputTaskId(undefined, result);
      if (inferredAgentId) {
        agentId = inferredAgentId;
        record = this.#resolveByProviderIdentifier(inferredAgentId);
      }
    }

    if (!record) return undefined;
    const subagent = record.info;

    if (agentId) {
      subagent.agentId = subagent.agentId || agentId;
      this.#bindProviderIdentifier(agentId, subagent.id);
    }

    if (
      subagent.asyncStatus !== 'running'
      && record.terminalSource !== 'notification'
      && record.terminalSource !== 'local_error'
    ) {
      return undefined;
    }

    const output = this.taskResultInterpreter.interpretResult(result, isError, { mode: 'async', agentId }, toolUseResult);
    if (output.status === 'running') {
      this.outputToolToTaskToolUseId.delete(toolId);
      return subagent;
    }

    subagent.asyncStatus = output.status;
    subagent.status = output.status;
    subagent.result = output.result;
    subagent.completedAt = Date.now();
    record.terminalSource = 'tool_output';

    this.outputToolToTaskToolUseId.delete(toolId);

    this.#publishAsyncState(subagent);
    return subagent;
  }

  public handleAsyncSubagentCompletion(
    completion: AsyncSubagentCompletion,
  ): SubagentInfo | undefined {
    const record = this.#resolveAsyncSubagentCompletion(completion);
    if (!record) {
      this.#deferAsyncSubagentCompletion(completion);
      return undefined;
    }
    return this.#applyAsyncSubagentCompletion(record, completion);
  }

  #applyAsyncSubagentCompletion(
    record: AsyncSubagentRecord,
    completion: AsyncSubagentCompletion,
  ): SubagentInfo | undefined {
    const subagent = record.info;
    this.#bindProviderIdentifier(completion.taskId, subagent.id);

    if (record.nativeCompletion) return undefined;

    const result = completion.result?.trim()
      || (completion.status === 'error' ? 'Background task failed.' : 'Background task completed.');
    record.nativeCompletion = {
      taskId: completion.taskId,
      status: completion.status,
      result,
    };

    if (record.terminalSource === 'tool_output') {
      return undefined;
    }

    subagent.asyncStatus = completion.status;
    subagent.status = completion.status;
    subagent.result = result;
    subagent.completedAt ??= Date.now();
    record.terminalSource = 'notification';

    this.#publishAsyncState(subagent);
    return subagent;
  }

  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.asyncSubagents.get(taskToolId)?.info.asyncStatus === 'pending';
  }

  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolToTaskToolUseId.has(toolId);
  }

  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    return this.asyncSubagents.get(taskToolId)?.info;
  }

  /**
   * Re-renders an async subagent after data-only updates (for example,
   * hydrating tool calls from SDK sidecar files) without changing lifecycle state.
   */
  public refreshAsyncSubagent(subagent: SubagentInfo): void {
    this.#updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Lifecycle
  // ============================================

  public get subagentsSpawnedThisStream(): number {
    return this._spawnedThisStream;
  }

  public hasActiveAsyncSubagents(): boolean {
    return Array.from(this.asyncSubagents.values()).some(({ info }) => (
      info.asyncStatus === 'pending' || info.asyncStatus === 'running'
    ));
  }

  public resetSpawnedCount(): void {
    this._spawnedThisStream = 0;
  }

  public resetStreamingState(toolIds?: Iterable<string>): void {
    if (toolIds) {
      for (const id of toolIds) {
        this.syncSubagents.delete(id);
        this.pendingTasks.delete(id);
      }
    } else {
      this.syncSubagents.clear();
      this.pendingTasks.clear();
    }
  }

  public orphanAllActive(): SubagentInfo[] {
    const orphaned: SubagentInfo[] = [];

    for (const record of this.asyncSubagents.values()) {
      if (record.info.asyncStatus === 'pending' || record.info.asyncStatus === 'running') {
        this.#markOrphaned(record);
        orphaned.push(record.info);
      }
    }

    this.deferredAsyncCompletions.clear();
    this.outputToolToTaskToolUseId.clear();

    return orphaned;
  }

  public clear(): void {
    this.syncSubagents.clear();
    this.pendingTasks.clear();
    this.asyncSubagents.clear();
    this.providerIdentifierToToolUseIds.clear();
    this.deferredAsyncCompletions.clear();
    this.outputToolToTaskToolUseId.clear();
    this.asyncDomStates.clear();
  }

  // ============================================
  // Private: State Transitions
  // ============================================

  #markOrphaned(record: AsyncSubagentRecord): void {
    record.info.asyncStatus = 'orphaned';
    record.info.status = 'error';
    record.info.result = 'Conversation ended before task completed';
    record.info.completedAt = Date.now();
    record.terminalSource = 'local_error';
    this.#publishAsyncState(record.info);
  }

  #transitionToError(record: AsyncSubagentRecord, errorResult: string): void {
    record.info.asyncStatus = 'error';
    record.info.status = 'error';
    record.info.result = errorResult;
    record.info.completedAt = Date.now();
    record.terminalSource = 'local_error';
    this.#publishAsyncState(record.info);
  }

  #bindProviderIdentifier(identifier: string, taskToolUseId: string): void {
    const toolUseIds = this.providerIdentifierToToolUseIds.get(identifier) ?? new Set<string>();
    toolUseIds.add(taskToolUseId);
    this.providerIdentifierToToolUseIds.set(identifier, toolUseIds);
  }

  #resolveByProviderIdentifier(identifier: string): AsyncSubagentRecord | undefined {
    const taskToolUseIds = this.providerIdentifierToToolUseIds.get(identifier);
    if (!taskToolUseIds) return undefined;
    if (taskToolUseIds.size !== 1) return undefined;
    return this.asyncSubagents.get(taskToolUseIds.values().next().value!);
  }

  #resolveAsyncSubagentCompletion(
    completion: AsyncSubagentCompletion,
  ): AsyncSubagentRecord | undefined {
    if (completion.toolUseId) {
      return this.asyncSubagents.get(completion.toolUseId);
    }
    return this.#resolveByProviderIdentifier(completion.taskId);
  }

  #deferAsyncSubagentCompletion(completion: AsyncSubagentCompletion): void {
    const key = completion.toolUseId
      ? `tool:${completion.toolUseId}`
      : `provider:${completion.taskId}`;
    if (this.deferredAsyncCompletions.has(key)) return;
    this.deferredAsyncCompletions.set(key, completion);

    while (
      this.deferredAsyncCompletions.size
      > SubagentManager.MAX_DEFERRED_ASYNC_COMPLETIONS
    ) {
      const oldestKey = this.deferredAsyncCompletions.keys().next().value;
      if (oldestKey === undefined) return;
      this.deferredAsyncCompletions.delete(oldestKey);
    }
  }

  #takeDeferredAsyncCompletion(
    taskToolUseId: string,
    providerTaskId?: string,
  ): AsyncSubagentCompletion | undefined {
    const exactKey = `tool:${taskToolUseId}`;
    const exact = this.deferredAsyncCompletions.get(exactKey);
    if (exact) {
      this.deferredAsyncCompletions.delete(exactKey);
      return exact;
    }

    if (!providerTaskId) return undefined;
    const providerKey = `provider:${providerTaskId}`;
    const completion = this.deferredAsyncCompletions.get(providerKey);
    if (!completion) return undefined;
    this.deferredAsyncCompletions.delete(providerKey);
    return completion;
  }

  #publishAsyncState(subagent: SubagentInfo): void {
    this.#updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Private: Task Creation
  // ============================================

  #createSyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement
  ): HandleTaskResult {
    const subagentState = createSubagentBlock(parentEl, taskToolId, { ...this.taskResultInterpreter.describeTask(taskInput) });
    this.syncSubagents.set(taskToolId, subagentState);
    return { action: 'created_sync', subagentState };
  }

  #createAsyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement
  ): HandleTaskResult {
    const task = this.taskResultInterpreter.describeTask(taskInput);
    const description = task.description || 'Background task';
    const prompt = task.prompt || '';

    const info: SubagentInfo = {
      id: taskToolId,
      description,
      prompt,
      mode: 'async',
      isExpanded: false,
      status: 'running',
      toolCalls: [],
      asyncStatus: 'pending',
    };

    const record: AsyncSubagentRecord = { info };
    this.asyncSubagents.set(taskToolId, record);

    const domState = createAsyncSubagentBlock(parentEl, taskToolId, { ...task });
    this.asyncDomStates.set(taskToolId, domState);

    const deferred = this.#takeDeferredAsyncCompletion(taskToolId);
    if (deferred) {
      this.#applyAsyncSubagentCompletion(record, deferred);
    }

    return { action: 'created_async', info, domState };
  }

  // ============================================
  // Private: Label Update
  // ============================================

  #updateSubagentLabel(
    wrapperEl: HTMLElement,
    info: SubagentInfo,
    newInput: Record<string, unknown>
  ): void {
    if (!newInput || Object.keys(newInput).length === 0) return;
    const task = this.taskResultInterpreter.describeTask(newInput);
    const description = task.description || '';
    if (description) {
      info.description = description;
      const labelEl = wrapperEl.querySelector('.claudian-subagent-label');
      if (labelEl) {
        const truncated = description.length > 40 ? description.substring(0, 40) + '...' : description;
        labelEl.setText(truncated);
      }
    }
    const prompt = task.prompt || '';
    if (prompt) {
      info.prompt = prompt;
      const promptEl = wrapperEl.querySelector('.claudian-subagent-prompt-text');
      if (promptEl) {
        promptEl.setText(prompt);
      }
    }
  }

  // ============================================
  // Private: Async DOM State Updates
  // ============================================

  #updateAsyncDomState(subagent: SubagentInfo): void {
    // Find DOM state by task ID first, then by agentId
    let asyncState = this.asyncDomStates.get(subagent.id);

    if (!asyncState) {
      for (const s of this.asyncDomStates.values()) {
        if (s.info.agentId === subagent.agentId) {
          asyncState = s;
          break;
        }
      }
      if (!asyncState) return;
    }

    asyncState.info = subagent;

    switch (subagent.asyncStatus) {
      case 'running':
        updateAsyncSubagentRunning(asyncState, subagent.agentId || '');
        break;

      case 'completed':
      case 'error':
        finalizeAsyncSubagent(asyncState, subagent.result || '', subagent.asyncStatus === 'error');
        break;

      case 'orphaned':
        markAsyncSubagentOrphaned(asyncState);
        break;
    }
  }

}
