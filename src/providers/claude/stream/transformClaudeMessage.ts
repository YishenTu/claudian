import type { SDKMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk';

import type { SDKToolUseResult, StreamChunk, UsageInfo } from '../../../core/types';
import { isBlockedMessage } from '../sdk/messages';
import { extractToolResultContent } from '../sdk/toolResultContent';
import type { TransformEvent } from '../sdk/types';
import { getContextWindowSize } from '../types/models';

type ToolUseFields = { id: string; name: string; input: Record<string, unknown> };
type ToolResultFields = { id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult };

function emitToolUse(parentToolUseId: string | null, fields: ToolUseFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_use', ...fields };
  }
  return { type: 'subagent_tool_use', subagentId: parentToolUseId, ...fields };
}

function emitToolResult(parentToolUseId: string | null, fields: ToolResultFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_result', ...fields };
  }
  return { type: 'subagent_tool_result', subagentId: parentToolUseId, ...fields };
}

export interface TransformOptions {
  /** The intended model from settings/query (used for context window size). */
  intendedModel?: string;
  /** Custom context limits from settings (model ID → tokens). */
  customContextLimits?: Record<string, number>;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ContextWindowEntry {
  model: string;
  contextWindow: number;
}

function isResultError(message: { type: 'result'; subtype: string }): message is SDKResultError {
  return !!message.subtype && message.subtype !== 'success';
}

function getBuiltInModelSignature(model: string): { family: 'haiku' | 'sonnet' | 'opus'; is1M: boolean } | null {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'haiku') {
    return { family: 'haiku', is1M: false };
  }
  if (normalized === 'sonnet' || normalized === 'sonnet[1m]') {
    return { family: 'sonnet', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized === 'opus' || normalized === 'opus[1m]') {
    return { family: 'opus', is1M: normalized.endsWith('[1m]') };
  }
  return null;
}

function getModelUsageSignature(model: string): { family: 'haiku' | 'sonnet' | 'opus'; is1M: boolean } | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('haiku')) {
    return { family: 'haiku', is1M: false };
  }
  if (normalized.includes('sonnet')) {
    return { family: 'sonnet', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized.includes('opus')) {
    return { family: 'opus', is1M: normalized.endsWith('[1m]') };
  }
  return null;
}

function selectContextWindowEntry(
  modelUsage: Record<string, { contextWindow?: number }>,
  intendedModel?: string
): ContextWindowEntry | null {
  const entries: ContextWindowEntry[] = Object.entries(modelUsage)
    .flatMap(([model, usage]) =>
      typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
        ? [{ model, contextWindow: usage.contextWindow }]
        : []
    );

  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  if (!intendedModel) {
    return null;
  }

  const exactMatches = entries.filter((entry) => entry.model === intendedModel);
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const intendedSignature = getBuiltInModelSignature(intendedModel);
  if (!intendedSignature) {
    return null;
  }

  const signatureMatches = entries.filter((entry) => {
    const entrySignature = getModelUsageSignature(entry.model);
    return entrySignature?.family === intendedSignature.family && entrySignature.is1M === intendedSignature.is1M;
  });

  return signatureMatches.length === 1 ? signatureMatches[0] : null;
}

/**
 * Transform SDK message to StreamChunk format.
 * One SDK message can yield multiple chunks (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options?: TransformOptions
): Generator<TransformEvent> {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && message.session_id) {
        yield {
          type: 'session_init',
          sessionId: message.session_id,
          agents: message.agents,
          permissionMode: message.permissionMode,
        };
      } else if (message.subtype === 'compact_boundary') {
        yield { type: 'context_compacted' };
      }
      break;

    case 'assistant': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Errors on assistant messages (e.g. rate_limit, billing_error)
      if (message.error) {
        yield { type: 'error', content: message.error };
      }

      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            if (parentToolUseId === null) {
              yield { type: 'thinking', content: block.thinking };
            }
          } else if (block.type === 'text' && block.text && block.text.trim() !== '(no content)') {
            if (parentToolUseId === null) {
              yield { type: 'text', content: block.text };
            }
          } else if (block.type === 'tool_use') {
            yield emitToolUse(parentToolUseId, {
              id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              name: block.name || 'unknown',
              input: block.input || {},
            });
          }
        }
      }

      // Extract usage from main agent assistant messages only (not subagent)
      // This gives accurate per-turn context usage without subagent token pollution
      const usage = (message.message as { usage?: MessageUsage } | undefined)?.usage;
      if (parentToolUseId === null && usage) {
        const inputTokens = usage.input_tokens ?? 0;
        const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
        const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
        const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

        const model = options?.intendedModel ?? 'sonnet';
        const contextWindow = getContextWindowSize(model, options?.customContextLimits);
        const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

        const usageInfo: UsageInfo = {
          model,
          inputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          contextWindow,
          contextTokens,
          percentage,
        };
        yield { type: 'usage', usage: usageInfo };
      }
      break;
    }

    case 'user': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Check for blocked tool calls (from hook denials)
      if (isBlockedMessage(message)) {
        yield {
          type: 'notice',
          content: message._blockReason,
          level: 'warning',
        };
        break;
      }
      // User messages can contain tool results
      if (message.tool_use_result !== undefined && message.parent_tool_use_id) {
        const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
        yield emitToolResult(parentToolUseId, {
          id: message.parent_tool_use_id,
          content: extractToolResultContent(message.tool_use_result, { fallbackIndent: 2 }),
          isError: false,
          ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        });
      }
      // Also check message.message.content for tool_result blocks
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
            yield emitToolResult(parentToolUseId, {
              id: block.tool_use_id || message.parent_tool_use_id || '',
              content: extractToolResultContent(block.content, { fallbackIndent: 2 }),
              isError: block.is_error || false,
              ...(toolUseResult !== undefined ? { toolUseResult } : {}),
            });
          }
        }
      }
      break;
    }

    case 'stream_event': {
      const parentToolUseId = message.parent_tool_use_id ?? null;
      const event = message.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        yield emitToolUse(parentToolUseId, {
          id: event.content_block.id || `tool-${Date.now()}`,
          name: event.content_block.name || 'unknown',
          input: event.content_block.input || {},
        });
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        if (parentToolUseId === null && event.content_block.thinking) {
          yield { type: 'thinking', content: event.content_block.thinking };
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        if (parentToolUseId === null && event.content_block.text) {
          yield { type: 'text', content: event.content_block.text };
        }
      } else if (event?.type === 'content_block_delta') {
        if (parentToolUseId === null && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', content: event.delta.thinking };
        } else if (parentToolUseId === null && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', content: event.delta.text };
        }
      }
      break;
    }

    case 'result':
      if (isResultError(message)) {
        const content = message.errors.filter((e) => e.trim().length > 0).join('\n');
        yield {
          type: 'error',
          content: content || `Result error: ${message.subtype}`,
        };
      }

      // Usage is now extracted from assistant messages for accuracy (excludes subagent tokens)
      // Result message usage is aggregated across main + subagents, causing inaccurate spikes

      if ('modelUsage' in message && message.modelUsage) {
        const modelUsage = message.modelUsage as Record<string, { contextWindow?: number }>;
        const selectedEntry = selectContextWindowEntry(modelUsage, options?.intendedModel);
        if (selectedEntry) {
          yield { type: 'context_window', contextWindow: selectedEntry.contextWindow };
        }
      }
      break;

    default:
      break;
  }
}
