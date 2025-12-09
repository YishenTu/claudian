/**
 * AsyncSubagentManager - Manages async subagent lifecycle and state transitions
 *
 * Async subagents (run_in_background=true) use a two-tool transaction model:
 * 1. Task tool_use → creates pending async subagent
 * 2. Task tool_result → extracts agent_id, transitions to running
 * 3. SubagentStop hook (optional) → transitions to awaiting_result
 * 4. AgentOutputTool tool_result → finalizes with completed/error
 * 5. Conversation end → orphans any active async subagents
 */

import {
  SubagentInfo,
  SubagentMode,
  AsyncSubagentStatus,
  ToolCallInfo,
} from './types';

/**
 * Callback for UI state updates when async subagent state changes
 */
export type AsyncSubagentStateChangeCallback = (subagent: SubagentInfo) => void;

/**
 * Manages async subagent lifecycle and state transitions
 */
export class AsyncSubagentManager {
  // Active async subagents indexed by agent_id (after Task result parsed)
  private activeAsyncSubagents: Map<string, SubagentInfo> = new Map();

  // Pending async subagents indexed by task_tool_use_id (before agent_id known)
  private pendingAsyncSubagents: Map<string, SubagentInfo> = new Map();

  // Map task_tool_use_id -> agent_id for lookups
  private taskIdToAgentId: Map<string, string> = new Map();

  // Map AgentOutputTool tool_use_id -> agent_id for result routing
  private outputToolIdToAgentId: Map<string, string> = new Map();

  // Callback for UI updates
  private onStateChange: AsyncSubagentStateChangeCallback;

  constructor(onStateChange: AsyncSubagentStateChangeCallback) {
    this.onStateChange = onStateChange;
  }

  // =========================================================================
  // Lifecycle Handlers
  // =========================================================================

  /**
   * Check if a Task tool input indicates async mode
   */
  public isAsyncTask(taskInput: Record<string, unknown>): boolean {
    return taskInput.run_in_background === true;
  }

  /**
   * Create an async subagent in pending state
   * Called when Task tool_use with run_in_background=true is detected
   */
  public createAsyncSubagent(
    taskToolId: string,
    taskInput: Record<string, unknown>
  ): SubagentInfo {
    const description =
      (taskInput.description as string) || 'Background task';

    const subagent: SubagentInfo = {
      id: taskToolId,
      description,
      mode: 'async' as SubagentMode,
      isExpanded: false, // Collapsed by default for async
      status: 'running', // Sync status (for backward compat)
      toolCalls: [], // Empty for async (no nested tool tracking)
      asyncStatus: 'pending',
    };

    // Store in pending map until we get agent_id from result
    this.pendingAsyncSubagents.set(taskToolId, subagent);

    return subagent;
  }

  /**
   * Handle Task tool_result to extract agent_id
   * Transitions: pending → running (or error if isError=true or parsing fails)
   */
  public handleTaskToolResult(taskToolId: string, result: string, isError?: boolean): void {
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) {
      console.warn(
        `handleTaskToolResult: Unknown task ${taskToolId}`
      );
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
      // Failed to parse - transition to error
      subagent.asyncStatus = 'error';
      subagent.status = 'error';
      // Include truncated result for debugging
      const truncatedResult = result.length > 100 ? result.substring(0, 100) + '...' : result;
      subagent.result = `Failed to parse agent_id. Result: ${truncatedResult}`;
      subagent.completedAt = Date.now();
      this.pendingAsyncSubagents.delete(taskToolId);
      this.onStateChange(subagent);
      return;
    }

    // Transition to running
    subagent.asyncStatus = 'running';
    subagent.agentId = agentId;
    subagent.startedAt = Date.now();

    // Move from pending to active map
    this.pendingAsyncSubagents.delete(taskToolId);
    this.activeAsyncSubagents.set(agentId, subagent);
    this.taskIdToAgentId.set(taskToolId, agentId);

