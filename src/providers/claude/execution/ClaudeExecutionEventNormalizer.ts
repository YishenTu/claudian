import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type {
  ProviderAssistantMessageStartedEvent,
  ProviderCitationsEvent,
  ProviderContextCompactedEvent,
  ProviderNoticeEvent,
  ProviderTextDeltaEvent,
  ProviderThinkingDeltaEvent,
  ProviderToolCompletedEvent,
  ProviderToolOutputEvent,
  ProviderToolStartedEvent,
  ProviderUsageUpdatedEvent,
  ProviderUserMessageStartedEvent,
  ToolExecutionScope,
} from '../../../core/execution';
import type { TurnStats, UsageInfo } from '../../../core/types';
import { createTurnStats } from '../../../core/types';
import { ClaudeTaskToolNormalizer } from '../normalization/ClaudeTaskToolNormalizer';
import type {
  ClaudeAsyncSubagentCompletionEvent,
  ClaudeOutputChunk,
  ClaudeSubagentProgressEvent,
  SessionInitEvent,
} from '../sdk/types';
import {
  createTransformStreamState,
  createTransformUsageState,
  transformSDKMessage,
  withReportedContextWindow,
} from '../stream/transformClaudeMessage';

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;

export type ClaudeNormalizedOutputEvent = WithoutScope<
  | ProviderUserMessageStartedEvent
  | ProviderAssistantMessageStartedEvent
  | ProviderTextDeltaEvent
  | ProviderThinkingDeltaEvent
  | ProviderCitationsEvent
  | ProviderToolStartedEvent
  | ProviderToolOutputEvent
  | ProviderToolCompletedEvent
  | ProviderUsageUpdatedEvent
  | ProviderContextCompactedEvent
  | ProviderNoticeEvent
>;

export type ClaudeNormalizedExecutionEvent =
  | {
    readonly type: 'session_init';
    readonly event: SessionInitEvent;
  }
  | {
    readonly type: 'async_subagent_completion';
    readonly event: ClaudeAsyncSubagentCompletionEvent;
  }
  | {
    readonly type: 'subagent_progress';
    readonly event: ClaudeSubagentProgressEvent;
  }
  | {
    readonly type: 'output';
    readonly event: ClaudeNormalizedOutputEvent;
  }
  | {
    readonly type: 'assistant_checkpoint';
    readonly nativeAssistantId: string;
  }
  | {
    readonly type: 'native_error';
    readonly message: string;
    /** Never set by Claude; retained for consumers shared with other providers' error shape. */
    readonly code?: 'provider_session_missing';
    readonly providerSessionId?: string;
  }
  | {
    readonly type: 'context_window';
    readonly model: string;
    readonly contextWindow: number;
  }
  | {
    readonly type: 'result';
    readonly turnStats?: TurnStats;
  };

export type ClaudeExecutionEventChannel = 'requested' | 'background';

interface ToolIdentity {
  readonly parentToolCallId?: string;
  readonly toolScope: ToolExecutionScope;
}

interface NormalizationState {
  readonly streamState: ReturnType<typeof createTransformStreamState>;
  readonly taskToolNormalizer: ClaudeTaskToolNormalizer;
  readonly usageState: ReturnType<typeof createTransformUsageState>;
  readonly toolScopes: Map<string, ToolIdentity>;
  readonly blockedToolIds: Set<string>;
  lastUsage: UsageInfo | null;
  assistantStarted: boolean;
  sawStreamText: boolean;
  sawStreamThinking: boolean;
}

export class ClaudeExecutionEventNormalizer {
  private readonly states: Record<
    ClaudeExecutionEventChannel,
    NormalizationState
  > = {
    requested: createNormalizationState(),
    background: createNormalizationState(),
  };

