import type {
  ProviderSubagentLifecycleAdapter,
  ProviderSubagentWaitResult,
  ProviderSubagentWaitStatus,
} from '../../../core/providers/types';
import type { SubagentInfo, ToolCallInfo } from '../../../core/types';

const GROK_SUBAGENT_SPAWN_TOOLS = new Set(['spawn_subagent', 'task']);
const GROK_SUBAGENT_WAIT_TOOLS = new Set([
  'get_command_or_subagent_output',
  'task_output',
  'wait_commands_or_subagents',
  'wait_for_task',
]);
const GROK_SUBAGENT_CLOSE_TOOLS = new Set(['kill_command_or_subagent', 'kill_task']);

interface GrokTaskResult {
  id?: string;
  output?: string;
  state: 'completed' | 'error' | 'running' | 'unknown';
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getRawOutput(toolCall: ToolCallInfo | undefined, raw: string | undefined): unknown {
  return toolCall?.providerPayload?.rawOutput ?? parseJson(raw);
}

function extractTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return firstString(value, ['task_id', 'subagent_id', 'agent_id', 'id']);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (!isRecord(value)) return undefined;

  const direct = firstString(value, ['output', 'text', 'error', 'message', 'result']);
  if (direct) return direct;
  if (value.Result !== undefined) return extractText(value.Result);
  return undefined;
}

function classifyTaskState(value: unknown): GrokTaskResult['state'] {
  if (!isRecord(value)) return 'unknown';
  const status = firstString(value, ['status', 'state', 'type'])?.toLowerCase();
  if (!status) return 'unknown';
  if (/cancel|error|fail|kill/.test(status)) return 'error';
  if (/complete|success|finish|done/.test(status)) return 'completed';
  if (/pending|running|progress|start|timeout/.test(status)) return 'running';
  return 'unknown';
}

function parseTaskResults(value: unknown): GrokTaskResult[] {
  if (Array.isArray(value)) return value.flatMap(parseTaskResults);
  if (!isRecord(value)) return [];
  if (value.Result !== undefined) return parseTaskResults(value.Result);

  const directId = extractTaskId(value);
  if (directId) {
    return [{ id: directId, output: extractText(value), state: classifyTaskState(value) }];
  }

  const keyedResults: GrokTaskResult[] = [];
  for (const [id, child] of Object.entries(value)) {
    if (!isRecord(child)) continue;
    keyedResults.push({
      id,
      output: extractText(child),
      state: classifyTaskState(child),
    });
  }
  return keyedResults;
}

function getTargetIds(toolCall: ToolCallInfo): string[] {
  const result = new Set<string>();
  const singular = toolCall.input.task_id;
  if (typeof singular === 'string' && singular) result.add(singular);
  const plural = toolCall.input.task_ids;
  if (Array.isArray(plural)) {
    for (const value of plural) {
      if (typeof value === 'string' && value) result.add(value);
    }
  }
  return [...result];
}

export function extractGrokSpawnResult(
  raw: string | undefined,
  toolCall?: ToolCallInfo,
): { agentId?: string } {
  const inputId = toolCall && typeof toolCall.input.task_id === 'string'
    ? toolCall.input.task_id
    : undefined;
  const outputId = extractTaskId(getRawOutput(toolCall, raw));
  return { ...(inputId || outputId ? { agentId: inputId || outputId } : {}) };
}

export function extractGrokWaitResult(
  raw: string | undefined,
  toolCall?: ToolCallInfo,
): ProviderSubagentWaitResult {
  const statuses: Record<string, ProviderSubagentWaitStatus> = {};
  const rawOutput = getRawOutput(toolCall, raw);
  const targets = toolCall ? getTargetIds(toolCall) : [];
  const parsedResults = parseTaskResults(rawOutput);
  const renderedText = extractText(rawOutput) ?? (typeof raw === 'string' ? raw.trim() : '');
  const timedOut = isRecord(rawOutput) && rawOutput.timed_out === true
    || /timed?\s*out|still running|in progress/i.test(renderedText);

  for (const result of parsedResults) {
    const id = result.id ?? (targets.length === 1 ? targets[0] : undefined);
    if (!id || result.state === 'running') continue;
    if (result.state === 'error') {
      statuses[id] = { error: result.output || 'Task failed' };
    } else if (result.state === 'completed') {
      statuses[id] = { completed: result.output || 'DONE' };
    }
  }

  if (Object.keys(statuses).length === 0 && targets.length === 1 && !timedOut && renderedText) {
    const id = targets[0];
    if (toolCall?.status === 'error' || /cancel|error|fail|kill/i.test(renderedText)) {
      statuses[id] = { error: renderedText };
    } else {
      statuses[id] = { completed: renderedText };
    }
  }

  return { statuses, timedOut };
}

function isBackgroundSpawn(spawnToolCall: ToolCallInfo): boolean {
  return spawnToolCall.input.run_in_background === true
    || spawnToolCall.input.background === true;
}

