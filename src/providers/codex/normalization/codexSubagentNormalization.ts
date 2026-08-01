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
}

const CODEX_LIST_AGENTS = 'list_agents';
const CODEX_INTERRUPT_AGENT = 'interrupt_agent';

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
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
  const parsed = parseJsonObject(raw);
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

  return {
    ...(agentId ? { agentId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

export function extractCodexWaitResult(raw: string | undefined): CodexWaitResult {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return { statuses: {}, timedOut: false };
  }

  const rawStatuses = parsed.status;
  const statuses: Record<string, CodexWaitStatus> = {};

  for (const snapshot of extractCodexAgentSnapshots(parsed)) {
    if (snapshot.status === 'completed') {
      statuses[snapshot.agentId] = { completed: snapshot.result || 'DONE' };
    } else if (snapshot.status === 'error') {
      statuses[snapshot.agentId] = { error: snapshot.result || 'Agent stopped' };
    }
  }

  if (rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)) {
    for (const [agentId, value] of Object.entries(rawStatuses as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const status = value as Record<string, unknown>;
      const normalized = normalizeCodexAgentStatus(status);
      if (normalized?.status === 'completed') {
        statuses[agentId] = { completed: normalized.result || 'DONE' };
      } else if (normalized?.status === 'error') {
        statuses[agentId] = { error: normalized.result || 'Agent stopped' };
      }
    }
  }

  return {
    statuses,
    timedOut: parsed.timed_out === true,
  };
}

function extractCodexAgentSnapshots(parsed: Record<string, unknown>): CodexAgentSnapshot[] {
  if (!Array.isArray(parsed.agents)) return [];

  return parsed.agents.flatMap((value): CodexAgentSnapshot[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const agent = value as Record<string, unknown>;
    const agentId = firstString(agent, ['agent_name', 'task_name', 'agent_id', 'name']);
    const status = normalizeCodexAgentStatus(agent.agent_status ?? agent.status);
    return agentId && status ? [{ agentId, ...status }] : [];
  });
}

function normalizeCodexAgentStatus(
  value: unknown,
): Omit<CodexAgentSnapshot, 'agentId'> | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (/interrupt|cancel|error|fail|kill/.test(normalized)) {
      return { result: value.trim(), status: 'error' };
    }
    if (/complete|success|finish|done/.test(normalized)) {
      return { result: 'DONE', status: 'completed' };
    }
    if (/pending|running|progress|start|waiting/.test(normalized)) {
      return { status: 'running' };
    }
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  const completed = firstString(status, ['completed']);
  if (completed) return { result: completed, status: 'completed' };
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

function getCodexSubagentPrompt(input: Record<string, unknown>): string {
  return typeof input.message === 'string' ? input.message : '';
}

function getCodexSubagentModel(input: Record<string, unknown>): string {
  return typeof input.model === 'string' ? input.model : '';
}

function getCodexSubagentDescription(
  nickname: string | undefined,
  model: string,
): string {
  if (nickname && model) return `${nickname} (${model})`;
  if (nickname) return nickname;
  if (model) return `Codex subagent (${model})`;
  return 'Codex subagent';
}

function resolveCodexWaitCompletion(
  spawnResult: CodexSpawnResult,
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[],
): { status: SubagentInfo['status']; result?: string } {
  let completion: { status: SubagentInfo['status']; result?: string } = { status: 'running' };
  const spawnIndex = siblingToolCalls.indexOf(spawnToolCall);
  const followingToolCalls = spawnIndex >= 0
    ? siblingToolCalls.slice(spawnIndex + 1)
    : siblingToolCalls;

  for (const toolCall of followingToolCalls) {
    if (toolCall.name === CODEX_LIST_AGENTS && spawnResult.agentId) {
      const parsed = parseJsonObject(toolCall.result);
      const snapshot = parsed
        ? extractCodexAgentSnapshots(parsed).find(agent => agent.agentId === spawnResult.agentId)
        : undefined;
      if (snapshot) {
        completion = {
          status: snapshot.status,
          ...(snapshot.result ? { result: snapshot.result } : {}),
        };
      }
      continue;
    }

    if (isCodexCloseTool(toolCall.name)) {
      if (
        spawnResult.agentId
        && getCodexLifecycleTargetIds(toolCall).includes(spawnResult.agentId)
        && toolCall.status !== 'running'
      ) {
        completion = {
          status: 'error',
          result: toolCall.result || 'Agent interrupted',
        };
      }
      continue;
    }

    if (toolCall.name !== TOOL_WAIT && toolCall.name !== TOOL_WAIT_AGENT) {
      continue;
    }

    const waitResult = extractCodexWaitResult(toolCall.result);
    const statusEntries = Object.entries(waitResult.statuses);
    if (statusEntries.length === 0 && !waitResult.timedOut) {
      continue;
    }

    let agentStatus: CodexWaitStatus | undefined;
    if (spawnResult.agentId) {
      agentStatus = waitResult.statuses[spawnResult.agentId];
    } else if (statusEntries.length === 1) {
      agentStatus = statusEntries[0][1];
    }

    if (agentStatus?.completed) {
      completion = { status: 'completed', result: agentStatus.completed };
      continue;
    }

    const failure = agentStatus?.error ?? agentStatus?.failed;
    if (failure) {
      completion = { status: 'error', result: failure };
    }
  }

  return completion;
}

export function buildCodexSubagentInfo(
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[] = [],
): SubagentInfo {
  const prompt = getCodexSubagentPrompt(spawnToolCall.input);
  const model = getCodexSubagentModel(spawnToolCall.input);
  const spawnResult = extractCodexSpawnResult(spawnToolCall.result, spawnToolCall);
  const taskName = typeof spawnToolCall.input.task_name === 'string'
    ? spawnToolCall.input.task_name
    : undefined;
  const description = getCodexSubagentDescription(spawnResult.nickname ?? taskName, model);

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
    result: completion.result,
    toolCalls: [],
    ...(spawnResult.agentId ? { agentId: spawnResult.agentId } : {}),
  };
}

export function isCodexSubagentSpawnToolCall(toolCall: ToolCallInfo): boolean {
  return toolCall.name === TOOL_SPAWN_AGENT;
}

function getCodexLifecycleTargetIds(toolCall: ToolCallInfo): string[] {
  const targetIds = new Set(Object.keys(extractCodexWaitResult(toolCall.result).statuses));
  for (const key of ['target', 'agent_id', 'task_name'] as const) {
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
  const parsed = parseJsonObject(toolCall.result);
  if (parsed) {
    for (const snapshot of extractCodexAgentSnapshots(parsed)) {
      targetIds.add(snapshot.agentId);
    }
  }
  return [...targetIds];
}

function isCodexGlobalWaitToolCall(toolCall: ToolCallInfo): boolean {
  return toolCall.name === TOOL_WAIT_AGENT
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
    return name === TOOL_WAIT || name === TOOL_WAIT_AGENT || name === CODEX_LIST_AGENTS;
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
  extractSpawnResult(raw: string | undefined, toolCall?: ToolCallInfo) {
    return extractCodexSpawnResult(raw, toolCall);
  },
  extractWaitResult(raw: string | undefined) {
    return extractCodexWaitResult(raw);
  },
};