  normalize(
    message: SDKMessage,
    channel: ClaudeExecutionEventChannel,
    options: {
      readonly intendedModel?: string;
      readonly reportedContextWindow?: number;
    } = {},
  ): ClaudeNormalizedExecutionEvent[] {
    const state = this.states[channel];
    const normalized: ClaudeNormalizedExecutionEvent[] = [];
    for (const event of transformSDKMessage(message, {
      ...options,
      streamState: state.streamState,
      usageState: state.usageState,
    })) {
      switch (event.type) {
        case 'session_init':
          normalized.push({ type: 'session_init', event });
          break;
        case 'async_subagent_completion':
          normalized.push({ type: 'async_subagent_completion', event });
          break;
        case 'subagent_progress':
          normalized.push({ type: 'subagent_progress', event });
          break;
        case 'context_window':
          this.#normalizeContextWindow(channel, event.contextWindow, options, normalized);
          break;
        case 'error':
          normalized.push({ type: 'native_error', message: event.content });
          break;
        default:
          for (const chunk of normalizeTaskToolChunk(event, state.taskToolNormalizer)) {
            this.#normalizeOutputChunk(message, chunk, state, normalized);
          }
      }
    }

    if (message.type === 'assistant' && message.uuid && message.parent_tool_use_id == null) {
      normalized.push({
        type: 'assistant_checkpoint',
        nativeAssistantId: message.uuid,
      });
    }
    if (message.type === 'result') {
      normalized.push({ type: 'result', turnStats: message.subtype === 'success' && !message.is_error
        ? createTurnStats(message.usage?.output_tokens, message.duration_ms) : undefined });
    }
    return normalized;
  }

  updateContextWindow(
    channel: ClaudeExecutionEventChannel,
    model: string,
    reportedContextWindow: number,
  ): UsageInfo | null {
    const state = this.states[channel];
    if (!state.lastUsage || state.lastUsage.model !== model
      || !isFinitePositiveNumber(reportedContextWindow)) {
      return null;
    }
    const correctedUsage = withReportedContextWindow(
      state.lastUsage,
      reportedContextWindow,
    );
    if (sameUsageWindow(state.lastUsage, correctedUsage)) {
      return null;
    }
    state.lastUsage = correctedUsage;
    return correctedUsage;
  }

  markToolBlocked(
    toolUseId: string,
    channel: ClaudeExecutionEventChannel,
  ): void {
    this.states[channel].blockedToolIds.add(toolUseId);
  }

  /** A steer entering the run opens a new assistant response boundary. */
  beginUserBoundary(channel: ClaudeExecutionEventChannel): void {
    this.states[channel].assistantStarted = false;
  }

  reset(channel: ClaudeExecutionEventChannel): void {
    const state = this.states[channel];
    state.streamState.clearAll();
    state.taskToolNormalizer.reset();
    state.usageState.clear();
    state.toolScopes.clear();
    state.blockedToolIds.clear();
    state.lastUsage = null;
    state.assistantStarted = false;
    state.sawStreamText = false;
    state.sawStreamThinking = false;
  }

  /** Result modelUsage reports the model window, which supersedes any discovered compaction window. */
  #normalizeContextWindow(
    channel: ClaudeExecutionEventChannel,
    contextWindow: number,
    options: { readonly intendedModel?: string },
    target: ClaudeNormalizedExecutionEvent[],
  ): void {
    const state = this.states[channel];
    const model = options.intendedModel ?? state.lastUsage?.model ?? 'sonnet';
    target.push({ type: 'context_window', model, contextWindow });
    const correctedUsage = this.updateContextWindow(channel, model, contextWindow);
    if (correctedUsage) {
      target.push({
        type: 'output',
        event: { type: 'usage_updated', usage: correctedUsage },
      });
    }
  }

  #normalizeOutputChunk(
    message: SDKMessage,
    chunk: ClaudeOutputChunk,
    state: NormalizationState,
    target: ClaudeNormalizedExecutionEvent[],
  ): void {
    if (
      (chunk.type === 'text' || chunk.type === 'thinking')
      && message.type === 'stream_event'
    ) {
      if (chunk.type === 'text') state.sawStreamText = true;
      if (chunk.type === 'thinking') state.sawStreamThinking = true;
    }
    if (
      message.type === 'assistant'
      && (
        (chunk.type === 'text' && state.sawStreamText)
        || (chunk.type === 'thinking' && state.sawStreamThinking)
      )
    ) {
      return;
    }

    if (isAssistantOutputChunk(chunk) && !state.assistantStarted) {
      state.assistantStarted = true;
      target.push({
        type: 'output',
        event: {
          type: 'assistant_message_started',
          ...(message.type === 'assistant' && message.uuid
            ? { nativeAssistantId: message.uuid }
            : {}),
        },
      });
    }

    target.push({
      type: 'output',
      event: toOutputEvent(chunk, state),
    });
  }
}

