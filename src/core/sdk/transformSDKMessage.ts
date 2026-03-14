import type { SDKMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk';

import type { SDKToolUseResult, UsageInfo } from '../types';
import { getContextWindowSize } from '../types';
import { isBlockedMessage } from '../types/sdk';
import type { TransformEvent } from './types';

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

function isResultError(message: { type: 'result'; subtype: string }): message is SDKResultError {
  return !!message.subtype && message.subtype !== 'success';
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
        yield { type: 'compact_boundary' };
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
            yield { type: 'thinking', content: block.thinking, parentToolUseId };
          } else if (block.type === 'text' && block.text && block.text.trim() !== '(no content)') {
            yield { type: 'text', content: block.text, parentToolUseId };
          } else if (block.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              name: block.name || 'unknown',
              input: block.input || {},
              parentToolUseId,
            };
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
          type: 'blocked',
          content: message._blockReason,
        };
        break;
      }
      // User messages can contain tool results
      if (message.tool_use_result !== undefined && message.parent_tool_use_id) {
        yield {
          type: 'tool_result',
          id: message.parent_tool_use_id,
          content: typeof message.tool_use_result === 'string'
            ? message.tool_use_result
            : JSON.stringify(message.tool_use_result, null, 2),
          isError: false,
          parentToolUseId,
          toolUseResult: (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined,
        };
      }
      // Also check message.message.content for tool_result blocks
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            yield {
              type: 'tool_result',
              id: block.tool_use_id || message.parent_tool_use_id || '',
              content: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content, null, 2),
              isError: block.is_error || false,
              parentToolUseId,
              toolUseResult: (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined,
            };
          }
        }
      }
      break;
    }

    case 'stream_event': {
      const parentToolUseId = message.parent_tool_use_id ?? null;
      const event = message.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        yield {
          type: 'tool_use',
          id: event.content_block.id || `tool-${Date.now()}`,
          name: event.content_block.name || 'unknown',
          input: event.content_block.input || {},
          parentToolUseId,
        };
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        if (event.content_block.thinking) {
          yield { type: 'thinking', content: event.content_block.thinking, parentToolUseId };
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        if (event.content_block.text) {
          yield { type: 'text', content: event.content_block.text, parentToolUseId };
        }
      } else if (event?.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', content: event.delta.thinking, parentToolUseId };
        } else if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', content: event.delta.text, parentToolUseId };
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
      break;

    default:
      break;
  }
}
