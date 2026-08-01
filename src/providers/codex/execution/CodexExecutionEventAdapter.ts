import type {
  ProviderExecutionEvent,
  ProviderRequestedEventScope,
} from '../../../core/execution';
import type { StreamChunk } from '../../../core/types';

export function adaptCodexStreamChunk(
  chunk: StreamChunk,
  scope: ProviderRequestedEventScope,
): ProviderExecutionEvent | null {
  switch (chunk.type) {
    case 'user_message_start':
      return {
        type: 'user_message_started',
        scope,
        content: chunk.content,
        ...(chunk.itemId ? { nativeUserMessageId: chunk.itemId } : {}),
      };
    case 'assistant_message_start':
      return {
        type: 'assistant_message_started',
        scope,
        ...(chunk.itemId ? { nativeAssistantId: chunk.itemId } : {}),
      };
    case 'text':
      return { type: 'text_delta', scope, text: chunk.content };
    case 'thinking':
      return { type: 'thinking_delta', scope, text: chunk.content };
    case 'tool_use':
      return {
        type: 'tool_started',
        scope,
        toolCallId: chunk.id,
        toolScope: { kind: 'main' },
        name: chunk.name,
        input: chunk.input,
        ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
      };
    case 'tool_output':
      return {
        type: 'tool_output',
        scope,
        toolCallId: chunk.id,
        toolScope: { kind: 'main' },
        content: chunk.content,
      };
    case 'tool_result':
      return {
        type: 'tool_completed',
        scope,
        toolCallId: chunk.id,
        toolScope: { kind: 'main' },
        content: chunk.content,
        ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
        ...(chunk.toolUseResult ? { toolUseResult: chunk.toolUseResult } : {}),
      };
    case 'usage':
      return {
        type: 'usage_updated',
        scope,
        usage: chunk.usage,
      };
    case 'context_compacted':
      return { type: 'context_compacted', scope };
    case 'notice':
      return {
        type: 'notice',
        scope,
        message: chunk.content,
        ...(chunk.level ? { level: chunk.level } : {}),
      };
    case 'subagent_tool_use':
      return {
        type: 'tool_started',
        scope,
        toolCallId: chunk.id,
        toolScope: { kind: 'subagent', subagentId: chunk.subagentId },
        name: chunk.name,
        input: chunk.input,
      };
    case 'subagent_tool_result':
      return {
        type: 'tool_completed',
        scope,
        toolCallId: chunk.id,
        toolScope: { kind: 'subagent', subagentId: chunk.subagentId },
        content: chunk.content,
        ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
        ...(chunk.toolUseResult ? { toolUseResult: chunk.toolUseResult } : {}),
      };
    case 'error':
    case 'done':
      return null;
  }
}
