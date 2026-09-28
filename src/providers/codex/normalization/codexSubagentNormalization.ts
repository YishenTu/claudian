import type { ProviderSubagentLifecycleAdapter } from '../../../core/providers/types';
import {
  TOOL_CLOSE_AGENT,
  TOOL_SPAWN_AGENT,
  TOOL_WAIT,
  TOOL_WAIT_AGENT,
} from '../../../core/tools/toolNames';
import type { SubagentInfo, ToolCallInfo } from '../../../core/types';

interface CodexSpawnResult {
  agentId?: string;
  nickname?: string;
  aliases?: string[];
}

interface CodexWaitStatus {
  completed?: string;
  error?: string;
  failed?: string;
}

interface CodexWaitResult {
  statuses: Record<string, CodexWaitStatus>;
  timedOut: boolean;
}

interface CodexAgentSnapshot {
  agentId: string;
  result?: string;
  status: SubagentInfo['status'];
  unavailable?: boolean;
}

const CODEX_INTERRUPT_AGENT = 'interrupt_agent';
const CODEX_STATUS_TOOLS = new Set([
  TOOL_WAIT, TOOL_WAIT_AGENT, 'list_agents', 'followup_task', 'send_input', 'send_message', 'resume_agent',
]);

function parseJSONObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

export function extractCodexSpawnResult(
  raw: string | undefined,
  toolCall?: ToolCallInfo,
): CodexSpawnResult {
  const parsed = parseJSONObject(raw);
  const inputTaskName = typeof toolCall?.input.task_name === 'string'
    ? toolCall.input.task_name.trim()
    : '';
  const agentId = parsed && typeof parsed.agent_id === 'string'
    ? parsed.agent_id
    : parsed && typeof parsed.task_name === 'string'
      ? parsed.task_name
      : inputTaskName || undefined;
  const nickname = parsed && typeof parsed.nickname === 'string'
    ? parsed.nickname
    : undefined;
  const aliases = [...new Set([parsed?.task_name, inputTaskName]
    .filter((value): value is string => typeof value === 'string' && !!value && value !== agentId))];

  return {
    ...(agentId ? { agentId } : {}),
    ...(nickname ? { nickname } : {}),
    ...(aliases.length ? { aliases } : {}),
  };
}

export function extractCodexWaitResult(raw: string | undefined): CodexWaitResult {
  const parsed = parseJSONObject(raw);
  if (!parsed) {
    return { statuses: {}, timedOut: false };
  }

  const statuses: Record<string, CodexWaitStatus> = {};

  for (const snapshot of extractCodexAgentSnapshots(parsed)) {
    if (snapshot.status === 'completed') {
      statuses[snapshot.agentId] = { completed: snapshot.result || 'DONE' };
    } else if (snapshot.status === 'error') {
      statuses[snapshot.agentId] = { error: snapshot.result || 'Agent stopped' };
    }
  }

  return {
    statuses,
    timedOut: parsed.timed_out === true,
  };
}

function extractCodexAgentSnapshots(parsed: Record<string, unknown>): CodexAgentSnapshot[] {
  const snapshots = (Array.isArray(parsed.agents) ? parsed.agents : []).flatMap((value): CodexAgentSnapshot[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const agent = value as Record<string, unknown>;
    const agentId = firstString(agent, ['agent_name', 'task_name', 'agent_id', 'name']);
    const status = normalizeCodexAgentStatus(agent.agent_status ?? agent.status);
    return agentId && status ? [{ agentId, ...status }] : [];
  });
  if (parsed.status && typeof parsed.status === 'object' && !Array.isArray(parsed.status)) {
    for (const [agentId, value] of Object.entries(parsed.status)) {
      const status = normalizeCodexAgentStatus(value);
      if (status) snapshots.push({ agentId, ...status });
    }
  }
  return snapshots;
}

function normalizeCodexAgentStatus(
  value: unknown,
): Omit<CodexAgentSnapshot, 'agentId'> | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'shutdown') return { status: 'error', result: 'Agent shut down', unavailable: true };
    if (normalized === 'notfound') return { status: 'error', result: 'Agent not found', unavailable: true };
    if (/interrupt|cancel|error|fail|kill/.test(normalized)) {
      return { result: value.trim(), status: 'error' };
    }
    if (/complete|success|finish|done/.test(normalized)) {
      return { result: 'DONE', status: 'completed' };
    }
    if (/pending|running|progress|start|waiting|resumed/.test(normalized)) {
      return { status: 'running' };
    }
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (typeof status.completed === 'string') {
    return { result: status.completed || 'DONE', status: 'completed' };
  }
  const failure = firstString(status, ['error', 'failed', 'interrupted']);
  if (failure) return { result: failure, status: 'error' };

  const state = firstString(status, ['state', 'status']);
  const result = firstString(status, ['output', 'result', 'message']);
  const normalizedState = state ? normalizeCodexAgentStatus(state) : null;
  return normalizedState
    ? { ...normalizedState, ...(result ? { result } : {}) }
    : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function isCodexEncryptedMessage(value: unknown): boolean {
  return typeof value === 'string' && /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(value);
}

