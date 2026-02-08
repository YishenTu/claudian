import { existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, sep } from 'path';

import type {
  SubagentInfo,
  SubagentMode,
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
} from '../rendering';
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

  constructor(onStateChange: SubagentStateChangeCallback) {
    this.onStateChange = onStateChange;
  }

  public setCallback(callback: SubagentStateChangeCallback): void {
    this.onStateChange = callback;
  }

  // ============================================
  // Unified Task Entry Point
  // ============================================

  /**
   * Handles a Task tool_use chunk with minimal buffering to determine sync vs async.
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
        name: 'Task',
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
        name: 'Task',
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
    taskResult: string,
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
    const inferredMode = explicitMode
      ?? this.inferModeFromTaskResult(taskResult, isError, taskToolUseResult);

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
    result: string,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | null {
    const subagentState = this.syncSubagents.get(toolId);
    if (!subagentState) return null;

    const extractedResult = this.extractAgentResult(result, '', toolUseResult);
    finalizeSubagentBlock(subagentState, extractedResult, isError);
    this.syncSubagents.delete(toolId);

    return subagentState.info;
  }

  // ============================================
  // Async Subagent Lifecycle
  // ============================================

  public isAsyncTask(taskInput: Record<string, unknown>): boolean {
    return taskInput.run_in_background === true;
  }

  public handleTaskToolResult(
    taskToolId: string,
    result: string,
    isError?: boolean,
    toolUseResult?: unknown
  ): void {
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) return;

    if (isError) {
      this.transitionToError(subagent, taskToolId, result || 'Task failed to start');
      return;
    }

    const agentId = this.extractAgentIdFromTaskToolUseResult(toolUseResult) ?? this.parseAgentId(result);

    if (!agentId) {
      const truncatedResult = result.length > 100 ? result.substring(0, 100) + '...' : result;
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
    result: string,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | undefined {
    let agentId = this.outputToolIdToAgentId.get(toolId);
    let subagent = agentId ? this.activeAsyncSubagents.get(agentId) : undefined;

    if (!subagent) {
      const inferredAgentId = this.inferAgentIdFromResult(result);
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

    const stillRunning = this.isStillRunningResult(result, isError);
    if (stillRunning) {
      this.outputToolIdToAgentId.delete(toolId);
      return subagent;
    }

    const extractedResult = this.extractAgentResult(result, agentId ?? '', toolUseResult);

    subagent.asyncStatus = isError ? 'error' : 'completed';
    subagent.status = isError ? 'error' : 'completed';
    subagent.result = extractedResult;
    subagent.completedAt = Date.now();

    if (agentId) this.activeAsyncSubagents.delete(agentId);
    this.outputToolIdToAgentId.delete(toolId);

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

  public getByAgentId(agentId: string): SubagentInfo | undefined {
    return this.activeAsyncSubagents.get(agentId);
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

  public getAsyncDomState(taskToolId: string): AsyncSubagentState | undefined {
    return this.asyncDomStates.get(taskToolId);
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

  public getAllActive(): SubagentInfo[] {
    return [
      ...this.pendingAsyncSubagents.values(),
      ...this.activeAsyncSubagents.values(),
    ];
  }

  public hasActiveAsync(): boolean {
    return (
      this.pendingAsyncSubagents.size > 0 ||
      this.activeAsyncSubagents.size > 0
    );
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
      mode: 'async' as SubagentMode,
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
      const labelEl = wrapperEl.querySelector('.claudian-subagent-label') as HTMLElement | null;
      if (labelEl) {
        const truncated = description.length > 40 ? description.substring(0, 40) + '...' : description;
        labelEl.setText(truncated);
      }
    }
    const prompt = (newInput.prompt as string) || '';
    if (prompt) {
      info.prompt = prompt;
      const promptEl = wrapperEl.querySelector('.claudian-subagent-prompt-text') as HTMLElement | null;
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
    if (this.hasAsyncMarkerInToolUseResult(taskToolUseResult)) {
      return 'async';
    }
    // Use strict async markers only; avoid broad ID heuristics.
    return this.parseAgentIdStrict(taskResult) ? 'async' : 'sync';
  }

  private parseAgentIdStrict(result: string): string | null {
    const fromRaw = this.extractAgentIdFromString(result);
    if (fromRaw) return fromRaw;

    const payload = this.unwrapTextPayload(result);
    const fromPayload = this.extractAgentIdFromString(payload);
    if (fromPayload) return fromPayload;

    try {
      const parsed = JSON.parse(result);

      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string') {
            const fromText = this.extractAgentIdFromString((block as Record<string, unknown>).text as string);
            if (fromText) return fromText;
          }
        }
      }

      const agentId = parsed.agent_id || parsed.agentId || parsed?.data?.agent_id;
      if (typeof agentId === 'string' && agentId.length > 0) {
        return agentId;
      }
    } catch {
      // Not JSON
    }

    return null;
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

  private hasAsyncMarkerInToolUseResult(taskToolUseResult?: unknown): boolean {
    if (!taskToolUseResult || typeof taskToolUseResult !== 'object') {
      return false;
    }

    const record = taskToolUseResult as Record<string, unknown>;
    if (record.isAsync === true) {
      return true;
    }

    const directAgentId = record.agentId ?? record.agent_id;
    if (typeof directAgentId === 'string' && directAgentId.length > 0) {
      return true;
    }

    const data = record.data;
    if (data && typeof data === 'object') {
      const nestedRecord = data as Record<string, unknown>;
      const nestedAgentId = nestedRecord.agent_id ?? nestedRecord.agentId;
      if (typeof nestedAgentId === 'string' && nestedAgentId.length > 0) {
        return true;
      }
    }

    if (typeof record.status === 'string' && record.status.toLowerCase() === 'async_launched') {
      return true;
    }

    if (typeof record.outputFile === 'string' && record.outputFile.length > 0) {
      return true;
    }

    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (block && typeof block === 'object') {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === 'string' && this.extractAgentIdFromString(text)) {
            return true;
          }
        } else if (typeof block === 'string' && this.extractAgentIdFromString(block)) {
          return true;
        }
      }
    }

    if (typeof record.content === 'string' && this.extractAgentIdFromString(record.content)) {
      return true;
    }

    return false;
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

    try {
      const parsed = JSON.parse(payload);
      const status = parsed.retrieval_status || parsed.status;
      const hasAgents = parsed.agents && Object.keys(parsed.agents).length > 0;

      if (status === 'not_ready' || status === 'running' || status === 'pending') {
        return true;
      }

      if (hasAgents) {
        const agentStatuses = Object.values(parsed.agents as Record<string, unknown>)
          .map((a) => (a && typeof a === 'object' && 'status' in a && typeof (a as Record<string, unknown>).status === 'string') ? ((a as Record<string, unknown>).status as string).toLowerCase() : '');
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
    } catch {
      // Not JSON
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
    const structuredResult = this.extractResultFromToolUseResult(toolUseResult);
    if (structuredResult) {
      return structuredResult;
    }

    const payload = this.unwrapTextPayload(result);

    try {
      const parsed = JSON.parse(payload);

      const taskResult = this.extractResultFromTaskObject(parsed.task);
      if (taskResult) {
        return taskResult;
      }

      if (parsed.agents && agentId && parsed.agents[agentId]) {
        const agentData = parsed.agents[agentId];
        const parsedResult = this.extractResultFromCandidateString(agentData?.result);
        if (parsedResult) {
          return parsedResult;
        }
        const parsedOutput = this.extractResultFromCandidateString(agentData?.output);
        if (parsedOutput) {
          return parsedOutput;
        }
        return JSON.stringify(agentData, null, 2);
      }

      if (parsed.agents) {
        const agentIds = Object.keys(parsed.agents);
        if (agentIds.length > 0) {
          const firstAgent = parsed.agents[agentIds[0]];
          const parsedResult = this.extractResultFromCandidateString(firstAgent?.result);
          if (parsedResult) {
            return parsedResult;
          }
          const parsedOutput = this.extractResultFromCandidateString(firstAgent?.output);
          if (parsedOutput) {
            return parsedOutput;
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

    } catch {
      // Not JSON, return as-is
    }

    const taggedResult = this.extractResultFromTaggedPayload(payload);
    if (taggedResult) {
      return taggedResult;
    }

    return payload;
  }

  private extractResultFromToolUseResult(toolUseResult: unknown): string | null {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;

    const result = this.extractResultFromTaskObject(record.task)
      ?? this.extractResultFromCandidateString(record.result)
      ?? this.extractResultFromCandidateString(record.output);
    if (result) return result;

    // SDK subagent format: { status, content: [{type:"text",text:"..."}], agentId, ... }
    if (Array.isArray(record.content)) {
      const firstText = (record.content as Array<Record<string, unknown>>)
        .find((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
      if (firstText) {
        const text = (firstText.text as string).trim();
        if (text.length > 0) return text;
      }
    }

    return null;
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

    try {
      const parsed = JSON.parse(result);
      const agentId = parsed.agent_id || parsed.agentId;

      if (typeof agentId === 'string' && agentId.length > 0) {
        return agentId;
      }

      if (parsed.data?.agent_id) {
        return parsed.data.agent_id;
      }

      if (parsed.id && typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {
      // Not JSON
    }

    return null;
  }

  private extractAgentIdFromTaskToolUseResult(toolUseResult: unknown): string | null {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;
    const directAgentId = record.agent_id ?? record.agentId;
    if (typeof directAgentId === 'string' && directAgentId.length > 0) {
      return directAgentId;
    }

    const data = record.data;
    if (data && typeof data === 'object') {
      const nested = data as Record<string, unknown>;
      const nestedAgentId = nested.agent_id ?? nested.agentId;
      if (typeof nestedAgentId === 'string' && nestedAgentId.length > 0) {
        return nestedAgentId;
      }
    }

    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (typeof block === 'string') {
          const extracted = this.extractAgentIdFromString(block);
          if (extracted) return extracted;
          continue;
        }
        if (!block || typeof block !== 'object') {
          continue;
        }
        const blockRecord = block as Record<string, unknown>;
        if (typeof blockRecord.text === 'string') {
          const extracted = this.extractAgentIdFromString(blockRecord.text);
          if (extracted) return extracted;
        }
      }
    } else if (typeof record.content === 'string') {
      const extracted = this.extractAgentIdFromString(record.content);
      if (extracted) return extracted;
    }

    return null;
  }

  private inferAgentIdFromResult(result: string): string | null {
    try {
      const parsed = JSON.parse(result);
      if (parsed.agents && typeof parsed.agents === 'object') {
        const keys = Object.keys(parsed.agents);
        if (keys.length > 0) {
          return keys[0];
        }
      }
    } catch {
      // Not JSON
    }
    return null;
  }

  private unwrapTextPayload(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const textBlock = parsed.find((b: any) => b && typeof b.text === 'string');
        if (textBlock?.text) return textBlock.text as string;
      } else if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        return parsed.text;
      }
    } catch {
      // Not JSON or not an envelope
    }
    return raw;
  }

  private extractResultFromTaggedPayload(payload: string): string | null {
    const directResult = this.extractTagContent(payload, 'result');
    if (directResult) return directResult;

    const outputContent = this.extractTagContent(payload, 'output');
    if (!outputContent) return null;

    const extractedFromJsonl = this.extractResultFromOutputJsonl(outputContent);
    if (extractedFromJsonl) return extractedFromJsonl;

    const nestedResult = this.extractTagContent(outputContent, 'result');
    if (nestedResult) return nestedResult;

    const trimmed = outputContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private extractTagContent(payload: string, tagName: string): string | null {
    const tagRegex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
    const match = payload.match(tagRegex);
    if (!match || !match[1]) return null;
    const content = match[1].trim();
    return content.length > 0 ? content : null;
  }

  private extractResultFromOutputJsonl(outputContent: string): string | null {
    const inlineResult = this.extractAssistantResultFromJsonl(outputContent);
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

    return this.extractAssistantResultFromJsonl(fullOutput);
  }

  private extractAssistantResultFromJsonl(content: string): string | null {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.startsWith('{'));

    let lastAssistantText: string | null = null;
    let lastResultText: string | null = null;

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof parsed.result === 'string' && parsed.result.trim().length > 0) {
        lastResultText = parsed.result.trim();
      }

      const message = parsed.message as Record<string, unknown> | undefined;
      const role = message?.role;
      const contentBlocks = message?.content;
      if (!Array.isArray(contentBlocks)) continue;

      for (const block of contentBlocks) {
        if (
          role === 'assistant' &&
          block &&
          typeof block === 'object' &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim().length > 0
        ) {
          lastAssistantText = block.text.trim();
        }
      }
    }

    return lastAssistantText ?? lastResultText;
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
