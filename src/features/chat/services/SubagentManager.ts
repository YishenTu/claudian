import { existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, sep } from 'path';

import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import { TOOL_TASK } from '../../../core/tools/toolNames';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type {
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import { extractFinalResultFromSubagentJsonl } from '../../../utils/subagentJsonl';
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

export type HandleTaskResult =
  | { action: 'buffered' }
  | { action: 'created_sync'; subagentState: SubagentState }
  | { action: 'created_async'; info: SubagentInfo; domState: AsyncSubagentState }
  | { action: 'label_updated' };

export type RenderPendingResult =
  | { mode: 'sync'; subagentState: SubagentState }
  | { mode: 'async'; info: SubagentInfo; domState: AsyncSubagentState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

export class SubagentManager {
  private static readonly TRUSTED_OUTPUT_EXT = '.output';
  private static readonly TRUSTED_TMP_ROOTS = SubagentManager.resolveTrustedTmpRoots();

  private syncSubagents: Map<string, SubagentState> = new Map();
  private pendingTasks: Map<string, PendingToolCall> = new Map();
  private _spawnedThisStream = 0;

  private activeAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private pendingAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private taskIdToAgentId: Map<string, string> = new Map();
  private outputToolIdToAgentId: Map<string, string> = new Map();
  private asyncDomStates: Map<string, AsyncSubagentState> = new Map();

  private onStateChange: SubagentStateChangeCallback;
  private taskResultInterpreter: ProviderTaskResultInterpreter;

  constructor(
    onStateChange: SubagentStateChangeCallback,
    taskResultInterpreter: ProviderTaskResultInterpreter = ProviderRegistry.getTaskResultInterpreter(),
  ) {
    this.onStateChange = onStateChange;
    this.taskResultInterpreter = taskResultInterpreter;
  }

  public setCallback(callback: SubagentStateChangeCallback): void {
    this.onStateChange = callback;
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
      this.updateSubagentLabel(existingSyncState.wrapperEl, existingSyncState.info, taskInput);
      return { action: 'label_updated' };
    }

    // Already rendered as async → update label (no parentEl needed)
    const existingAsyncState = this.asyncDomStates.get(taskToolId);
    if (existingAsyncState) {
      this.updateSubagentLabel(existingAsyncState.wrapperEl, existingAsyncState.info, taskInput);
      // Sync to canonical SubagentInfo so status transitions don't revert updates
      const canonical = this.getByTaskId(taskToolId);
      if (canonical && canonical !== existingAsyncState.info) {
        if (taskInput.description) canonical.description = taskInput.description as string;
        if (taskInput.prompt) canonical.prompt = taskInput.prompt as string;
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

      // Do not lock mode before run_in_background is explicitly known.
      // Sync fallback is handled when child chunks/tool_result confirm sync.
      if (this.resolveTaskMode(pending.toolCall.input)) {
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
        name: TOOL_TASK,
        input: taskInput || {},
        status: 'running',
        isExpanded: false,
      };
      this.pendingTasks.set(taskToolId, { toolCall, parentEl: null });
      return { action: 'buffered' };
    }

    const mode = this.resolveTaskMode(taskInput);
    if (!mode) {
      const toolCall: ToolCallInfo = {
        id: taskToolId,
        name: TOOL_TASK,
        input: taskInput || {},
        status: 'running',
        isExpanded: false,
      };
      this.pendingTasks.set(taskToolId, { toolCall, parentEl: currentContentEl });
      return { action: 'buffered' };
    }

    this._spawnedThisStream++;
    if (mode === 'async') {
      return this.createAsyncTask(taskToolId, taskInput, currentContentEl);
    }
    return this.createSyncTask(taskToolId, taskInput, currentContentEl);
  }

  // ============================================
  // Pending Task Resolution
  // ============================================

  public hasPendingTask(toolId: string): boolean {
    return this.pendingTasks.has(toolId);
  }

  /**
   * Renders a buffered pending task. Called when a child chunk or tool_result
   * confirms the task is sync, or when run_in_background becomes known.
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
      if (input.run_in_background === true) {
        const result = this.createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.createSyncTask(pending.toolCall.id, input, targetEl);
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
   * If mode is still unknown, infer async from task result shape (agent_id/agentId),
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

    const explicitMode = this.resolveTaskMode(input);
    const taskResultText = extractToolResultContent(taskResult, { fallbackIndent: 2 });
    const inferredMode = explicitMode
      ?? this.inferModeFromTaskResult(taskResultText, isError, taskToolUseResult);

    this.pendingTasks.delete(toolId);

    try {
      if (inferredMode === 'async') {
        const result = this.createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.createSyncTask(pending.toolCall.id, input, targetEl);
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

    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });
    const extractedResult = this.extractAgentResult(resultText, '', toolUseResult);
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
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) return;
    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });

    if (isError) {
      this.transitionToError(subagent, taskToolId, resultText || 'Task failed to start');
      return;
    }

    const agentId = this.taskResultInterpreter.extractAgentId(toolUseResult) ?? this.parseAgentId(resultText);

    if (!agentId) {
      const truncatedResult = resultText.length > 100 ? resultText.substring(0, 100) + '...' : resultText;
      this.transitionToError(subagent, taskToolId, `Failed to parse agent_id. Result: ${truncatedResult}`);
      return;
    }

    subagent.asyncStatus = 'running';
    subagent.agentId = agentId;
    subagent.startedAt = Date.now();

    this.pendingAsyncSubagents.delete(taskToolId);
    this.activeAsyncSubagents.set(agentId, subagent);
    this.taskIdToAgentId.set(taskToolId, agentId);

    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  public handleAgentOutputToolUse(toolCall: ToolCallInfo): void {
    const agentId = this.extractAgentIdFromInput(toolCall.input);
    if (!agentId) return;

    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent) return;

    subagent.outputToolId = toolCall.id;
    this.outputToolIdToAgentId.set(toolCall.id, agentId);
  }

  public handleAgentOutputToolResult(
    toolId: string,
    result: unknown,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | undefined {
    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });
    let agentId = this.outputToolIdToAgentId.get(toolId);
    let subagent = agentId ? this.activeAsyncSubagents.get(agentId) : undefined;

    if (!subagent) {
      const inferredAgentId = this.inferAgentIdFromResult(resultText);
      if (inferredAgentId) {
        agentId = inferredAgentId;
        subagent = this.activeAsyncSubagents.get(inferredAgentId);
      }
    }

    if (!subagent) return undefined;

    if (agentId) {
      subagent.agentId = subagent.agentId || agentId;
      this.outputToolIdToAgentId.set(toolId, agentId);
    }

    if (subagent.asyncStatus !== 'running') {
      return undefined;
    }

    const stillRunning = this.isStillRunningResult(resultText, isError);
    if (stillRunning) {
      this.outputToolIdToAgentId.delete(toolId);
      return subagent;
    }

    const extractedResult = this.extractAgentResult(resultText, agentId ?? '', toolUseResult);

    // The chunk's is_error flag can be unreliable for async subagent results
    // (SDK may set is_error on the content block even when the agent succeeded).
    // Prefer the structured toolUseResult to determine actual error status.
    const finalStatus = this.taskResultInterpreter.resolveTerminalStatus(
      toolUseResult,
      isError ? 'error' : 'completed',
    );

    subagent.asyncStatus = finalStatus;
    subagent.status = finalStatus;
    subagent.result = extractedResult;
    subagent.completedAt = Date.now();

    if (agentId) this.activeAsyncSubagents.delete(agentId);
    this.outputToolIdToAgentId.delete(toolId);

    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
    return subagent;
  }

  public handleAsyncSubagentResult(
    agentId: string,
    status: 'completed' | 'error',
    result?: string
  ): SubagentInfo | undefined {
    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent || subagent.asyncStatus !== 'running') {
      return undefined;
    }

    subagent.agentId = subagent.agentId || agentId;
    subagent.asyncStatus = status;
    subagent.status = status;
    subagent.result = result?.trim() || (status === 'error' ? 'Background task failed.' : 'Background task completed.');
    subagent.completedAt = Date.now();

    this.activeAsyncSubagents.delete(agentId);
    for (const [toolId, mappedAgentId] of this.outputToolIdToAgentId.entries()) {
      if (mappedAgentId === agentId) {
        this.outputToolIdToAgentId.delete(toolId);
      }
    }

    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
    return subagent;
  }

  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.pendingAsyncSubagents.has(taskToolId);
  }

  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolIdToAgentId.has(toolId);
  }

  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    const pending = this.pendingAsyncSubagents.get(taskToolId);
    if (pending) return pending;

    const agentId = this.taskIdToAgentId.get(taskToolId);
    if (agentId) {
      return this.activeAsyncSubagents.get(agentId);
    }

    return undefined;
  }

  /**
   * Re-renders an async subagent after data-only updates (for example,
   * hydrating tool calls from SDK sidecar files) without changing lifecycle state.
   */
  public refreshAsyncSubagent(subagent: SubagentInfo): void {
    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Hook State
  // ============================================

  public hasRunningSubagents(): boolean {
    // pendingAsyncSubagents: awaiting agent_id; activeAsyncSubagents: only holds running entries
    return this.pendingAsyncSubagents.size > 0 || this.activeAsyncSubagents.size > 0;
  }

  // ============================================
  // Lifecycle
  // ============================================

  public get subagentsSpawnedThisStream(): number {
    return this._spawnedThisStream;
  }

  public resetSpawnedCount(): void {
    this._spawnedThisStream = 0;
  }

  public resetStreamingState(): void {
    this.syncSubagents.clear();
    this.pendingTasks.clear();
  }

  public orphanAllActive(): SubagentInfo[] {
    const orphaned: SubagentInfo[] = [];

    for (const subagent of this.pendingAsyncSubagents.values()) {
      this.markOrphaned(subagent);
      orphaned.push(subagent);
    }

    for (const subagent of this.activeAsyncSubagents.values()) {
      if (subagent.asyncStatus === 'running') {
        this.markOrphaned(subagent);
        orphaned.push(subagent);
      }
    }

    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();

    return orphaned;
  }

  public clear(): void {
    this.syncSubagents.clear();
    this.pendingTasks.clear();
    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();
    this.asyncDomStates.clear();
  }

  // ============================================
  // Private: State Transitions
  // ============================================

  private markOrphaned(subagent: SubagentInfo): void {
    subagent.asyncStatus = 'orphaned';
    subagent.status = 'error';
    subagent.result = 'Conversation ended before task completed';
    subagent.completedAt = Date.now();
    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  private transitionToError(subagent: SubagentInfo, taskToolId: string, errorResult: string): void {
    subagent.asyncStatus = 'error';
    subagent.status = 'error';
    subagent.result = errorResult;
    subagent.completedAt = Date.now();
    this.pendingAsyncSubagents.delete(taskToolId);
    this.updateAsyncDomState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Private: Task Creation
  // ============================================

  private createSyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement
  ): HandleTaskResult {
    const subagentState = createSubagentBlock(parentEl, taskToolId, taskInput);
    this.syncSubagents.set(taskToolId, subagentState);
    return { action: 'created_sync', subagentState };
  }

  private createAsyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement
  ): HandleTaskResult {
    const description = (taskInput.description as string) || 'Background task';
    const prompt = (taskInput.prompt as string) || '';

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

    this.pendingAsyncSubagents.set(taskToolId, info);

    const domState = createAsyncSubagentBlock(parentEl, taskToolId, taskInput);
    this.asyncDomStates.set(taskToolId, domState);

    return { action: 'created_async', info, domState };
  }

  // ============================================
  // Private: Label Update
  // ============================================

  private updateSubagentLabel(
    wrapperEl: HTMLElement,
    info: SubagentInfo,
    newInput: Record<string, unknown>
  ): void {
    if (!newInput || Object.keys(newInput).length === 0) return;
    const description = (newInput.description as string) || '';
    if (description) {
      info.description = description;
      const labelEl = wrapperEl.querySelector('.claudian-subagent-label');
      if (labelEl) {
        const truncated = description.length > 40 ? description.substring(0, 40) + '...' : description;
        labelEl.setText(truncated);
      }
    }
    const prompt = (newInput.prompt as string) || '';
    if (prompt) {
      info.prompt = prompt;
      const promptEl = wrapperEl.querySelector('.claudian-subagent-prompt-text');
      if (promptEl) {
        promptEl.setText(prompt);
      }
    }
  }

  private resolveTaskMode(taskInput: Record<string, unknown>): 'sync' | 'async' | null {
    if (!Object.prototype.hasOwnProperty.call(taskInput, 'run_in_background')) {
      return null;
    }
    if (taskInput.run_in_background === true) {
      return 'async';
    }
    if (taskInput.run_in_background === false) {
      return 'sync';
    }
    return null;
  }

  private inferModeFromTaskResult(
    taskResult: string,
    isError: boolean,
    taskToolUseResult?: unknown
  ): 'sync' | 'async' {
    if (isError) {
      return 'sync';
    }
    if (this.taskResultInterpreter.hasAsyncLaunchMarker(taskToolUseResult)) {
      return 'async';
    }
    // Only promote to async for launch-shaped payloads. Completed sync results
    // can still contain agent metadata in the payload or final output text.
    return this.parseAgentIdStrict(taskResult) ? 'async' : 'sync';
  }

  private parseAgentIdStrict(result: string): string | null {
    const payload = this.unwrapTextPayload(result).trim();
    if (!payload) {
      return null;
    }

    const parsed = parseJsonRecord(payload);
    if (parsed) {
      if (this.hasTerminalTaskStatus(parsed)) {
        return null;
      }

      const directAgentId = this.extractAgentIdFromRecord(parsed);
      if (directAgentId) {
        return directAgentId;
      }

      const taskRecord = parsed.task;
      if (isRecord(taskRecord)) {
        return this.extractAgentIdFromRecord(taskRecord);
      }
    }

    const xmlStatus = this.taskResultInterpreter.extractTagValue(payload, 'retrieval_status')
      ?? this.taskResultInterpreter.extractTagValue(payload, 'status');
    if (this.isTerminalTaskStatusValue(xmlStatus)) {
      return null;
    }

    const exactLineMatch = payload.match(/^\s*(?:agent_id|agentId)\s*[=:]\s*"?([a-zA-Z0-9_-]+)"?\s*$/i);
    return exactLineMatch?.[1] ?? null;
  }

  private hasTerminalTaskStatus(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const rawStatus = record.retrieval_status ?? record.status;
    return this.isTerminalTaskStatusValue(rawStatus);
  }

  private isTerminalTaskStatusValue(rawStatus: unknown): boolean {
    if (typeof rawStatus !== 'string') {
      return false;
    }

    const normalized = rawStatus.toLowerCase();
    return normalized === 'completed' || normalized === 'success' || normalized === 'error';
  }

  private extractAgentIdFromRecord(record: Record<string, unknown>): string | null {
    const direct = record.agent_id ?? record.agentId;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }

    const data = record.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const nested = (data as Record<string, unknown>).agent_id ?? (data as Record<string, unknown>).agentId;
    return typeof nested === 'string' && nested.length > 0 ? nested : null;
  }

  private extractAgentIdFromString(value: string): string | null {
    const regexPatterns = [
      /"agent_id"\s*:\s*"([^"]+)"/,
      /"agentId"\s*:\s*"([^"]+)"/,
      /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
    ];

    for (const pattern of regexPatterns) {
      const match = value.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // ============================================
  // Private: Async DOM State Updates
  // ============================================

  private updateAsyncDomState(subagent: SubagentInfo): void {
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

  // ============================================
  // Private: Async Parsing Logic
  // ============================================

  private isStillRunningResult(result: string, isError: boolean): boolean {
    const trimmed = result?.trim() || '';
    const payload = this.unwrapTextPayload(trimmed);

    if (isError) return false;
    if (!trimmed) return false;

    const parsed = parseJsonRecord(payload);
    if (parsed) {
      const status = parsed.retrieval_status ?? parsed.status;
      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      const hasAgents = agents !== null && Object.keys(agents).length > 0;

      if (status === 'not_ready' || status === 'running' || status === 'pending') {
        return true;
      }

      if (hasAgents && agents) {
        const agentStatuses = Object.values(agents)
          .map((agent) => (isRecord(agent) && typeof agent.status === 'string') ? agent.status.toLowerCase() : '');
        const anyRunning = agentStatuses.some(s =>
          s === 'running' || s === 'pending' || s === 'not_ready'
        );
        if (anyRunning) return true;
        return false;
      }

      if (status === 'success' || status === 'completed') {
        return false;
      }

      return false;
    }

    const lowerResult = payload.toLowerCase();
    if (lowerResult.includes('not_ready') || lowerResult.includes('not ready')) {
      return true;
    }

    const xmlStatusMatch = lowerResult.match(/<status>([^<]+)<\/status>/);
    if (xmlStatusMatch) {
      const status = xmlStatusMatch[1].trim();
      if (status === 'running' || status === 'pending' || status === 'not_ready') {
        return true;
      }
    }

    return false;
  }

  private extractAgentResult(result: string, agentId: string, toolUseResult?: unknown): string {
    const structuredResult = this.taskResultInterpreter.extractStructuredResult(toolUseResult);
    const normalizedStructuredResult = this.extractResultFromCandidateString(structuredResult);
    if (normalizedStructuredResult) {
      return normalizedStructuredResult;
    }
    if (structuredResult) {
      return structuredResult;
    }

    const payload = this.unwrapTextPayload(result);

    const parsed = parseJsonRecord(payload);
    if (parsed) {
      const taskResult = this.extractResultFromTaskObject(parsed.task);
      if (taskResult) {
        return taskResult;
      }

      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      const agentData = agents && agentId ? agents[agentId] : null;
      if (isRecord(agentData)) {
        const parsedResult = this.extractResultFromCandidateString(agentData.result);
        if (parsedResult) {
          return parsedResult;
        }
        const parsedOutput = this.extractResultFromCandidateString(agentData.output);
        if (parsedOutput) {
          return parsedOutput;
        }
        return JSON.stringify(agentData, null, 2);
      }

      if (agents) {
        const agentIds = Object.keys(agents);
        if (agentIds.length > 0) {
          const firstAgent = agents[agentIds[0]];
          if (isRecord(firstAgent)) {
            const parsedResult = this.extractResultFromCandidateString(firstAgent.result);
            if (parsedResult) {
              return parsedResult;
            }
            const parsedOutput = this.extractResultFromCandidateString(firstAgent.output);
            if (parsedOutput) {
              return parsedOutput;
            }
          }
          return JSON.stringify(firstAgent, null, 2);
        }
      }

      const parsedResult = this.extractResultFromCandidateString(parsed.result);
      if (parsedResult) {
        return parsedResult;
      }

      const parsedOutput = this.extractResultFromCandidateString(parsed.output);
      if (parsedOutput) {
        return parsedOutput;
      }
    }

    const taggedResult = this.extractResultFromTaggedPayload(payload);
    if (taggedResult) {
      return taggedResult;
    }

    return payload;
  }

  private extractResultFromTaskObject(task: unknown): string | null {
    if (!task || typeof task !== 'object') {
      return null;
    }
    const taskRecord = task as Record<string, unknown>;
    return this.extractResultFromCandidateString(taskRecord.result)
      ?? this.extractResultFromCandidateString(taskRecord.output);
  }

  private extractResultFromCandidateString(candidate: unknown): string | null {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const taggedResult = this.extractResultFromTaggedPayload(trimmed);
    if (taggedResult) {
      return taggedResult;
    }

    const jsonlResult = this.extractResultFromOutputJsonl(trimmed);
    if (jsonlResult) {
      return jsonlResult;
    }

    return trimmed;
  }

  private parseAgentId(result: string): string | null {
    const regexPatterns = [
      /"agent_id"\s*:\s*"([^"]+)"/,
      /"agentId"\s*:\s*"([^"]+)"/,
      /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /\b([a-f0-9]{8})\b/,
    ];

    for (const pattern of regexPatterns) {
      const match = result.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    const parsed = parseJsonRecord(result);
    if (parsed) {
      const agentId = parsed.agent_id || parsed.agentId;

      if (typeof agentId === 'string' && agentId.length > 0) {
        return agentId;
      }

      const data = parsed.data;
      if (isRecord(data) && typeof data.agent_id === 'string') {
        return data.agent_id;
      }

      if (parsed.id && typeof parsed.id === 'string') {
        return parsed.id;
      }
    }

    return null;
  }

  private inferAgentIdFromResult(result: string): string | null {
    const parsed = parseJsonRecord(result);
    if (parsed) {
      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      if (agents) {
        return Object.keys(agents)[0] ?? null;
      }
    }
    return null;
  }

  private unwrapTextPayload(raw: string): string {
    const parsed = parseJsonValue(raw);
    if (parsed !== null) {
      if (Array.isArray(parsed)) {
        const textBlock = (parsed as unknown[]).find((block) => isRecord(block) && typeof block.text === 'string');
        if (isRecord(textBlock) && typeof textBlock.text === 'string') return textBlock.text;
      } else if (isRecord(parsed) && typeof parsed.text === 'string') {
        return parsed.text;
      }
    }
    return raw;
  }

  private extractResultFromTaggedPayload(payload: string): string | null {
    const directResult = this.taskResultInterpreter.extractTagValue(payload, 'result');
    if (directResult) return directResult;

    const outputContent = this.taskResultInterpreter.extractTagValue(payload, 'output');
    if (!outputContent) return null;

    const extractedFromJsonl = this.extractResultFromOutputJsonl(outputContent);
    if (extractedFromJsonl) return extractedFromJsonl;

    const nestedResult = this.taskResultInterpreter.extractTagValue(outputContent, 'result');
    if (nestedResult) return nestedResult;

    const trimmed = outputContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private extractResultFromOutputJsonl(outputContent: string): string | null {
    const inlineResult = extractFinalResultFromSubagentJsonl(outputContent);
    if (inlineResult) {
      return inlineResult;
    }

    const fullOutputPath = this.extractFullOutputPath(outputContent);
    if (!fullOutputPath) {
      return null;
    }

    const fullOutput = this.readFullOutputFile(fullOutputPath);
    if (!fullOutput) {
      return null;
    }

    return extractFinalResultFromSubagentJsonl(fullOutput);
  }

  private extractFullOutputPath(content: string): string | null {
    const truncatedPattern = /\[Truncated\.\s*Full output:\s*([^\]\n]+)\]/i;
    const match = content.match(truncatedPattern);
    if (!match || !match[1]) {
      return null;
    }

    const outputPath = match[1].trim();
    return outputPath.length > 0 ? outputPath : null;
  }

  private readFullOutputFile(fullOutputPath: string): string | null {
    try {
      if (!this.isTrustedOutputPath(fullOutputPath)) {
        return null;
      }

      if (!existsSync(fullOutputPath)) {
        return null;
      }

      const fileContent = readFileSync(fullOutputPath, 'utf-8');
      const trimmed = fileContent.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private extractAgentIdFromInput(input: Record<string, unknown>): string | null {
    const agentId = (input.task_id as string) || (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }

  private static resolveTrustedTmpRoots(): string[] {
    const roots = new Set<string>();
    const candidates = [tmpdir(), '/tmp', '/private/tmp'];
    for (const candidate of candidates) {
      try {
        roots.add(realpathSync(candidate));
      } catch {
        // Ignore unavailable temp roots.
      }
    }
    return Array.from(roots);
  }

  private isTrustedOutputPath(fullOutputPath: string): boolean {
    if (!isAbsolute(fullOutputPath)) {
      return false;
    }

    if (!fullOutputPath.toLowerCase().endsWith(SubagentManager.TRUSTED_OUTPUT_EXT)) {
      return false;
    }

    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullOutputPath);
    } catch {
      return false;
    }

    return SubagentManager.TRUSTED_TMP_ROOTS.some((root) =>
      resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`)
    );
  }
}