function getCodexSubagentPrompt(input: Record<string, unknown>): string {
  const message = typeof input.message === 'string' ? input.message : '';
  return isCodexEncryptedMessage(message) ? '' : message;
}

function getCodexSubagentModel(input: Record<string, unknown>): string {
  return typeof input.model === 'string' ? input.model : '';
}

function getCodexSubagentDescription(
  nickname: string | undefined,
  model: string,
  input: Record<string, unknown>,
): string {
  const role = firstString(input, ['agent_type']);
  const effort = firstString(input, ['reasoning_effort']);
  const label = nickname ?? role ?? 'Codex subagent';
  const details = [nickname ? role : undefined, model, effort].filter(Boolean);
  return details.length ? `${label} (${details.join(', ')})` : label;
}

function resolveCodexWaitCompletion(
  spawnResult: CodexSpawnResult,
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[],
): { status: SubagentInfo['status']; result?: string } {
  const spawnSnapshot = parseJSONObject(spawnToolCall.result);
  let completion: { status: SubagentInfo['status']; result?: string } = spawnSnapshot
    ? findCodexAgentSnapshot(spawnSnapshot, spawnResult)
      ?? { status: 'running' }
    : { status: 'running' };
  const spawnIndex = siblingToolCalls.indexOf(spawnToolCall);
  const followingToolCalls = spawnIndex >= 0
    ? siblingToolCalls.slice(spawnIndex + 1)
    : siblingToolCalls;

  for (const toolCall of followingToolCalls) {
    if (toolCall.status !== 'completed') continue;
    if (isCodexCloseTool(toolCall.name)) {
      if (
        spawnResult.agentId
        && getCodexLifecycleTargetIds(toolCall).some(id => id === spawnResult.agentId || spawnResult.aliases?.includes(id))
        && completion.status === 'running'
      ) {
        const parsed = parseJSONObject(toolCall.result);
        const previous = parsed ? normalizeCodexAgentStatus(parsed.previous_status) : null;
        const snapshot = parsed
          ? findCodexAgentSnapshot(parsed, spawnResult)
          : undefined;
        completion = previous?.status === 'completed' ? previous
          : snapshot && snapshot.status !== 'running' ? snapshot : {
          status: 'error',
          result: 'Agent interrupted',
        };
      }
      continue;
    }

    if (!CODEX_STATUS_TOOLS.has(toolCall.name)) continue;

    const parsed = parseJSONObject(toolCall.result);
    let snapshot: Omit<CodexAgentSnapshot, 'agentId'> | undefined = parsed
      ? findCodexAgentSnapshot(parsed, spawnResult) : undefined;
    if (!snapshot && toolCall.name === 'resume_agent' && spawnResult.agentId
      && getCodexLifecycleTargetIds(toolCall).some(id => id === spawnResult.agentId || spawnResult.aliases?.includes(id))) {
      snapshot = normalizeCodexAgentStatus(parsed?.status) ?? undefined;
    }
    // Disposing a finished agent does not invalidate its answer. A subsequent
    // running snapshot still starts a new cycle and can settle independently.
    if (snapshot && !(completion.status === 'completed' && snapshot.unavailable)) completion = snapshot;
  }

  return completion;
}

function findCodexAgentSnapshot(parsed: Record<string, unknown>, spawn: CodexSpawnResult): CodexAgentSnapshot | undefined {
  const snapshots = extractCodexAgentSnapshots(parsed);
  if (!spawn.agentId) return snapshots.length === 1 ? snapshots[0] : undefined;
  // Named raw snapshots may retain more output than their native thread snapshot.
  for (const id of [...(spawn.aliases ?? []), spawn.agentId]) {
    const snapshot = snapshots.find(agent => agent.agentId === id);
    if (snapshot) return snapshot;
  }
  return undefined;
}

