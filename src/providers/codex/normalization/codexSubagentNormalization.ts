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

export function extractCodexSpawnResult(raw: string | undefined): CodexSpawnResult {
  const parsed = parseJsonObject(raw);
  if (!parsed) return {};

  return {
    agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : undefined,
    nickname: typeof parsed.nickname === 'string' ? parsed.nickname : undefined,
  };
}

export function extractCodexWaitResult(raw: string | undefined): CodexWaitResult {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return { statuses: {}, timedOut: false };
  }

  const rawStatuses = parsed.status;
  const statuses: Record<string, CodexWaitStatus> = {};

  if (rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)) {
    for (const [agentId, value] of Object.entries(rawStatuses as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const status = value as Record<string, unknown>;
      statuses[agentId] = {
        completed: typeof status.completed === 'string' ? status.completed : undefined,
        error: typeof status.error === 'string' ? status.error : undefined,
        failed: typeof status.failed === 'string' ? status.failed : undefined,
      };
    }
  }

  return {
    statuses,
    timedOut: parsed.timed_out === true,
  };
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
  siblingToolCalls: ToolCallInfo[],
): { status: SubagentInfo['status']; result?: string } {
  for (const toolCall of siblingToolCalls) {
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
      return { status: 'completed', result: agentStatus.completed };
    }

    const failure = agentStatus?.error ?? agentStatus?.failed;
    if (failure) {
      return { status: 'error', result: failure };
    }

    if (waitResult.timedOut) {
      return { status: 'error', result: 'Timed out' };
    }
  }

  return { status: 'running' };
}

export function buildCodexSubagentInfo(
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[] = [],
): SubagentInfo {
  const prompt = getCodexSubagentPrompt(spawnToolCall.input);
  const model = getCodexSubagentModel(spawnToolCall.input);
  const spawnResult = extractCodexSpawnResult(spawnToolCall.result);
  const description = getCodexSubagentDescription(spawnResult.nickname, model);

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

  const completion = resolveCodexWaitCompletion(spawnResult, siblingToolCalls);

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

export const codexSubagentLifecycleAdapter: ProviderSubagentLifecycleAdapter = {
  isHiddenTool(name: string): boolean {
    return name === TOOL_WAIT || name === TOOL_WAIT_AGENT || name === TOOL_CLOSE_AGENT;
  },
  isSpawnTool(name: string): boolean {
    return name === TOOL_SPAWN_AGENT;
  },
  isWaitTool(name: string): boolean {
    return name === TOOL_WAIT || name === TOOL_WAIT_AGENT;
  },
  isCloseTool(name: string): boolean {
    return name === TOOL_CLOSE_AGENT;
  },
  resolveSpawnToolIds(
    waitToolCall,
    agentIdToSpawnId,
  ): string[] {
    const spawnIds = new Set<string>();
    const waitResult = extractCodexWaitResult(waitToolCall.result);

    for (const agentId of Object.keys(waitResult.statuses)) {
      const spawnId = agentIdToSpawnId.get(agentId);
      if (spawnId) {
        spawnIds.add(spawnId);
      }
    }

    const targets = Array.isArray(waitToolCall.input.targets)
      ? waitToolCall.input.targets
      : Array.isArray(waitToolCall.input.ids)
        ? waitToolCall.input.ids
        : [];
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const spawnId = agentIdToSpawnId.get(target);
      if (spawnId) {
        spawnIds.add(spawnId);
      }
    }

    return [...spawnIds];
  },
  buildSubagentInfo(spawnToolCall, siblingToolCalls = []): SubagentInfo {
    return buildCodexSubagentInfo(spawnToolCall, siblingToolCalls);
  },
  extractSpawnResult(raw: string | undefined) {
    return extractCodexSpawnResult(raw);
  },
  extractWaitResult(raw: string | undefined) {
    return extractCodexWaitResult(raw);
  },
};
