import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSubagentLifecycleAdapter, ProviderTaskResultInterpreter } from '@/core/providers/types';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import type {
  SubagentInfo,
  SubagentProgress,
  ToolCallInfo,
} from '@/core/types';
import type { ToolProviderPayload } from '@/core/types/tools';
import { SubagentCardView } from '@/features/chat/rendering/subagents/SubagentCardView';

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

/** A task tool's subagent: buffered until its mode is known, then sync until finalized, or async. */
type TaskEntry =
  | { readonly phase: 'pending'; readonly toolCall: ToolCallInfo }
  | { readonly phase: 'sync'; readonly info: SubagentInfo }
  | { readonly phase: 'async'; readonly record: AsyncSubagentRecord };

export type HandleTaskResult =
  | { action: 'buffered' }
  | { action: 'created_sync'; info: SubagentInfo }
  | { action: 'created_async'; info: SubagentInfo }
  | { action: 'label_updated' };

export type ResolvedTask =
  | { mode: 'sync'; info: SubagentInfo }
  | { mode: 'async'; info: SubagentInfo };

export class SubagentManager {
  private static readonly MAX_DEFERRED_ASYNC_COMPLETIONS = 128;

  private readonly tasks = new Map<string, TaskEntry>();
  private lifecycleSubagents = new Map<string, SubagentInfo>();
  private lifecycleAgentIds = new Map<string, string>();
  private sessionSubagentUpdates = new Map<string, SubagentInfo>();
  private _spawnedThisStream = 0;

  private providerIdentifierToToolUseIds: Map<string, Set<string>> = new Map();
  private deferredAsyncCompletions: Map<string, AsyncSubagentCompletion> = new Map();
  private outputToolToTaskToolUseId: Map<string, string> = new Map();
  private readonly cards = new SubagentCardView();
  private readonly progress = new Map<string, SubagentProgress>();

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
    this.cards.reserve(taskToolId, currentContentEl);
    // Existing records are independent of card placement.
    const existingSyncState = this.#sync(taskToolId);
    if (existingSyncState) {
      this.#updateSubagentLabel(existingSyncState, taskInput);
      this.cards.render(existingSyncState, currentContentEl);
      return { action: 'label_updated' };
    }

    // Async records also accept label updates with no card.
    const existingAsyncState = this.#async(taskToolId);
    if (existingAsyncState) {
      const canonical = this.getByTaskId(taskToolId)!;
      this.#updateSubagentLabel(canonical, taskInput);
      this.cards.render(canonical, currentContentEl);
      return { action: 'label_updated' };
    }

    // Merge partial inputs until the provider resolves the task mode.
    const pending = this.#pending(taskToolId);
    if (pending) {
      const newInput = taskInput || {};
      if (Object.keys(newInput).length > 0) {
        pending.input = { ...pending.input, ...newInput };
      }

      // Keep partial inputs pending until the provider can determine their mode.
      // Sync fallback is handled when child chunks/tool_result confirm sync.
      if (this.taskResultInterpreter.describeTask(pending.input).mode) {
        const result = this.resolvePendingTask(taskToolId, currentContentEl);
        if (result) {
          return result.mode === 'sync'
            ? { action: 'created_sync', info: result.info }
            : { action: 'created_async', info: result.info };
        }
      }
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
      this.tasks.set(taskToolId, { phase: 'pending', toolCall });
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
    return this.#pending(toolId) !== undefined;
  }

  /**
   * Resolves a buffered pending task. Called when a child chunk or tool_result
   * confirms the task is synchronous, or when the provider resolves its mode.
   * The card view places the record when a transcript is available.
   */
  public resolvePendingTask(
    toolId: string,
    parentElOverride?: HTMLElement | null
  ): ResolvedTask | null {
    const pending = this.#pending(toolId);
    if (!pending) return null;

    return this.#resolvePending(pending, this.taskResultInterpreter.describeTask(pending.input).mode, parentElOverride);
  }

  /**
   * Resolves a pending Task when its own tool_result arrives.
   * If mode is still unknown, use the provider launch outcome,
   * otherwise fall back to sync so it never remains pending indefinitely.
   */
  public resolvePendingTaskFromTaskResult(
    toolId: string,
    taskResult: unknown,
    isError: boolean,
    parentElOverride?: HTMLElement | null,
    providerPayload?: ToolProviderPayload
  ): ResolvedTask | null {
    const pending = this.#pending(toolId);
    if (!pending) return null;

    const mode = this.taskResultInterpreter.describeTask(pending.input).mode
      ?? this.taskResultInterpreter.interpretLaunch(taskResult, isError, providerPayload).mode;
    return this.#resolvePending(pending, mode, parentElOverride);
  }

