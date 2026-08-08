import type {
  ProviderAssistantMessageStartedEvent,
  ProviderNoticeEvent,
  ProviderRequestedEventScope,
  ProviderTextDeltaEvent,
  ProviderThinkingDeltaEvent,
  ProviderToolCompletedEvent,
  ProviderToolOutputEvent,
  ProviderToolStartedEvent,
  ProviderTurnEventScope,
  ProviderUsageUpdatedEvent,
  ProviderUserMessageStartedEvent,
  ToolExecutionScope,
} from '../../core/execution';
import type { UsageInfo } from '../../core/types';
import {
  type AcpNormalizedUpdate,
  AcpSessionUpdateNormalizer,
} from './AcpSessionUpdateNormalizer';
import type { AcpToolStreamAdapter } from './AcpToolStreamAdapter';
import type {
  AcpToolCall,
  AcpToolCallUpdate,
  AcpUsageUpdate,
} from './types';

export type AcpExecutionTurnScopeSeed =
  | Omit<ProviderRequestedEventScope, 'sequence'>
  | {
      readonly kind: 'background';
      readonly sessionInstanceId: string;
      readonly turnId: string;
    };

export interface AcpToolScopeContext {
  readonly toolCallId: string;
  readonly update: AcpToolCall | AcpToolCallUpdate;
}

export interface AcpExecutionEventNormalizerOptions {
  readonly scope: AcpExecutionTurnScopeSeed;
  readonly resolveToolScope?: (
    context: AcpToolScopeContext,
  ) => ToolExecutionScope;
  readonly mapUsage?: (usage: AcpUsageUpdate) => UsageInfo | null;
  readonly toolStreamAdapter?: AcpToolStreamAdapter;
}

export type AcpNormalizedExecutionEvent =
  | ProviderAssistantMessageStartedEvent
  | ProviderNoticeEvent
  | ProviderTextDeltaEvent
  | ProviderThinkingDeltaEvent
  | ProviderToolCompletedEvent
  | ProviderToolOutputEvent
  | ProviderToolStartedEvent
  | ProviderUsageUpdatedEvent
  | ProviderUserMessageStartedEvent;

export interface AcpExecutionNormalizationResult {
  readonly events: readonly AcpNormalizedExecutionEvent[];
  readonly ignored?: boolean;
  readonly metadata?: AcpNormalizedUpdate;
}

export class AcpExecutionEventNormalizer {
  private disposed = false;
  private readonly normalizer = new AcpSessionUpdateNormalizer();
  private sequence = 0;

  constructor(private readonly options: AcpExecutionEventNormalizerOptions) {}

  normalize(update: unknown): AcpExecutionNormalizationResult {
    if (this.disposed) {
      return { events: [], ignored: true };
    }

    const normalized = this.normalizer.normalizeUnknown(update);
    if (normalized.type === 'unknown') {
      return {
        events: [{
          level: 'info',
          message: 'ACP emitted an unrecognized session update.',
          providerPayload: normalized.update,
          scope: this.nextScope(),
          type: 'notice',
        }],
        metadata: normalized,
      };
    }

    const events = this.mapNormalizedUpdate(normalized);
    return {
      events,
      metadata: normalized,
    };
  }

  reset(): void {
    if (this.disposed) return;
    this.normalizer.reset();
    this.options.toolStreamAdapter?.reset();
    this.sequence = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.normalizer.reset();
    this.options.toolStreamAdapter?.reset();
  }

  private mapNormalizedUpdate(
    normalized: Exclude<AcpNormalizedUpdate, { type: 'unknown' }>,
  ): AcpNormalizedExecutionEvent[] {
    switch (normalized.type) {
      case 'message_chunk':
        return normalized.streamChunks.flatMap(
          (chunk): AcpNormalizedExecutionEvent[] => {
          switch (chunk.type) {
            case 'user_message_start':
              return [{
                ...(chunk.content ? { content: chunk.content } : {}),
                ...(chunk.itemId ? { nativeUserMessageId: chunk.itemId } : {}),
                scope: this.nextScope(),
                type: 'user_message_started' as const,
              }];
            case 'assistant_message_start':
              return [{
                ...(chunk.itemId ? { nativeAssistantId: chunk.itemId } : {}),
                scope: this.nextScope(),
                type: 'assistant_message_started' as const,
              }];
            case 'text':
              return [{
                providerPayload: {
                  content: normalized.content,
                  messageId: normalized.messageId,
                },
                scope: this.nextScope(),
                text: chunk.content,
                type: 'text_delta' as const,
              }];
            case 'thinking':
              return [{
                providerPayload: {
                  content: normalized.content,
                  messageId: normalized.messageId,
                },
                scope: this.nextScope(),
                text: chunk.content,
                type: 'thinking_delta' as const,
              }];
            default:
              return [];
          }
        });
      case 'tool_call':
      case 'tool_call_update': {
        const update = normalized.type === 'tool_call'
          ? normalized.toolCall
          : normalized.toolCallUpdate;
        const toolScope = this.options.resolveToolScope?.({
          toolCallId: update.toolCallId,
          update,
        }) ?? { kind: 'main' };
        const streamChunks = normalized.type === 'tool_call'
          ? this.options.toolStreamAdapter?.normalizeToolCall(
            normalized.toolCall,
            normalized.streamChunks,
          ) ?? normalized.streamChunks
          : this.options.toolStreamAdapter?.normalizeToolCallUpdate(
            normalized.toolCallUpdate,
            normalized.streamChunks,
          ) ?? normalized.streamChunks;
        return streamChunks.flatMap(
          (chunk): AcpNormalizedExecutionEvent[] => {
          switch (chunk.type) {
            case 'tool_use':
              return [{
                input: chunk.input,
                name: chunk.name,
                ...(chunk.providerPayload
                  ? { providerPayload: chunk.providerPayload }
                  : {}),
                scope: this.nextScope(),
                toolCallId: chunk.id,
                toolScope,
                type: 'tool_started' as const,
              }];
            case 'tool_output':
              return [{
                content: chunk.content,
                scope: this.nextScope(),
                toolCallId: chunk.id,
                toolScope,
                type: 'tool_output' as const,
              }];
            case 'tool_result':
              return [{
                content: chunk.content,
                isError: chunk.isError,
                isBlocked: chunk.isBlocked,
                scope: this.nextScope(),
                toolCallId: chunk.id,
                toolScope,
                ...(chunk.toolUseResult ? {
                  toolUseResult: chunk.toolUseResult,
                } : {}),
                type: 'tool_completed' as const,
              }];
            default:
              return [];
          }
        });
      }
      case 'usage': {
        const usage = this.options.mapUsage?.(normalized.usage) ?? null;
        return usage
          ? [{
            providerPayload: normalized.usage,
            scope: this.nextScope(),
            type: 'usage_updated',
            usage,
          }]
          : [];
      }
      default:
        return [];
    }
  }

  private nextScope(): ProviderTurnEventScope {
    return {
      ...this.options.scope,
      sequence: ++this.sequence,
    };
  }
}
