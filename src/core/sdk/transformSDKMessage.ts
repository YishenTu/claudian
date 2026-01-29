/**
 * SDK Message Transformer
 *
 * Transforms Claude Agent SDK messages into StreamChunks for the UI.
 * Extracted from ClaudianService for better testability and separation of concerns.
 *
 * SDK Message Types:
 * - 'system' - init, status, etc.
 * - 'assistant' - assistant response with content blocks (text, tool_use, thinking)
 * - 'user' - user messages, includes tool_use_result for tool outputs
 * - 'stream_event' - streaming deltas
 * - 'result' - final result
 * - 'error' - error messages
 */

import type { SDKMessage, SDKToolUseResult, UsageInfo } from '../types';
import { getContextWindowSize } from '../types';
import type { TransformEvent } from './types';

export interface TransformOptions {
  /** The intended model from settings/query (used for context window size). */
  intendedModel?: string;
  /** Whether 1M context window is enabled (affects context window size for sonnet). */
  is1MEnabled?: boolean;
  /** Custom context limits from settings (model ID → tokens). */
  customContextLimits?: Record<string, number>;
}

/**
 * Transform SDK message to StreamChunk format.
 * One SDK message can yield multiple chunks (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options?: TransformOptions
): Generator<TransformEvent> {
  // null = main agent, non-null = subagent context
  const parentToolUseId = message.type === 'result'
    ? null
    : message.parent_tool_use_id ?? null;

  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && message.session_id) {
        yield {
          type: 'session_init',
          sessionId: message.session_id,
          agents: message.agents,
        };
      } else if (message.subtype === 'compact_boundary') {
        yield { type: 'compact_boundary' };
      }
      break;

    case 'assistant': {
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            yield { type: 'thinking', content: block.thinking, parentToolUseId };
          } else if (block.type === 'text' && block.text) {
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
      const apiMessage = message.message as { usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      } };
      if (parentToolUseId === null && apiMessage?.usage) {
        const usage = apiMessage.usage;
        const inputTokens = usage.input_tokens ?? 0;
        const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
        const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
        const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

        const model = options?.intendedModel ?? 'sonnet';
        const contextWindow = getContextWindowSize(model, options?.is1MEnabled ?? false, options?.customContextLimits);
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

    case 'user':
      // Check for blocked tool calls (from hook denials)
      if ((message as any)._blocked && (message as any)._blockReason) {
        yield {
          type: 'blocked',
          content: (message as any)._blockReason,
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

    case 'stream_event': {
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
      // Usage is now extracted from assistant messages for accuracy (excludes subagent tokens)
      // Result message usage is aggregated across main + subagents, causing inaccurate spikes
      break;

    case 'error':
      if (message.error) {
        yield { type: 'error', content: message.error };
      }
      break;
  }
}
