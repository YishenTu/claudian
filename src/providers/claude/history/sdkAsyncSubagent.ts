import type { AgentOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';

import type { SubagentInfo, ToolCallInfo } from '../../../core/types';
import type { AsyncSubagentResult, ResolvedAsyncStatus } from './sdkHistoryTypes';

type CompletedAgentOutput = Extract<AgentOutput, { status: 'completed' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Completed Agent/Task `toolUseResult`. The SDK documents `content` as the subagent's final report
 * without the model-directed agentId/usage trailer. Older transcripts may omit run totals, so only
 * the report array is required.
 */
export function hasAgentOutputReport(
  toolUseResult: unknown,
): toolUseResult is Pick<CompletedAgentOutput, 'content'> & Partial<Omit<CompletedAgentOutput, 'content'>> {
  return isRecord(toolUseResult) && Array.isArray(toolUseResult.content);
}

/** Native `AgentOutput.agentId`, then the TaskOutput-era `agent_id` and `data` nesting kept for old transcripts. */
export function extractAgentIdFromToolUseResult(toolUseResult: unknown): string | null {
  if (!isRecord(toolUseResult)) return null;
  const readId = (record: Record<string, unknown>): string | null => {
    const id = record.agentId ?? record.agent_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  };
  return readId(toolUseResult) ?? (isRecord(toolUseResult.data) ? readId(toolUseResult.data) : null);
}

/** `AgentOutput.status`, plus the TaskOutput-era `retrieval_status` alias kept for old transcripts. */
export function resolveToolUseResultStatus(
  toolUseResult: unknown,
  fallbackStatus: ResolvedAsyncStatus,
): ResolvedAsyncStatus {
  if (!isRecord(toolUseResult)) {
    return fallbackStatus;
  }

  const rawStatus = toolUseResult.retrieval_status ?? toolUseResult.status;
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';

  if (status === 'error' || status === 'failed' || status === 'stopped' || status === 'killed') {
    return 'error';
  }
  if (status === 'completed' || status === 'success') {
    return 'completed';
  }
  if (toolUseResult.isAsync === true || status === 'async_launched') {
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