  #resolvePending(pending: ToolCallInfo, mode: 'sync' | 'async' | null | undefined, parent?: HTMLElement | null): ResolvedTask {
    this.#deleteTask(pending.id, 'pending');
    this._spawnedThisStream++;
    const result = mode === 'async'
      ? this.#createAsyncTask(pending.id, pending.input, parent)
      : this.#createSyncTask(pending.id, pending.input, parent);
    return { mode: mode === 'async' ? 'async' : 'sync', info: result.info };
  }

  // ============================================
  // Sync Subagent Operations
  // ============================================

  public getSyncSubagent(toolId: string): SubagentInfo | undefined {
    return this.#sync(toolId);
  }

  public addSyncToolCall(parentToolUseId: string, toolCall: ToolCallInfo): void {
    const subagentState = this.#sync(parentToolUseId);
    if (!subagentState) return;
    const tools = subagentState.toolCalls;
    const index = tools.findIndex(tool => tool.id === toolCall.id);
    if (index < 0) tools.push(toolCall);
    else {
      const previous = tools[index];
      tools[index] = {
        ...previous, ...toolCall,
        input: { ...previous.input, ...toolCall.input },
        result: toolCall.result ?? previous.result,
        isExpanded: toolCall.isExpanded ?? previous.isExpanded,
      };
    }
    this.cards.render(subagentState);
  }

  public updateSyncToolResult(
    parentToolUseId: string,
    toolId: string,
    toolCall: ToolCallInfo
  ): void {
    const subagentState = this.#sync(parentToolUseId);
    if (!subagentState) return;
    const index = subagentState.toolCalls.findIndex(tool => tool.id === toolId);
    if (index < 0) return;
    subagentState.toolCalls[index] = toolCall;
    this.cards.render(subagentState);
  }

  public finalizeSyncSubagent(
    toolId: string,
    result: unknown,
    isError: boolean,
    providerPayload?: ToolProviderPayload,
    fallbackInfo?: SubagentInfo,
  ): SubagentInfo | null {
    const record = this.#sync(toolId);
    const info = record ?? fallbackInfo;
    if (!info) return null;
    const outcome = this.taskResultInterpreter.interpretResult(result, isError, { mode: 'sync' }, providerPayload);
    info.status = outcome.status;
    info.result = outcome.result;
    // A reusable native agent identity links this run to its later follow-ups.
    info.agentId ??= this.taskResultInterpreter.interpretLaunch(result, isError, providerPayload).agentId ?? undefined;
    this.cards.render(info);
    this.#deleteTask(toolId, 'sync');
    return info;
  }

  public applyRecoveredData(subagent: SubagentInfo, update: Pick<Partial<SubagentInfo>, 'toolCalls' | 'result'>): void {
    if (update.toolCalls) {
      subagent.toolCalls = update.toolCalls.map(tool => ({ ...tool, input: { ...tool.input } }));
    }
    if (update.result !== undefined) subagent.result = update.result;
  }

  // ============================================
  // Async Subagent Lifecycle
  // ============================================

  public handleTaskToolResult(
    taskToolId: string,
    result: unknown,
    isError?: boolean,
    providerPayload?: ToolProviderPayload
  ): void {
    const record = this.#async(taskToolId);
    if (!record) return;
    const launch = this.taskResultInterpreter.interpretLaunch(result, isError === true, providerPayload);
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
    providerPayload?: ToolProviderPayload
  ): SubagentInfo | undefined {
    const taskToolUseId = this.outputToolToTaskToolUseId.get(toolId);
    let record = taskToolUseId ? this.#async(taskToolUseId) : undefined;
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

    const output = this.taskResultInterpreter.interpretResult(result, isError, { mode: 'async', agentId }, providerPayload);
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

  /** Shows live progress on a running subagent's card; finished or unknown subagents ignore it. */
  public applyProgress(progress: SubagentProgress): void {
    const info = this.lifecycleSubagents.get(progress.toolCallId)
      ?? this.#sync(progress.toolCallId)
      ?? this.#async(progress.toolCallId)?.info;
    if (!info || info.status !== 'running') return;
    this.progress.set(progress.toolCallId, { ...progress });
    this.cards.progress(progress);
  }

  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.#async(taskToolId)?.info.asyncStatus === 'pending';
  }

  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolToTaskToolUseId.has(toolId);
  }

  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    return this.#async(taskToolId)?.info;
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
    return [...this.tasks.values()].some(task => task.phase === 'async' && (
      task.record.info.asyncStatus === 'pending' || task.record.info.asyncStatus === 'running'
    ));
  }

  public resetSpawnedCount(): void {
    this._spawnedThisStream = 0;
  }

  public resetStreamingState(toolIds?: Iterable<string>): void {
    for (const id of toolIds ?? [...this.tasks.keys()]) {
      if (this.tasks.get(id)?.phase !== 'async') this.tasks.delete(id);
    }
  }

  public resetLifecycleState(preserveSessionOwned = false): void {
    if (preserveSessionOwned) {
      for (const [id, record] of this.lifecycleSubagents) {
        if (record.lifecycleSource !== 'session') this.lifecycleSubagents.delete(id);
      }
      for (const [alias, id] of this.lifecycleAgentIds) {
        if (!this.lifecycleSubagents.has(id) && !this.sessionSubagentUpdates.has(id)) this.lifecycleAgentIds.delete(alias);
      }
      return;
    }
    this.lifecycleSubagents.clear();
    this.lifecycleAgentIds.clear();
    this.sessionSubagentUpdates.clear();
  }

  public detachView(): void { this.cards.clear(); }

  /** Whether provider events can still change this task after its response settles. */
  public isTracking(toolId: string): boolean {
    const phase = this.tasks.get(toolId)?.phase;
    if (phase === 'sync' || phase === 'pending') return true;
    const asyncStatus = this.#async(toolId)?.info.asyncStatus;
    if (asyncStatus === 'pending' || asyncStatus === 'running') return true;
    return this.lifecycleSubagents.get(toolId)?.status === 'running';
  }

  /** Pending task mode stays provider-owned; reserve its new view without inferring a card. */
  public attachPendingTaskView(toolId: string, parent: HTMLElement): boolean {
    if (!this.#pending(toolId)) return false;
    this.cards.reserve(toolId, parent);
    return true;
  }

  public attachTaskView(info: SubagentInfo, parent: HTMLElement): void {
    this.cards.render(info, parent);
    const progress = this.progress.get(info.id);
    if (progress && info.status === 'running') this.cards.progress(progress);
  }

  public clear(): void {
    this.resetLifecycleState();
    this.tasks.clear();
    this.providerIdentifierToToolUseIds.clear();
    this.deferredAsyncCompletions.clear();
    this.outputToolToTaskToolUseId.clear();
    this.cards.clear();
    this.progress.clear();
  }

  #pending(toolId: string): ToolCallInfo | undefined {
    const task = this.tasks.get(toolId);
    return task?.phase === 'pending' ? task.toolCall : undefined;
  }

  #sync(toolId: string): SubagentInfo | undefined {
    const task = this.tasks.get(toolId);
    return task?.phase === 'sync' ? task.info : undefined;
  }

  #async(toolId: string): AsyncSubagentRecord | undefined {
    const task = this.tasks.get(toolId);
    return task?.phase === 'async' ? task.record : undefined;
  }

  #deleteTask(toolId: string, phase: TaskEntry['phase']): void {
    if (this.tasks.get(toolId)?.phase === phase) this.tasks.delete(toolId);
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
    return this.#async(taskToolUseIds.values().next().value!);
  }

  #resolveAsyncSubagentCompletion(
    completion: AsyncSubagentCompletion,
  ): AsyncSubagentRecord | undefined {
    if (completion.toolUseId) {
      return this.#async(completion.toolUseId);
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
    parentEl?: HTMLElement | null
  ): { info: SubagentInfo; action: 'created_sync' } {
    const task = this.taskResultInterpreter.describeTask(taskInput);
    const info: SubagentInfo = {
      id: taskToolId, description: task.description || 'Subagent task', prompt: task.prompt || '',
      mode: 'sync', status: 'running', toolCalls: [], isExpanded: false,
    };
    this.tasks.set(taskToolId, { info, phase: 'sync' });
    this.cards.render(info, parentEl);
    return { action: 'created_sync', info };
  }

  #createAsyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl?: HTMLElement | null
  ): { info: SubagentInfo; action: 'created_async' } {
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
    this.tasks.set(taskToolId, { phase: 'async', record });

    this.cards.render(info, parentEl);

    const deferred = this.#takeDeferredAsyncCompletion(taskToolId);
    if (deferred) {
      this.#applyAsyncSubagentCompletion(record, deferred);
    }

    return { action: 'created_async', info };
  }

  // ============================================
  // Private: Label Update
  // ============================================

  #updateSubagentLabel(info: SubagentInfo, newInput: Record<string, unknown>): void {
    const task = this.taskResultInterpreter.describeTask(newInput);
    if (task.description) info.description = task.description;
    if (task.prompt) info.prompt = task.prompt;
  }

  #updateAsyncDomState(subagent: SubagentInfo): void {
    this.cards.render(subagent);
  }

  /** The controller supplies placement; this owner resolves provider lifecycle and card state. */
  public updateLifecycleSpawn(
    toolCall: ToolCallInfo,
    toolCalls: ToolCallInfo[],
    adapter: ProviderSubagentLifecycleAdapter,
    parentEl?: HTMLElement | null,
    previousEl?: HTMLElement,
  ): string[] {
    const update = this.sessionSubagentUpdates.get(toolCall.id);
    const info = { ...adapter.buildSubagentInfo(toolCall, toolCalls), ...update };
    toolCall.subagent = info;
    this.#renderLifecycleState(info, parentEl, previousEl);
    this.#applyLifecycleProgress(toolCall, toolCalls, adapter);
    return this.#bindLifecycleAgent(toolCall.id, info.agentId, toolCalls, adapter);
  }

  public applySessionUpdate(info: SubagentInfo): void {
    this.sessionSubagentUpdates.set(info.id, info);
  }

  public hasSessionSubagent(id: string): boolean {
    return this.sessionSubagentUpdates.has(id);
  }

  public getLifecycleElement(id: string): HTMLElement | undefined {
    return this.cards.getElement(id);
  }

  public isLifecycleToolOwned(tool: ToolCallInfo, adapter: ProviderSubagentLifecycleAdapter): boolean {
    return adapter.isToolCallFullyOwned(tool, this.lifecycleAgentIds);
  }

  public handleLifecycleResult(
    toolCall: ToolCallInfo,
    content: string,
    isError: boolean,
    toolCalls: ToolCallInfo[],
    adapter: ProviderSubagentLifecycleAdapter,
  ): { consumed: boolean; hiddenToolIds: string[] } {
    const resolved = { ...toolCall, result: content, status: isError ? 'error' as const : 'completed' as const };
    const linkedIds = adapter.resolveSpawnToolIds(resolved, this.lifecycleAgentIds);
    const owned = this.isLifecycleToolOwned(resolved, adapter);
    const hiddenToolIds = adapter.isHiddenTool(toolCall.name) && owned ? [toolCall.id] : [];
    if (adapter.isHiddenTool(toolCall.name) && linkedIds.length === 0) {
      return { consumed: false, hiddenToolIds };
    }
    if (adapter.isSpawnTool(toolCall.name) || toolCall.subagent?.lifecycleSource === 'session') {
      Object.assign(toolCall, resolved);
      const info = adapter.buildSubagentInfo(toolCall, toolCalls);
      const agentId = adapter.extractSpawnResult(content, toolCall).agentId ?? info.agentId;
      toolCall.subagent = { ...info, ...(agentId ? { agentId } : {}) };
      this.#renderLifecycleState(toolCall.subagent);
      this.#applyLifecycleProgress(toolCall, toolCalls, adapter);
      hiddenToolIds.push(...this.#bindLifecycleAgent(toolCall.id, agentId, toolCalls, adapter));
      return { consumed: true, hiddenToolIds };
    }
    const closing = adapter.isCloseTool(toolCall.name);
    if (adapter.isWaitTool(toolCall.name) || closing) {
      Object.assign(toolCall, resolved);
      for (const id of linkedIds) {
        const spawn = toolCalls.find(tool => tool.id === id);
        if (!spawn) continue;
        const info = adapter.buildSubagentInfo(spawn, toolCalls);
        spawn.subagent = info;
        this.#renderLifecycleState(info);
        this.#applyLifecycleProgress(spawn, toolCalls, adapter);
      }
      return { consumed: owned && (closing || adapter.isHiddenTool(toolCall.name)), hiddenToolIds };
    }
    return { consumed: false, hiddenToolIds };
  }

  #applyLifecycleProgress(
    spawn: ToolCallInfo,
    tools: ToolCallInfo[],
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const progress = adapter.getProgress?.(spawn, tools);
    if (progress) this.applyProgress(progress);
  }

  #bindLifecycleAgent(
    spawnId: string,
    agentId: string | undefined,
    tools: ToolCallInfo[],
    adapter: ProviderSubagentLifecycleAdapter,
  ): string[] {
    if (!agentId) return [];
    const spawn = tools.find(tool => tool.id === spawnId);
    const launch = spawn ? adapter.extractSpawnResult(spawn.result, spawn) : undefined;
    const identifiers = [agentId, ...(launch?.agentId ? [launch.agentId] : []), ...(launch?.aliases ?? [])];
    if (identifiers.every(id => this.lifecycleAgentIds.get(id) === spawnId)) return [];
    for (const id of identifiers) this.lifecycleAgentIds.set(id, spawnId);
    return tools.filter(tool => adapter.isHiddenTool(tool.name)
      && this.isLifecycleToolOwned(tool, adapter)
      && adapter.resolveSpawnToolIds(tool, this.lifecycleAgentIds).includes(spawnId))
      .map(tool => tool.id);
  }

  #renderLifecycleState(info: SubagentInfo, parentEl?: HTMLElement | null, previousEl?: HTMLElement): void {
    this.lifecycleSubagents.set(info.id, info);
    this.cards.render(info, parentEl, previousEl);
    const progress = this.progress.get(info.id);
    if (progress && info.status === 'running') this.cards.progress(progress);
  }

}