function createNormalizationState(): NormalizationState {
  return {
    streamState: createTransformStreamState(),
    taskToolNormalizer: new ClaudeTaskToolNormalizer(),
    usageState: createTransformUsageState(),
    toolScopes: new Map(),
    blockedToolIds: new Set(),
    lastUsage: null,
    assistantStarted: false,
    sawStreamText: false,
    sawStreamThinking: false,
  };
}

function normalizeTaskToolChunk(
  chunk: ClaudeOutputChunk,
  normalizer: ClaudeTaskToolNormalizer,
): ClaudeOutputChunk[] {
  if (chunk.type === 'tool_use') {
    const normalized = normalizer.normalizeToolUse(chunk.id, chunk.name, chunk.input);
    if (!normalized) return [chunk];
    return [{
      ...chunk,
      name: normalized.name,
      input: normalized.input,
      providerPayload: normalized.providerPayload,
    }];
  }

  if (chunk.type === 'tool_result') {
    const normalized = normalizer.normalizeToolResult(
      chunk.id,
      chunk.toolUseResult,
      {
        fallbackContent: chunk.content,
        isError: chunk.isError,
      },
    );
    if (!normalized) return [chunk];
    return [
      {
        type: 'tool_use',
        id: chunk.id,
        name: normalized.name,
        input: normalized.input,
        providerPayload: normalized.providerPayload,
      },
      chunk,
    ];
  }

  return [chunk];
}

function toOutputEvent(
  chunk: ClaudeOutputChunk,
  state: NormalizationState,
): ClaudeNormalizedOutputEvent {
  switch (chunk.type) {
    case 'text':
      return {
        type: 'text_delta',
        text: chunk.content,
      };
    case 'thinking':
      return {
        type: 'thinking_delta',
        text: chunk.content,
      };
    case 'tool_use':
    case 'subagent_tool_use':
      return normalizeToolStarted(chunk, state);
    case 'tool_result':
    case 'subagent_tool_result':
      return normalizeToolCompleted(chunk, state);
    case 'usage':
      state.lastUsage = chunk.usage;
      return {
        type: 'usage_updated',
        usage: chunk.usage,
      };
    case 'context_compacted':
      return {
        type: 'context_compacted',
      };
  }
}

function sameUsageWindow(current: UsageInfo, next: UsageInfo): boolean {
  return current.contextWindow === next.contextWindow
    && current.percentage === next.percentage;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeToolStarted(
  chunk: Extract<ClaudeOutputChunk, { type: 'tool_use' | 'subagent_tool_use' }>,
  state: NormalizationState,
): ClaudeNormalizedOutputEvent {
  const identity: ToolIdentity = chunk.type === 'subagent_tool_use'
    ? {
      parentToolCallId: chunk.subagentId,
      toolScope: {
        kind: 'subagent',
        subagentId: chunk.subagentId,
      },
    }
    : {
      toolScope: { kind: 'main' },
    };
  state.toolScopes.set(chunk.id, identity);
  return {
    type: 'tool_started',
    toolCallId: chunk.id,
    ...identity,
    name: chunk.name,
    input: chunk.input,
    ...('providerPayload' in chunk && chunk.providerPayload
      ? { providerPayload: chunk.providerPayload }
      : {}),
  };
}

function normalizeToolCompleted(
  chunk: Extract<ClaudeOutputChunk, { type: 'tool_result' | 'subagent_tool_result' }>,
  state: NormalizationState,
): ClaudeNormalizedOutputEvent {
  if (chunk.isBlocked) {
    state.blockedToolIds.add(chunk.id);
  }
  const identity = state.toolScopes.get(chunk.id) ?? (
    chunk.type === 'subagent_tool_result'
      ? {
        parentToolCallId: chunk.subagentId,
        toolScope: {
          kind: 'subagent' as const,
          subagentId: chunk.subagentId,
        },
      }
      : { toolScope: { kind: 'main' as const } }
  );
  return {
    type: 'tool_completed',
    toolCallId: chunk.id,
    ...identity,
    content: chunk.content,
    isError: chunk.isError,
    isBlocked: state.blockedToolIds.has(chunk.id),
    toolUseResult: chunk.toolUseResult,
    ...(chunk.providerPayload ? { providerPayload: chunk.providerPayload } : {}),
  };
}

function isAssistantOutputChunk(chunk: ClaudeOutputChunk): boolean {
  return (
    chunk.type === 'text'
    || chunk.type === 'thinking'
    || chunk.type === 'tool_use'
    || chunk.type === 'subagent_tool_use'
  );
}