function getDescription(spawnToolCall: ToolCallInfo): string {
  if (typeof spawnToolCall.input.description === 'string' && spawnToolCall.input.description.trim()) {
    return spawnToolCall.input.description.trim();
  }
  if (typeof spawnToolCall.input.subagent_type === 'string' && spawnToolCall.input.subagent_type.trim()) {
    return `${spawnToolCall.input.subagent_type.trim()} subagent`;
  }
  return 'Grok subagent';
}

function getPrompt(spawnToolCall: ToolCallInfo): string {
  return typeof spawnToolCall.input.prompt === 'string' ? spawnToolCall.input.prompt : '';
}

function matchesSpawn(lifecycleToolCall: ToolCallInfo, taskId: string | undefined): boolean {
  if (!taskId) return false;
  return getTargetIds(lifecycleToolCall).includes(taskId);
}

export function buildGrokSubagentInfo(
  spawnToolCall: ToolCallInfo,
  siblingToolCalls: ToolCallInfo[] = [],
): SubagentInfo {
  const mode = isBackgroundSpawn(spawnToolCall) ? 'async' : 'sync';
  const launch = extractGrokSpawnResult(spawnToolCall.result, spawnToolCall);
  const base: SubagentInfo = {
    id: spawnToolCall.id,
    description: getDescription(spawnToolCall),
    prompt: getPrompt(spawnToolCall),
    mode,
    isExpanded: false,
    status: 'running',
    toolCalls: [],
    ...(launch.agentId ? { agentId: launch.agentId } : {}),
  };

  if (spawnToolCall.status === 'error') {
    const result = extractText(getRawOutput(spawnToolCall, spawnToolCall.result))
      ?? spawnToolCall.result;
    return {
      ...base,
      ...(mode === 'async' ? { asyncStatus: 'error' as const } : {}),
      result,
      status: 'error',
    };
  }

  if (mode === 'sync') {
    if (spawnToolCall.status !== 'completed') return base;
    return {
      ...base,
      result: extractText(getRawOutput(spawnToolCall, spawnToolCall.result))
        ?? spawnToolCall.result,
      status: 'completed',
    };
  }

  for (const lifecycleToolCall of siblingToolCalls) {
    if (!matchesSpawn(lifecycleToolCall, launch.agentId)) continue;
    const name = normalizedName(lifecycleToolCall.name);
    if (GROK_SUBAGENT_CLOSE_TOOLS.has(name) && lifecycleToolCall.status !== 'running') {
      return {
        ...base,
        asyncStatus: 'error',
        result: extractText(getRawOutput(lifecycleToolCall, lifecycleToolCall.result))
          ?? lifecycleToolCall.result
          ?? 'Task cancelled',
        status: 'error',
      };
    }
    if (!GROK_SUBAGENT_WAIT_TOOLS.has(name) || lifecycleToolCall.status === 'running') continue;

    const waitResult = extractGrokWaitResult(lifecycleToolCall.result, lifecycleToolCall);
    const taskStatus = launch.agentId ? waitResult.statuses[launch.agentId] : undefined;
    if (taskStatus?.completed) {
      return {
        ...base,
        asyncStatus: 'completed',
        result: taskStatus.completed,
        status: 'completed',
      };
    }
    const failure = taskStatus?.error ?? taskStatus?.failed;
    if (failure) {
      return { ...base, asyncStatus: 'error', result: failure, status: 'error' };
    }
  }

  return {
    ...base,
    asyncStatus: launch.agentId ? 'running' : 'pending',
  };
}

export const grokSubagentLifecycleAdapter: ProviderSubagentLifecycleAdapter = {
  isHiddenTool(name) {
    const normalized = normalizedName(name);
    return GROK_SUBAGENT_WAIT_TOOLS.has(normalized)
      || GROK_SUBAGENT_CLOSE_TOOLS.has(normalized);
  },
  isSpawnTool(name) {
    return GROK_SUBAGENT_SPAWN_TOOLS.has(normalizedName(name));
  },
  isWaitTool(name) {
    return GROK_SUBAGENT_WAIT_TOOLS.has(normalizedName(name));
  },
  isCloseTool(name) {
    return GROK_SUBAGENT_CLOSE_TOOLS.has(normalizedName(name));
  },
  resolveSpawnToolIds(lifecycleToolCall, agentIdToSpawnId) {
    const spawnIds = new Set<string>();
    for (const taskId of getTargetIds(lifecycleToolCall)) {
      const spawnId = agentIdToSpawnId.get(taskId);
      if (spawnId) spawnIds.add(spawnId);
    }
    const waitResult = extractGrokWaitResult(lifecycleToolCall.result, lifecycleToolCall);
    for (const taskId of Object.keys(waitResult.statuses)) {
      const spawnId = agentIdToSpawnId.get(taskId);
      if (spawnId) spawnIds.add(spawnId);
    }
    return [...spawnIds];
  },
  buildSubagentInfo: buildGrokSubagentInfo,
  extractSpawnResult: extractGrokSpawnResult,
  extractWaitResult: extractGrokWaitResult,
};
