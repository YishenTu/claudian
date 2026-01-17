/**
 * Claudian - Async subagent lifecycle manager
 *
 * Manages background Task tool execution using a two-tool transaction model:
 * Task tool_use → task_id → TaskOutput → completed/error/orphaned.
 */

import type {
  AsyncSubagentStatus,
  SubagentInfo,
  SubagentMode,
  ToolCallInfo,
} from '../../../core/types';

/** Callback for UI state updates when async subagent state changes. */
export type AsyncSubagentStateChangeCallback = (subagent: SubagentInfo) => void;

/** Manages async subagent lifecycle and state transitions. */
export class AsyncSubagentManager {
  private activeAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private pendingAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private taskIdToAgentId: Map<string, string> = new Map();
  private outputToolIdToAgentId: Map<string, string> = new Map();
  private onStateChange: AsyncSubagentStateChangeCallback;

  constructor(onStateChange: AsyncSubagentStateChangeCallback) {
    this.onStateChange = onStateChange;
  }

  /** Updates the state change callback. Used for deferred wiring after construction. */
  public setCallback(callback: AsyncSubagentStateChangeCallback): void {
    this.onStateChange = callback;
  }

  /** Checks if a Task tool input indicates async mode (run_in_background=true). */
  public isAsyncTask(taskInput: Record<string, unknown>): boolean {
    return taskInput.run_in_background === true;
  }

  /** Creates an async subagent in pending state. */
  public createAsyncSubagent(
    taskToolId: string,
    taskInput: Record<string, unknown>
  ): SubagentInfo {
    const description = (taskInput.description as string) || 'Background task';
    const prompt = (taskInput.prompt as string) || '';

    const subagent: SubagentInfo = {
      id: taskToolId,
      description,
      prompt,
      mode: 'async' as SubagentMode,
      isExpanded: false,
      status: 'running',
      toolCalls: [],
      asyncStatus: 'pending',
    };

    this.pendingAsyncSubagents.set(taskToolId, subagent);
    return subagent;
  }

  /** Handles Task tool_result to extract agent_id. Transitions: pending → running/error. */
  public handleTaskToolResult(taskToolId: string, result: string, isError?: boolean): void {
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) {
      return;
    }

    // If the Task itself errored, transition directly to error
    if (isError) {
      subagent.asyncStatus = 'error';
      subagent.status = 'error';
      subagent.result = result || 'Task failed to start';
      subagent.completedAt = Date.now();
      this.pendingAsyncSubagents.delete(taskToolId);
      this.onStateChange(subagent);
      return;
    }

    // Parse agent_id from result
    const agentId = this.parseAgentId(result);

    if (!agentId) {
      subagent.asyncStatus = 'error';
      subagent.status = 'error';
      const truncatedResult = result.length > 100 ? result.substring(0, 100) + '...' : result;
      subagent.result = `Failed to parse agent_id. Result: ${truncatedResult}`;
      subagent.completedAt = Date.now();
      this.pendingAsyncSubagents.delete(taskToolId);
      this.onStateChange(subagent);
      return;
    }

    subagent.asyncStatus = 'running';
    subagent.agentId = agentId;
    subagent.startedAt = Date.now();

    this.pendingAsyncSubagents.delete(taskToolId);
    this.activeAsyncSubagents.set(agentId, subagent);
    this.taskIdToAgentId.set(taskToolId, agentId);

