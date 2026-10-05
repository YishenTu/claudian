import type {
  ProviderBackgroundOutputEvent,
  ProviderExecutionEvent,
} from '@/core/execution';
import type { StreamChunk } from '@/core/types';

/** Maps neutral provider output to the stream chunk that renders it; non-output events map to null. */
export function providerOutputEventToStreamChunk(
  event: ProviderExecutionEvent | ProviderBackgroundOutputEvent,
): StreamChunk | null {
  switch (event.type) {
    // Empty deltas carry no output; dropping them here keeps them from ending the waiting state.
    case 'text_delta':
      return event.text ? { content: event.text, type: 'text' } : null;
    case 'thinking_delta':
      return event.text ? { content: event.text, type: 'thinking' } : null;
    case 'citations':
      return { citations: event.citations, type: 'citations' };
    case 'tool_started':
      return event.toolScope.kind === 'subagent'
        ? {
          id: event.toolCallId,
          input: { ...event.input },
          name: event.name,
          subagentId: event.toolScope.subagentId,
          ...(event.providerPayload ? { providerPayload: event.providerPayload } : {}),
          type: 'subagent_tool_use',
        }
        : {
          id: event.toolCallId,
          input: { ...event.input },
          name: event.name,
          ...(event.providerPayload ? { providerPayload: event.providerPayload } : {}),
          type: 'tool_use',
        };
    case 'tool_output':
      return event.toolScope.kind === 'subagent'
        ? { content: event.content, id: event.toolCallId, type: 'subagent_tool_output', subagentId: event.toolScope.subagentId }
        : {
          content: event.content,
          id: event.toolCallId,
          type: 'tool_output',
          ...(event.resultDetails ? { resultDetails: event.resultDetails } : {}),
        };
    case 'tool_completed':
      return event.toolScope.kind === 'subagent'
        ? {
          content: event.content ?? '',
          id: event.toolCallId,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.isBlocked !== undefined ? { isBlocked: event.isBlocked } : {}),
          subagentId: event.toolScope.subagentId,
          ...(event.providerPayload ? { providerPayload: event.providerPayload } : {}),
          ...(event.resultDetails ? { resultDetails: event.resultDetails } : {}),
          type: 'subagent_tool_result',
        }
        : {
          content: event.content ?? '',
          id: event.toolCallId,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.isBlocked !== undefined ? { isBlocked: event.isBlocked } : {}),
          ...(event.providerPayload ? { providerPayload: event.providerPayload } : {}),
          ...(event.resultDetails ? { resultDetails: event.resultDetails } : {}),
          type: 'tool_result',
        };
    case 'usage_updated':
      return { type: 'usage', usage: event.usage };
    case 'context_compacted':
      return { type: 'context_compacted' };
    case 'task_notification':
      return { type: 'task_notification', content: event.content };
    case 'notice':
      return {
        content: event.message,
        ...(event.level ? { level: event.level } : {}),
        type: 'notice',
      };
    default:
      return null;
  }
}
