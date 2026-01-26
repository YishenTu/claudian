import type {
  AsyncSubagentStatus,
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
  // Sync
  private syncSubagents: Map<string, SubagentState> = new Map();
  private pendingTasks: Map<string, PendingToolCall> = new Map();
  private _spawnedThisStream = 0;

  // Async (from AsyncSubagentManager)
  private activeAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private pendingAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private taskIdToAgentId: Map<string, string> = new Map();
  private outputToolIdToAgentId: Map<string, string> = new Map();

  // Async DOM
  private asyncDomStates: Map<string, AsyncSubagentState> = new Map();

  // Callback
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
      const runInBackground = pending.toolCall.input.run_in_background;
      if (runInBackground !== undefined) {
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

    // New Task — check if run_in_background is known
    const runInBackground = taskInput?.run_in_background;
    if (runInBackground !== undefined) {
      this._spawnedThisStream++;
      if (runInBackground === true) {
        return this.createAsyncTask(taskToolId, taskInput, currentContentEl);
      } else {
        return this.createSyncTask(taskToolId, taskInput, currentContentEl);
      }
    }

    // Unknown — buffer until confirmed by child chunk or result
    const toolCall: ToolCallInfo = {
      id: taskToolId,
      name: 'Task',
      input: taskInput || {},
      status: 'running',
      isExpanded: false,
    };
    this.pendingTasks.set(taskToolId, {
      toolCall,
      parentEl: currentContentEl,
    });
    return { action: 'buffered' };
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
    this._spawnedThisStream++;

    try {
      if (input.run_in_background === true) {
        const result = this.createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.createSyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_sync') {
          return { mode: 'sync', subagentState: result.subagentState };
        }
      }
    } catch {
      // Errors during rendering are non-fatal - the task will appear
      // incomplete but won't crash the stream.
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
    isError: boolean
  ): SubagentInfo | null {
    const subagentState = this.syncSubagents.get(toolId);
    if (!subagentState) return null;

    finalizeSubagentBlock(subagentState, result, isError);
    this.syncSubagents.delete(toolId);

    return subagentState.info;
  }

  // ============================================
  // Async Subagent Lifecycle
  // ============================================

  public isAsyncTask(taskInput: Record<string, unknown>): boolean {
    return taskInput.run_in_background === true;
  }

  public handleTaskToolResult(taskToolId: string, result: string, isError?: boolean): void {
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) return;

    if (isError) {
      subagent.asyncStatus = 'error';
      subagent.status = 'error';
      subagent.result = result || 'Task failed to start';
      subagent.completedAt = Date.now();
      this.pendingAsyncSubagents.delete(taskToolId);
      this.updateAsyncDomState(subagent);
      this.onStateChange(subagent);
      return;
    }

    const agentId = this.parseAgentId(result);

    if (!agentId) {
      subagent.asyncStatus = 'error';
      subagent.status = 'error';
      const truncatedResult = result.length > 100 ? result.substring(0, 100) + '...' : result;
      subagent.result = `Failed to parse agent_id. Result: ${truncatedResult}`;
      subagent.completedAt = Date.now();
      this.pendingAsyncSubagents.delete(taskToolId);
      this.updateAsyncDomState(subagent);
      this.onStateChange(subagent);
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
    isError: boolean
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

    const validStates: AsyncSubagentStatus[] = ['running'];
    if (!validStates.includes(subagent.asyncStatus!)) {
      return undefined;
    }

    const stillRunning = this.isStillRunningResult(result, isError);
    if (stillRunning) {
      this.outputToolIdToAgentId.delete(toolId);
      return subagent;
    }

    const extractedResult = this.extractAgentResult(result, agentId ?? '');

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
      subagent.asyncStatus = 'orphaned';
      subagent.status = 'error';
      subagent.result = 'Conversation ended before task completed';
      subagent.completedAt = Date.now();
      orphaned.push(subagent);
      this.updateAsyncDomState(subagent);
      this.onStateChange(subagent);
    }

    for (const subagent of this.activeAsyncSubagents.values()) {
      if (subagent.asyncStatus === 'running') {
        subagent.asyncStatus = 'orphaned';
        subagent.status = 'error';
        subagent.result = 'Conversation ended before task completed';
        subagent.completedAt = Date.now();
        orphaned.push(subagent);
        this.updateAsyncDomState(subagent);
        this.onStateChange(subagent);
      }
    }

    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
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
    }
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

    const unwrapTextPayload = (raw: string): string => {
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
    };

    const payload = unwrapTextPayload(trimmed);

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
        const agentStatuses = Object.values(parsed.agents as Record<string, any>)
          .map((a: any) => (a && typeof a.status === 'string') ? a.status.toLowerCase() : '');
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

  private extractAgentResult(result: string, agentId: string): string {
    const unwrap = (raw: string): string => {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const textBlock = parsed.find((b: any) => b && typeof b.text === 'string');
          if (textBlock?.text) return textBlock.text as string;
        } else if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
          return parsed.text;
        }
      } catch {
        // ignore
      }
      return raw;
    };

    const payload = unwrap(result);

    try {
      const parsed = JSON.parse(payload);

      if (parsed.agents && agentId && parsed.agents[agentId]) {
        const agentData = parsed.agents[agentId];
        if (agentData.result) {
          return agentData.result;
        }
        return JSON.stringify(agentData, null, 2);
      }

      if (parsed.agents) {
        const agentIds = Object.keys(parsed.agents);
        if (agentIds.length > 0) {
          const firstAgent = parsed.agents[agentIds[0]];
          if (firstAgent.result) {
            return firstAgent.result;
          }
          return JSON.stringify(firstAgent, null, 2);
        }
      }

    } catch {
      // Not JSON, return as-is
    }

    return payload;
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

  private extractAgentIdFromInput(input: Record<string, unknown>): string | null {
    const agentId = (input.task_id as string) || (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }
}