export function buildCodexSubagentInfo(
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[] = [],
): SubagentInfo {
  const prompt = getCodexSubagentPrompt(spawnToolCall.input);
  if (spawnToolCall.subagent?.lifecycleSource === 'session') {
    return prompt ? { ...spawnToolCall.subagent, prompt } : spawnToolCall.subagent;
  }
  const model = getCodexSubagentModel(spawnToolCall.input);
  const spawnResult = extractCodexSpawnResult(spawnToolCall.result, spawnToolCall);
  const taskName = typeof spawnToolCall.input.task_name === 'string'
    ? spawnToolCall.input.task_name
    : undefined;
  const description = getCodexSubagentDescription(spawnResult.nickname ?? taskName ?? spawnResult.aliases?.[0], model, spawnToolCall.input);

  if (spawnToolCall.status === 'error') {
    return {
      id: spawnToolCall.id,
      description,
      prompt,
      mode: 'sync',
      isExpanded: false,
      status: 'error',
      result: spawnToolCall.result,
      toolCalls: [],
    };
  }

  const completion = resolveCodexWaitCompletion(spawnResult, spawnToolCall, siblingToolCalls);

  return {
    id: spawnToolCall.id,
    description,
    prompt,
    mode: 'sync',
    isExpanded: false,
    status: completion.status,
    result: completion.status === 'running' ? undefined : completion.result,
    toolCalls: [],
    ...(spawnResult.agentId ? { agentId: spawnResult.agentId } : {}),
  };
}

export function isCodexSubagentSpawnToolCall(toolCall: ToolCallInfo): boolean {
  return toolCall.name === TOOL_SPAWN_AGENT;
}

function getCodexLifecycleTargetIds(toolCall: ToolCallInfo): string[] {
  const targetIds = new Set(Object.keys(extractCodexWaitResult(toolCall.result).statuses));
  for (const key of ['id', 'target', 'agent_id', 'task_name'] as const) {
    const target = toolCall.input[key];
    if (typeof target === 'string' && target) targetIds.add(target);
  }
  const targets = Array.isArray(toolCall.input.targets)
    ? toolCall.input.targets
    : Array.isArray(toolCall.input.ids)
      ? toolCall.input.ids
      : [];
  for (const target of targets) {
    if (typeof target === 'string') targetIds.add(target);
  }
  const parsed = parseJSONObject(toolCall.result);
  if (parsed) {
    for (const snapshot of extractCodexAgentSnapshots(parsed)) {
      targetIds.add(snapshot.agentId);
    }
  }
  return [...targetIds];
}

function isCodexGlobalWaitToolCall(toolCall: ToolCallInfo): boolean {
  return (toolCall.name === TOOL_WAIT_AGENT || toolCall.name === TOOL_WAIT)
    && !('cell_id' in toolCall.input)
    && getCodexLifecycleTargetIds(toolCall).length === 0;
}

function isCodexCloseTool(name: string): boolean {
  return name === TOOL_CLOSE_AGENT || name === CODEX_INTERRUPT_AGENT;
}

export const codexSubagentLifecycleAdapter: ProviderSubagentLifecycleAdapter = {
  protocol: 'lifecycle',
  isHiddenTool(name: string): boolean {
    return name === TOOL_WAIT || name === TOOL_WAIT_AGENT || isCodexCloseTool(name);
  },
  isToolCallFullyOwned(toolCall, agentIdToSpawnId): boolean {
    if (isCodexGlobalWaitToolCall(toolCall)) {
      return agentIdToSpawnId.size > 0;
    }
    const targetIds = getCodexLifecycleTargetIds(toolCall);
    return targetIds.length > 0 && targetIds.every(targetId => agentIdToSpawnId.has(targetId));
  },
  isSpawnTool(name: string): boolean {
    return name === TOOL_SPAWN_AGENT;
  },
  isWaitTool(name: string): boolean {
    return CODEX_STATUS_TOOLS.has(name);
  },
  isCloseTool(name: string): boolean {
    return isCodexCloseTool(name);
  },
  resolveSpawnToolIds(
    waitToolCall,
    agentIdToSpawnId,
  ): string[] {
    if (isCodexGlobalWaitToolCall(waitToolCall)) {
      return [...new Set(agentIdToSpawnId.values())];
    }
    const spawnIds = new Set<string>();
    for (const targetId of getCodexLifecycleTargetIds(waitToolCall)) {
      const spawnId = agentIdToSpawnId.get(targetId);
      if (spawnId) {
        spawnIds.add(spawnId);
      }
    }

    return [...spawnIds];
  },
  buildSubagentInfo(spawnToolCall, siblingToolCalls = []): SubagentInfo {
    return buildCodexSubagentInfo(spawnToolCall, siblingToolCalls);
  },
  getProgress(spawnToolCall, siblingToolCalls) {
    const completion = resolveCodexWaitCompletion(
      extractCodexSpawnResult(spawnToolCall.result, spawnToolCall), spawnToolCall, siblingToolCalls,
    );
    return completion.status === 'running' && completion.result
      ? { toolCallId: spawnToolCall.id, summary: completion.result } : undefined;
  },
  extractSpawnResult(raw: string | undefined, toolCall?: ToolCallInfo) {
    return extractCodexSpawnResult(raw, toolCall);
  },
  extractWaitResult(raw: string | undefined) {
    return extractCodexWaitResult(raw);
  },
};
