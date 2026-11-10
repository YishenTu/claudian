import { extractToolResultContent } from '@/core/tools/toolResultContent';
import type { SubagentInfo, ToolCallInfo } from '@/core/types';

/**
 * Builds the subagent shown for a stored managed-agent spawn tool, preferring
 * its linked subagent and otherwise inferring one from the raw tool call.
 */
export function resolveStoredTaskSubagent(toolCall: ToolCallInfo, modeHint?: 'sync' | 'async'): SubagentInfo {
  if (toolCall.subagent) {
    if (!modeHint || toolCall.subagent.mode === modeHint) {
      return toolCall.subagent;
    }
    return {
      ...toolCall.subagent,
      mode: modeHint,
    };
  }

  const description = (toolCall.input?.description as string) || 'Subagent task';
  const prompt = (toolCall.input?.prompt as string) || '';
  const mode = modeHint ?? (toolCall.input?.run_in_background === true ? 'async' : 'sync');

  if (mode !== 'async') {
    return {
      id: toolCall.id,
      description,
      prompt,
      status: mapToolStatusToSubagentStatus(toolCall.status),
      toolCalls: [],
      isExpanded: false,
      result: toolCall.result,
    };
  }

  const asyncStatus = inferAsyncStatusFromTaskTool(toolCall);
  return {
    id: toolCall.id,
    description,
    prompt,
    mode: 'async',
    status: asyncStatus,
    asyncStatus,
    toolCalls: [],
    isExpanded: false,
    result: toolCall.result,
  };
}

function mapToolStatusToSubagentStatus(
  status: ToolCallInfo['status']
): 'completed' | 'error' | 'running' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'blocked':
      return 'error';
    default:
      return 'running';
  }
}

function inferAsyncStatusFromTaskTool(toolCall: ToolCallInfo): 'running' | 'completed' | 'error' {
  if (toolCall.status === 'error' || toolCall.status === 'blocked') return 'error';
  if (toolCall.status === 'running') return 'running';

  const lowerResult = extractToolResultContent(toolCall.result, { fallbackIndent: 2 }).toLowerCase();
  if (
    lowerResult.includes('not_ready') ||
    lowerResult.includes('not ready') ||
    lowerResult.includes('"status":"running"') ||
    lowerResult.includes('"status":"pending"') ||
    lowerResult.includes('"retrieval_status":"running"') ||
    lowerResult.includes('"retrieval_status":"not_ready"')
  ) {
    return 'running';
  }

  return 'completed';
}
