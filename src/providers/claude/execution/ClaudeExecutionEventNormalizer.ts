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
import type { StreamChunk } from '../../../core/types';
import { ClaudeTaskToolNormalizer } from '../normalization/ClaudeTaskToolNormalizer';
import {
  isAsyncSubagentCompletion,
  isContextWindowEvent,
  isSessionInitEvent,
  isStreamChunk,
} from '../sdk/typeGuards';
import type {
  ClaudeAsyncSubagentCompletionEvent,
  SessionInitEvent,
} from '../sdk/types';
import {
  createTransformStreamState,
  createTransformUsageState,
  transformSDKMessage,
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
    readonly type: 'output';
    readonly event: ClaudeNormalizedOutputEvent;
  }
  | {
    readonly type: 'mode_entered';
    readonly mode: 'plan';
  }
  | {
    readonly type: 'plan_exited';
  }
  | {
    readonly type: 'assistant_checkpoint';
    readonly nativeAssistantId: string;
  }
  | {
    readonly type: 'native_error';
    readonly message: string;
    readonly code?: 'provider_session_missing';
    readonly providerSessionId?: string;
  }
  | {
    readonly type: 'result';
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
      readonly customContextLimits?: Record<string, number>;
    } = {},
  ): ClaudeNormalizedExecutionEvent[] {
    const state = this.states[channel];
    const normalized: ClaudeNormalizedExecutionEvent[] = [];
    for (const event of transformSDKMessage(message, {
      ...options,
      streamState: state.streamState,
      usageState: state.usageState,
    })) {
      if (isSessionInitEvent(event)) {
        normalized.push({
          type: 'session_init',
          event,
        });
        continue;
      }
      if (isAsyncSubagentCompletion(event)) {
        normalized.push({
          type: 'async_subagent_completion',
          event,
        });
        continue;
      }
      if (isContextWindowEvent(event)) {
        continue;
      }
      if (isStreamChunk(event)) {
        for (const chunk of normalizeTaskToolChunk(event, state.taskToolNormalizer)) {
          this.normalizeStreamChunk(message, chunk, state, normalized);
        }
      }
    }

    if (message.type === 'assistant' && message.uuid) {
      normalized.push({
        type: 'assistant_checkpoint',
        nativeAssistantId: message.uuid,
      });
    }
    if (message.type === 'result') {
      normalized.push({ type: 'result' });
    }
    return normalized;
  }

  markToolBlocked(
    toolUseId: string,
    channel: ClaudeExecutionEventChannel,
  ): void {
    this.states[channel].blockedToolIds.add(toolUseId);
  }

  reset(channel: ClaudeExecutionEventChannel): void {
    const state = this.states[channel];
    state.streamState.clearAll();
    state.taskToolNormalizer.reset();
    state.usageState.clear();
    state.toolScopes.clear();
    state.blockedToolIds.clear();
    state.assistantStarted = false;
    state.sawStreamText = false;
    state.sawStreamThinking = false;
  }

  private normalizeStreamChunk(
    message: SDKMessage,
    chunk: StreamChunk,
    state: NormalizationState,
    target: ClaudeNormalizedExecutionEvent[],
  ): void {
    if (chunk.type === 'done') return;
    if (chunk.type === 'error') {
      target.push({
        type: 'native_error',
        message: chunk.content,
        code: chunk.code,
        providerSessionId: chunk.providerSessionId,
      });
      return;
    }

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

    const event = toOutputEvent(chunk, state);
    if (event) {
      target.push({
        type: 'output',
        event,
      });
    }
    if (
      (chunk.type === 'tool_use' || chunk.type === 'subagent_tool_use')
      && chunk.name === 'EnterPlanMode'
    ) {
      target.push({
        type: 'mode_entered',
        mode: 'plan',
      });
    }
    if (
      (chunk.type === 'tool_use' || chunk.type === 'subagent_tool_use')
      && chunk.name === 'ExitPlanMode'
    ) {
      target.push({ type: 'plan_exited' });
    }
  }
}

function createNormalizationState(): NormalizationState {
  return {
    streamState: createTransformStreamState(),
    taskToolNormalizer: new ClaudeTaskToolNormalizer(),
    usageState: createTransformUsageState(),
    toolScopes: new Map(),
    blockedToolIds: new Set(),
    assistantStarted: false,
    sawStreamText: false,
    sawStreamThinking: false,
  };
}

function normalizeTaskToolChunk(
  chunk: StreamChunk,
  normalizer: ClaudeTaskToolNormalizer,
): StreamChunk[] {
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
  chunk: Exclude<StreamChunk, { type: 'done' | 'error' }>,
  state: NormalizationState,
): ClaudeNormalizedOutputEvent | null {
  switch (chunk.type) {
    case 'user_message_start':
      return {
        type: 'user_message_started',
        content: chunk.content,
        nativeUserMessageId: chunk.itemId,
      };
    case 'assistant_message_start':
      state.assistantStarted = true;
      return {
        type: 'assistant_message_started',
        nativeAssistantId: chunk.itemId,
      };
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
    case 'citations':
      return {
        type: 'citations',
        citations: chunk.citations,
      };
    case 'tool_use':
    case 'subagent_tool_use':
      return normalizeToolStarted(chunk, state);
    case 'tool_result':
    case 'subagent_tool_result':
      return normalizeToolCompleted(chunk, state);
    case 'tool_output': {
      const identity = state.toolScopes.get(chunk.id)
        ?? { toolScope: { kind: 'main' as const } };
      return {
        type: 'tool_output',
        toolCallId: chunk.id,
        ...identity,
        content: chunk.content,
      };
    }
    case 'usage':
      return {
        type: 'usage_updated',
        usage: chunk.usage,
      };
    case 'context_compacted':
      return {
        type: 'context_compacted',
      };
    case 'notice':
      return {
        type: 'notice',
        message: chunk.content,
        level: chunk.level,
      };
  }
}

function normalizeToolStarted(
  chunk:
    | Extract<StreamChunk, { type: 'tool_use' }>
    | Extract<StreamChunk, { type: 'subagent_tool_use' }>,
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
  chunk:
    | Extract<StreamChunk, { type: 'tool_result' }>
    | Extract<StreamChunk, { type: 'subagent_tool_result' }>,
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
  };
}

function isAssistantOutputChunk(chunk: StreamChunk): boolean {
  return (
    chunk.type === 'text'
    || chunk.type === 'thinking'
    || chunk.type === 'citations'
    || chunk.type === 'tool_use'
    || chunk.type === 'subagent_tool_use'
  );
}