    this.onStateChange(subagent);
  }

  /**
   * Handle SubagentStop hook callback
   * Transitions: running → awaiting_result
   */
  public handleSubagentStopHook(agentId: string): void {
    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent) {
      // Could be a sync subagent or unknown
      return;
    }

    if (subagent.asyncStatus !== 'running') {
      console.warn(
        `handleSubagentStopHook: Invalid transition ${subagent.asyncStatus} → awaiting_result`
      );
      return;
    }

    subagent.asyncStatus = 'awaiting_result';
    this.onStateChange(subagent);
  }

  /**
   * Handle AgentOutputTool tool_use
   * Links the output tool to the async subagent for result routing
   */
  public handleAgentOutputToolUse(toolCall: ToolCallInfo): void {
    const agentId = this.extractAgentIdFromInput(toolCall.input);
    if (!agentId) {
      console.warn('AgentOutputTool called without agentId');
      return;
    }

    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent) {
      console.warn(`AgentOutputTool for unknown agent: ${agentId}`);
      return;
    }

    // Store mapping for result routing
    subagent.outputToolId = toolCall.id;
    this.outputToolIdToAgentId.set(toolCall.id, agentId);
  }

  /**
   * Handle AgentOutputTool tool_result
   * Transitions: {running, awaiting_result} → {completed, error} (only if task is done)
   */
  public handleAgentOutputToolResult(
    toolId: string,
    result: string,
    isError: boolean
  ): SubagentInfo | undefined {
    let agentId = this.outputToolIdToAgentId.get(toolId);
    let subagent = agentId ? this.activeAsyncSubagents.get(agentId) : undefined;

    // Fallback: try to infer agent_id from result payload (if tool_use was missed)
    if (!subagent) {
      const inferredAgentId = this.inferAgentIdFromResult(result);
      if (inferredAgentId) {
        agentId = inferredAgentId;
        subagent = this.activeAsyncSubagents.get(inferredAgentId);
      }
    }

    // Fallback: if exactly one active async subagent, assume it's for that one
    if (!subagent && this.activeAsyncSubagents.size === 1) {
      subagent = Array.from(this.activeAsyncSubagents.values())[0];
      agentId = subagent.agentId || agentId;
    }

    if (!subagent) {
      return undefined;
    }

    // If we inferred agentId, remember mapping for future results
    if (agentId) {
      subagent.agentId = subagent.agentId || agentId;
      this.outputToolIdToAgentId.set(toolId, agentId);
    }

    const validStates: AsyncSubagentStatus[] = ['running', 'awaiting_result'];
    if (!validStates.includes(subagent.asyncStatus!)) {
      console.warn(
        `handleAgentOutputToolResult: Invalid transition ${subagent.asyncStatus} → final`
      );
      return undefined;
    }

    // Check if the task is still running (block=false returns status, not result)
    // Common patterns for "still running": empty result, status indicators, etc.
    const stillRunning = this.isStillRunningResult(result, isError);

    console.log('[AsyncSubagentManager] AgentOutputTool result:', {
      agentId,
      result: result.substring(0, 100),
      isError,
      stillRunning,
    });

    if (stillRunning) {
      // Task not done yet - don't change state, just clear the tool mapping
      // so next AgentOutputTool call can be linked
      this.outputToolIdToAgentId.delete(toolId);
      return undefined;
    }

    // Extract the actual result content from the response
    const extractedResult = this.extractAgentResult(result, agentId);

    // Transition to final state
    subagent.asyncStatus = isError ? 'error' : 'completed';
    subagent.status = isError ? 'error' : 'completed';
    subagent.result = extractedResult;
    subagent.completedAt = Date.now();

    // Cleanup tracking
    this.activeAsyncSubagents.delete(agentId);
    this.outputToolIdToAgentId.delete(toolId);
    // Keep taskIdToAgentId for history lookups

    this.onStateChange(subagent);
    return subagent;
  }

  /**
   * Check if AgentOutputTool result indicates task is still running
   *
   * SDK returns:
   * - Still running: { "retrieval_status": "not_ready", "agents": {} }
   * - Completed: { "retrieval_status": "success", "agents": { "id": { "status": "completed", "result": "..." } } }
   */
  private isStillRunningResult(result: string, isError: boolean): boolean {
    console.log('[AsyncSubagentManager] isStillRunningResult input:', {
      result: result?.substring(0, 200),
      isError,
    });

    const trimmed = result?.trim() || '';

    // Attempt to unwrap common AgentOutputTool envelope: { type: 'text', text: 'json...' } or [ { ... } ]
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

    // If it's an error, task is done (with error)
    if (isError) {
      console.log('[AsyncSubagentManager] isError=true, returning false (done)');
      return false;
    }

    // Empty/whitespace result - treat as done (avoid blocking forever on blank)
    if (!trimmed) {
      console.log('[AsyncSubagentManager] Empty result, returning false (done)');
      return false;
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(payload);
      console.log('[AsyncSubagentManager] Parsed JSON:', {
        retrieval_status: parsed.retrieval_status,
        agentsKeys: parsed.agents ? Object.keys(parsed.agents) : 'no agents field',
      });

      const status = parsed.retrieval_status || parsed.status;
      const hasAgents = parsed.agents && Object.keys(parsed.agents).length > 0;

      // Explicit not-ready signals
      if (status === 'not_ready' || status === 'running' || status === 'pending') {
        console.log('[AsyncSubagentManager] retrieval_status indicates not ready, returning true (still running)');
        return true;
      }

      // If agents exist, consider it done unless they explicitly say running
      if (hasAgents) {
        // Check if any agent reports running/pending
        const agentStatuses = Object.values(parsed.agents as Record<string, any>)
          .map((a: any) => (a && typeof a.status === 'string') ? a.status.toLowerCase() : '');
        const anyRunning = agentStatuses.some(s =>
          s === 'running' || s === 'pending' || s === 'not_ready'
        );
        if (anyRunning) {
          console.log('[AsyncSubagentManager] Agent status indicates running, returning true (still running)');
          return true;
        }
        console.log('[AsyncSubagentManager] Agents present and not running, returning false (done)');
        return false;
      }

      // Explicit success
      if (status === 'success' || status === 'completed') {
        console.log('[AsyncSubagentManager] retrieval_status success/completed, returning false (done)');
        return false;
      }

      // Unknown structure but non-empty -> assume done to avoid stuck UI
      console.log('[AsyncSubagentManager] Unknown JSON format with data, returning false (done)');
      return false;
    } catch (e) {
      console.log('[AsyncSubagentManager] JSON parse failed:', e);
    }

    // String matching fallback
    const lowerResult = payload.toLowerCase();

    // Explicit not-ready phrases
    if (lowerResult.includes('not_ready') || lowerResult.includes('not ready')) {
      console.log('[AsyncSubagentManager] Found not_ready indicator in string, returning true (still running)');
      return true;
    }

    // Default: assume done unless explicitly told otherwise
    console.log('[AsyncSubagentManager] No not_ready indicator, returning false (done)');
    return false;
  }

  /**
   * Extract the actual result content from AgentOutputTool response
   *
   * SDK returns: { "agents": { "id": { "result": "actual content" } } }
   */
  private extractAgentResult(result: string, agentId: string): string {
    // Try to unwrap envelope: {text: "...json..."} or [ { text: "..."} ]
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

  /**
   * Orphan all active async subagents (on conversation end)
   * Transitions: {pending, running, awaiting_result} → orphaned
   */
  public orphanAllActive(): SubagentInfo[] {
    const orphaned: SubagentInfo[] = [];

    // Orphan pending subagents
    for (const subagent of this.pendingAsyncSubagents.values()) {
      subagent.asyncStatus = 'orphaned';
      subagent.status = 'error';
      subagent.result = 'Conversation ended before task completed';
      subagent.completedAt = Date.now();
      orphaned.push(subagent);
      this.onStateChange(subagent);
    }

    // Orphan active subagents
    for (const subagent of this.activeAsyncSubagents.values()) {
      if (
        subagent.asyncStatus === 'running' ||
        subagent.asyncStatus === 'awaiting_result'
      ) {
        subagent.asyncStatus = 'orphaned';
        subagent.status = 'error';
        subagent.result = 'Conversation ended before task completed';
        subagent.completedAt = Date.now();
        orphaned.push(subagent);
        this.onStateChange(subagent);
      }
    }

    // Clear all tracking
    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.outputToolIdToAgentId.clear();
    // Keep taskIdToAgentId for history

    return orphaned;
  }

  /**
   * Clear all state (for new conversation)
   */
  public clear(): void {
    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();
  }

  // =========================================================================
  // State Queries
  // =========================================================================

  /**
   * Get async subagent by agent_id
   */
  public getByAgentId(agentId: string): SubagentInfo | undefined {
    return this.activeAsyncSubagents.get(agentId);
  }

  /**
   * Get async subagent by task tool_use_id
   */
  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    // Check pending first
    const pending = this.pendingAsyncSubagents.get(taskToolId);
    if (pending) return pending;

    // Then check active via mapping
    const agentId = this.taskIdToAgentId.get(taskToolId);
    if (agentId) {
      return this.activeAsyncSubagents.get(agentId);
    }

    return undefined;
  }

  /**
   * Check if a task tool_id is a pending async subagent
   */
  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.pendingAsyncSubagents.has(taskToolId);
  }

  /**
   * Check if a tool_id is an AgentOutputTool linked to an async subagent
   */
  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolIdToAgentId.has(toolId);
  }

  /**
   * Get all active async subagents
   */
  public getAllActive(): SubagentInfo[] {
    return [
      ...this.pendingAsyncSubagents.values(),
      ...this.activeAsyncSubagents.values(),
    ];
  }

  /**
   * Check if there are any active async subagents
   */
  public hasActiveAsync(): boolean {
    return (
      this.pendingAsyncSubagents.size > 0 ||
      this.activeAsyncSubagents.size > 0
    );
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  /**
   * Parse agent_id from Task tool_result
   * SDK returns JSON with agent_id field (snake_case)
   */
  private parseAgentId(result: string): string | null {
    console.log('[AsyncSubagentManager] Parsing Task result:', result);

    // Try regex extraction first (works for both JSON and plain text)
    // Matches: "agent_id": "xxx", agent_id: xxx, agent_id=xxx, etc.
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
        console.log('[AsyncSubagentManager] Found agent_id via regex:', match[1]);
        return match[1];
      }
    }

    // Try parsing as JSON
    try {
      const parsed = JSON.parse(result);
      console.log('[AsyncSubagentManager] Parsed JSON:', parsed);

      // Handle both snake_case (SDK standard) and camelCase
      const agentId = parsed.agent_id || parsed.agentId;

      if (typeof agentId === 'string' && agentId.length > 0) {
        console.log('[AsyncSubagentManager] Found agent_id in JSON:', agentId);
        return agentId;
      }

      // Check if result is nested
      if (parsed.data?.agent_id) {
        console.log('[AsyncSubagentManager] Found nested agent_id:', parsed.data.agent_id);
        return parsed.data.agent_id;
      }

      // Check for id field as fallback
      if (parsed.id && typeof parsed.id === 'string') {
        console.log('[AsyncSubagentManager] Using id field as agent_id:', parsed.id);
        return parsed.id;
      }

      console.warn('[AsyncSubagentManager] No agent_id field in parsed result:', parsed);
    } catch {
      console.log('[AsyncSubagentManager] Result is not JSON');
    }

    console.warn('[AsyncSubagentManager] Failed to extract agent_id from:', result);
    return null;
  }

  /**
   * Infer agent_id from AgentOutputTool result payload
   */
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
      // Not JSON, ignore
    }
    return null;
  }

  /**
   * Extract agentId from AgentOutputTool input
   */
  private extractAgentIdFromInput(
    input: Record<string, unknown>
  ): string | null {
    // Handle both snake_case and camelCase
    const agentId = (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }
}
