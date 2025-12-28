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

import type { SDKMessage,StreamChunk } from '../types';

/** Event emitted when a session is initialized */
export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
}

/** Union type for all events that can be yielded by the transformer */
export type TransformEvent = StreamChunk | SessionInitEvent;

/**
 * Transform SDK message to StreamChunk format.
 * Returns a generator since one SDK message can contain multiple chunks
 * (e.g., assistant message with both text and tool_use blocks).
 *
 * @param message - The SDK message to transform
 * @yields StreamChunk events for UI rendering, or SessionInitEvent for session tracking
 */
export function* transformSDKMessage(message: SDKMessage): Generator<TransformEvent> {
  // Capture parent_tool_use_id for subagent routing
  // null = main agent, non-null = subagent context
  const parentToolUseId = message.parent_tool_use_id ?? null;

  switch (message.type) {
    case 'system':
      // Emit session init event for the caller to handle
      if (message.subtype === 'init' && message.session_id) {
        yield { type: 'session_init', sessionId: message.session_id };
      }
      // Don't yield system messages to the UI
      break;

    case 'assistant':
      // Extract ALL content blocks - text, tool_use, and thinking
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
      break;

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
            };
          }
        }
      }
      break;

    case 'stream_event': {
      // Handle streaming events for real-time updates
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
      // Final result - no text to extract, result is a string summary
      break;

    case 'error':
      if (message.error) {
        yield { type: 'error', content: message.error };
      }
      break;
  }
}

/**
 * Type guard to check if an event is a session init event
 */
export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

/**
 * Type guard to check if an event is a stream chunk
 */
export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init';
}