    this.onStateChange(subagent);
  }

  /** Links TaskOutput tool to its async subagent for result routing. */
  public handleAgentOutputToolUse(toolCall: ToolCallInfo): void {
    const agentId = this.extractAgentIdFromInput(toolCall.input);
    if (!agentId) {
      return;
    }

    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent) {
      return;
    }

    subagent.outputToolId = toolCall.id;
    this.outputToolIdToAgentId.set(toolCall.id, agentId);
  }

  /** Handles TaskOutput result. Transitions: running → completed/error (if done). */
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

    if (!subagent) {
      return undefined;
    }

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

    this.onStateChange(subagent);
    return subagent;
  }

  /** Checks if TaskOutput result indicates the task is still running. */
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

    if (isError) {
      return false;
    }

    if (!trimmed) {
      return false;
    }

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

    // Check for XML-style status (SDK returns XML format for TaskOutput)
    // <status>running</status> or <retrieval_status>not_ready</retrieval_status>
    const xmlStatusMatch = lowerResult.match(/<status>([^<]+)<\/status>/);
    if (xmlStatusMatch) {
      const status = xmlStatusMatch[1].trim();
      if (status === 'running' || status === 'pending' || status === 'not_ready') {
        return true;
      }
    }

    return false;
  }

  /** Extracts the actual result content from TaskOutput response. */
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

      // Try to get result from agents.{agentId}.result
      if (parsed.agents && agentId && parsed.agents[agentId]) {
        const agentData = parsed.agents[agentId];
        if (agentData.result) {
          return agentData.result;
        }
        // If no result field, stringify the agent data
        return JSON.stringify(agentData, null, 2);
      }

      // If agents has any entry, use the first one
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

  /** Orphans all active async subagents when conversation ends. */
  public orphanAllActive(): SubagentInfo[] {
    const orphaned: SubagentInfo[] = [];

    for (const subagent of this.pendingAsyncSubagents.values()) {
      subagent.asyncStatus = 'orphaned';
      subagent.status = 'error';
      subagent.result = 'Conversation ended before task completed';
      subagent.completedAt = Date.now();
      orphaned.push(subagent);
      this.onStateChange(subagent);
    }

    for (const subagent of this.activeAsyncSubagents.values()) {
      if (subagent.asyncStatus === 'running') {
        subagent.asyncStatus = 'orphaned';
        subagent.status = 'error';
        subagent.result = 'Conversation ended before task completed';
        subagent.completedAt = Date.now();
        orphaned.push(subagent);
        this.onStateChange(subagent);
      }
    }

    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.outputToolIdToAgentId.clear();

    return orphaned;
  }

  /** Clears all state for a new conversation. */
  public clear(): void {
    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();
  }

  /** Gets async subagent by agent_id. */
  public getByAgentId(agentId: string): SubagentInfo | undefined {
    return this.activeAsyncSubagents.get(agentId);
  }

  /** Gets async subagent by task tool_use_id. */
  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    const pending = this.pendingAsyncSubagents.get(taskToolId);
    if (pending) return pending;

    const agentId = this.taskIdToAgentId.get(taskToolId);
    if (agentId) {
      return this.activeAsyncSubagents.get(agentId);
    }

    return undefined;
  }

  /** Checks if a task tool_id is a pending async subagent. */
  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.pendingAsyncSubagents.has(taskToolId);
  }

  /** Checks if a tool_id is a TaskOutput tool linked to an async subagent. */
  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolIdToAgentId.has(toolId);
  }

  /** Gets all active async subagents (pending + running). */
  public getAllActive(): SubagentInfo[] {
    return [
      ...this.pendingAsyncSubagents.values(),
      ...this.activeAsyncSubagents.values(),
    ];
  }

  /** Checks if there are any active async subagents. */
  public hasActiveAsync(): boolean {
    return (
      this.pendingAsyncSubagents.size > 0 ||
      this.activeAsyncSubagents.size > 0
    );
  }

  /** Parses agent_id from Task tool_result. */
  private parseAgentId(result: string): string | null {
    const regexPatterns = [
      /"agent_id"\s*:\s*"([^"]+)"/,        // JSON style: "agent_id": "value"
      /"agentId"\s*:\s*"([^"]+)"/,          // camelCase JSON
      /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,  // Flexible format
      /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,   // camelCase flexible
      /\b([a-f0-9]{8})\b/,                  // Short hex ID (8 chars)
    ];

    for (const pattern of regexPatterns) {
      const match = result.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    // Try parsing as JSON
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

  /** Infers agent_id from TaskOutput result payload. */
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

  /** Extracts agentId from TaskOutput tool input. */
  private extractAgentIdFromInput(input: Record<string, unknown>): string | null {
    // TaskOutput uses task_id parameter which contains the agent ID
    const agentId = (input.task_id as string) || (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }
}
