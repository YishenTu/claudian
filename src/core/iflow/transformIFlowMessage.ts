/**
 * iFlow Message Transformer
 *
 * Transforms iFlow SDK messages into StreamChunks for the UI.
 * This is the iFlow equivalent of transformSDKMessage.ts for Claude SDK.
 *
 * iFlow Message Types:
 * - 'assistant' - AI assistant text response
 * - 'tool_call' - Tool execution request and status
 * - 'plan' - Structured task plan
 * - 'task_finish' - Task completion signal
 * - 'thinking' - Reasoning/thinking content
 * - 'error' - Error messages
 */

import type { StreamChunk } from '../types';
import type {
  AssistantMessage,
  ErrorMessage,
  IFlowMessage,
  PlanMessage,
  TaskFinishMessage,
  ThinkingMessage,
  ToolCallMessage,
} from './types';

/** Event emitted when a session is initialized */
export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
}

/** Union type for all events that can be yielded by the transformer */
export type TransformEvent = StreamChunk | SessionInitEvent;

/** Options for transformIFlowMessage */
export interface TransformOptions {
  /** Current session ID (for tracking) */
  sessionId?: string;
}

/**
 * Transform iFlow message to StreamChunk format.
 * Returns a generator since one iFlow message can map to multiple chunks.
 *
 * @param message - The iFlow message to transform
 * @param _options - Optional transform options (reserved for future use)
 * @yields StreamChunk events for UI rendering, or SessionInitEvent for session tracking
 */
export function* transformIFlowMessage(
  message: IFlowMessage,
  _options?: TransformOptions
): Generator<TransformEvent> {
  switch (message.type) {
    case 'assistant':
      yield* transformAssistantMessage(message);
      break;

    case 'tool_call':
      yield* transformToolCallMessage(message);
      break;

    case 'plan':
      yield* transformPlanMessage(message);
      break;

    case 'task_finish':
      yield* transformTaskFinishMessage(message);
      break;

    case 'thinking':
      yield* transformThinkingMessage(message);
      break;

    case 'error':
      yield* transformErrorMessage(message);
      break;

    default:
      // Unknown message type - ignore
      break;
  }
}

/**
 * Transform assistant message to text chunk.
 */
function* transformAssistantMessage(
  message: AssistantMessage
): Generator<StreamChunk> {
  if (message.chunk?.text) {
    yield {
      type: 'text',
      content: message.chunk.text,
      parentToolUseId: null,
    };
  }
}

/**
 * Transform tool call message to tool_use or tool_result chunk.
 */
function* transformToolCallMessage(
  message: ToolCallMessage
): Generator<StreamChunk> {
  // Use the toolId from iFlow, or generate a consistent one based on tool name
  const toolId = message.toolId || `tool-${message.toolName}-${Date.now()}`;

  // Always emit tool_use first to ensure UI has the tool registered
  if (message.status === 'pending' || message.status === 'running') {
    yield {
      type: 'tool_use',
      id: toolId,
      name: message.toolName,
      input: message.input || {},
      parentToolUseId: null,
    };
  }

  // Emit tool_result when tool completes
  if (message.status === 'completed' || message.status === 'failed') {
    // First emit tool_use if not already done (for cases where we only get completion)
    yield {
      type: 'tool_use',
      id: toolId,
      name: message.toolName,
      input: message.input || {},
      parentToolUseId: null,
    };
    
    // Then emit the result
    yield {
      type: 'tool_result',
      id: toolId,
      content: message.result || '',
      isError: message.status === 'failed',
      parentToolUseId: null,
    };
  }
}

/**
 * Transform plan message to text chunk (formatted as plan).
 */
function* transformPlanMessage(
  message: PlanMessage
): Generator<StreamChunk> {
  if (message.entries && message.entries.length > 0) {
    // Format plan entries as a readable list
    const planText = message.entries
      .map((entry, index) => {
        const status = entry.status === 'completed' ? '✓' :
                       entry.status === 'in_progress' ? '→' : '○';
        return `${status} ${index + 1}. ${entry.content}`;
      })
      .join('\n');

    yield {
      type: 'text',
      content: `\n**Plan:**\n${planText}\n`,
      parentToolUseId: null,
    };
  }
}

/**
 * Transform task finish message to done chunk.
 */
function* transformTaskFinishMessage(
  _message: TaskFinishMessage
): Generator<StreamChunk> {
  yield { type: 'done' };
}

/**
 * Transform thinking message to thinking chunk.
 */
function* transformThinkingMessage(
  message: ThinkingMessage
): Generator<StreamChunk> {
  if (message.content) {
    yield {
      type: 'thinking',
      content: message.content,
      parentToolUseId: null,
    };
  }
}

/**
 * Transform error message to error chunk.
 */
function* transformErrorMessage(
  message: ErrorMessage
): Generator<StreamChunk> {
  const errorContent = message.code
    ? `[${message.code}] ${message.message}`
    : message.message;

  yield {
    type: 'error',
    content: errorContent,
  };
}

/**
 * Type guard to check if an event is a SessionInitEvent.
 */
export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

/**
 * Type guard to check if an event is a StreamChunk.
 */
export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init';
}
