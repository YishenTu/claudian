import type {
  ProviderTaskResultInterpreter,
  ProviderTaskTerminalStatus,
} from '../../../core/providers/types';
import {
  extractAgentIdFromToolUseResult,
  extractXmlTag,
  resolveToolUseResultStatus,
} from '../history/ClaudeHistoryStore';

function extractAgentIdFromString(value: string): string | null {
  const regexPatterns = [
    /"agent_id"\s*:\s*"([^"]+)"/,
    /"agentId"\s*:\s*"([^"]+)"/,
    /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
    /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
  ];

  for (const pattern of regexPatterns) {
    const match = value.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function extractResultFromTaskObject(task: unknown): string | null {
  if (!task || typeof task !== 'object') {
    return null;
  }

  const record = task as Record<string, unknown>;
  const result = typeof record.result === 'string' ? record.result.trim() : '';
  if (result.length > 0) {
    return result;
  }

  const output = typeof record.output === 'string' ? record.output.trim() : '';
  return output.length > 0 ? output : null;
}

function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const firstTextBlock = (content as Array<Record<string, unknown>>)
    .find(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
  if (!firstTextBlock || typeof firstTextBlock.text !== 'string') {
    return null;
  }

  const text = firstTextBlock.text.trim();
  return text.length > 0 ? text : null;
}

export class ClaudeTaskResultInterpreter implements ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(toolUseResult: unknown): boolean {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return false;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (record.isAsync === true) {
      return true;
    }

    if (this.extractAgentId(toolUseResult)) {
      return true;
    }

    const rawStatus = record.retrieval_status ?? record.status;
    if (typeof rawStatus === 'string' && rawStatus.toLowerCase() === 'async_launched') {
      return true;
    }

    return typeof record.outputFile === 'string' && record.outputFile.length > 0;
  }

  extractAgentId(toolUseResult: unknown): string | null {
    const directId = extractAgentIdFromToolUseResult(toolUseResult);
    if (directId) {
      return directId;
    }

    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (typeof block === 'string') {
          const extracted = extractAgentIdFromString(block);
          if (extracted) {
            return extracted;
          }
          continue;
        }

        if (!block || typeof block !== 'object') {
          continue;
        }

        const text = (block as Record<string, unknown>).text;
        if (typeof text !== 'string') {
          continue;
        }

        const extracted = extractAgentIdFromString(text);
        if (extracted) {
          return extracted;
        }
      }
    }

    if (typeof record.content === 'string') {
      return extractAgentIdFromString(record.content);
    }

    return null;
  }

  extractStructuredResult(toolUseResult: unknown): string | null {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (record.retrieval_status === 'error') {
      const errorMsg = typeof record.error === 'string' ? record.error : 'Task retrieval failed';
      return `Error: ${errorMsg}`;
    }

    const taskResult = extractResultFromTaskObject(record.task);
    if (taskResult) {
      return taskResult;
    }

    const result = typeof record.result === 'string' ? record.result.trim() : '';
    if (result.length > 0) {
      return result;
    }

    const output = typeof record.output === 'string' ? record.output.trim() : '';
    if (output.length > 0) {
      return output;
    }

    return extractTextFromContentBlocks(record.content);
  }

  resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    const resolved = resolveToolUseResultStatus(toolUseResult, fallbackStatus);
    if (resolved === 'error') {
      return 'error';
    }

    if (resolved === 'completed') {
      return 'completed';
    }

    return fallbackStatus;
  }

  extractTagValue(payload: string, tagName: string): string | null {
    return extractXmlTag(payload, tagName);
  }
}
