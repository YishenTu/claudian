import type { SubagentInfo, ToolCallInfo } from '../../../core/types';
import type { AsyncSubagentResult, ResolvedAsyncStatus } from './sdkHistoryTypes';

export function extractAgentIdFromToolUseResult(toolUseResult: unknown): string | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') {
    return null;
  }

  const record = toolUseResult as Record<string, unknown>;
  const directAgentId = record.agentId ?? record.agent_id;
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

  return null;
}

export function resolveToolUseResultStatus(
  toolUseResult: unknown,
  fallbackStatus: ResolvedAsyncStatus,
): ResolvedAsyncStatus {
  if (!toolUseResult || typeof toolUseResult !== 'object') {
    return fallbackStatus;
  }

  const record = toolUseResult as Record<string, unknown>;
  const rawStatus = record.retrieval_status ?? record.status;
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';

  if (status === 'error' || status === 'failed' || status === 'stopped' || status === 'killed') {
    return 'error';
  }
  if (status === 'completed' || status === 'success') {
    return 'completed';
  }
  if (record.isAsync === true || status === 'async_launched') {
    return 'running';
  }

  return fallbackStatus;
}

export function buildAsyncSubagentInfo(
  toolCall: ToolCallInfo,
  toolUseResult: unknown,
  asyncResults: Map<string, AsyncSubagentResult>,
): SubagentInfo | null {
  const agentId = extractAgentIdFromToolUseResult(toolUseResult);
  if (!agentId) {
    return null;
  }

  const queueResult = asyncResults.get(agentId);
  const description = (toolCall.input?.description as string) || 'Background task';
  const prompt = (toolCall.input?.prompt as string) || '';
  const finalResult = queueResult?.result ?? toolCall.result;

  let toolCallFallback: ResolvedAsyncStatus = 'running';
  if (toolCall.status === 'error') {
    toolCallFallback = 'error';
  } else if (toolCall.status === 'completed') {
    toolCallFallback = 'completed';
  }

  const status = queueResult
    ? resolveToolUseResultStatus({ status: queueResult.status }, 'completed')
    : resolveToolUseResultStatus(toolUseResult, toolCallFallback);

  const taskStatus = status === 'orphaned' ? 'error' : status;

  return {
    id: toolCall.id,
    description,
    prompt,
    mode: 'async',
    isExpanded: false,
    status: taskStatus,
    toolCalls: [],
    asyncStatus: status,
    agentId,
    result: finalResult,
  };
}
