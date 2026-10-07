import type { RequestedRunEvent } from '../../../core/execution';
import type { StreamChunk } from '../../../core/types';

export function adaptCodexStreamChunk(chunk: StreamChunk): RequestedRunEvent | null {
  switch (chunk.type) {
    case 'user_message_start':
      return {
        type: 'user_message_started',
        content: chunk.content,
        ...(chunk.itemId ? { nativeUserMessageId: chunk.itemId } : {}),
      };
    case 'assistant_message_start':
      return {
        type: 'assistant_message_started',
        ...(chunk.itemId ? { nativeAssistantId: chunk.itemId } : {}),
      };
    case 'text':
      return { type: 'text_delta', text: chunk.content };
    case 'thinking':
      return { type: 'thinking_delta', text: chunk.content };
    case 'citations':
      return { type: 'citations', citations: chunk.citations };
    case 'tool_use':
      return {
        type: 'tool_started',
        toolCallId: chunk.id,
        toolScope: { kind: 'main' },
        name: chunk.name,
        input: chunk.input,
        ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
      };
    case 'subagent_tool_output':
    case 'tool_output':
      return {
        type: 'tool_output',
        toolCallId: chunk.id,
        toolScope: chunk.type === 'subagent_tool_output'
          ? { kind: 'subagent', subagentId: chunk.subagentId } : { kind: 'main' },
        content: chunk.content,
      };
    case 'tool_result':
      return {
        type: 'tool_completed',
        toolCallId: chunk.id,
        toolScope: { kind: 'main' },
        content: chunk.content,
        ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
        ...(chunk.isBlocked !== undefined ? { isBlocked: chunk.isBlocked } : {}),
        ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
        ...(chunk.resultDetails ? { resultDetails: chunk.resultDetails } : {}),
      };
    case 'usage':
      return {
        type: 'usage_updated',
        usage: chunk.usage,
      };
    case 'context_compacted':
      return { type: 'context_compacted' };
    case 'notice':
      return {
        type: 'notice',
        message: chunk.content,
        ...(chunk.level ? { level: chunk.level } : {}),
      };
    case 'subagent_tool_use':
      return {
        type: 'tool_started',
        toolCallId: chunk.id,
        toolScope: { kind: 'subagent', subagentId: chunk.subagentId },
        name: chunk.name,
        input: chunk.input,
        ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
      };
    case 'subagent_tool_result':
      return {
        type: 'tool_completed',
        toolCallId: chunk.id,
        toolScope: { kind: 'subagent', subagentId: chunk.subagentId },
        content: chunk.content,
        ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
        ...(chunk.isBlocked !== undefined ? { isBlocked: chunk.isBlocked } : {}),
        ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
        ...(chunk.resultDetails ? { resultDetails: chunk.resultDetails } : {}),
      };
    case 'error':
    case 'done':
    case 'task_notification':
      return null;
  }
}
