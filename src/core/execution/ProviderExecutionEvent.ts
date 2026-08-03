import type {
  CitationGroup,
  SDKToolUseResult,
  ToolProviderPayload,
  UsageInfo,
} from '../types';
import type { ProviderSessionSnapshot } from './ProviderSessionSnapshot';

export type ProviderExecutionEventScope =
  | {
      readonly kind: 'requested';
      readonly sessionInstanceId: string;
      readonly executionId: string;
      readonly turnId: string;
      readonly sequence: number;
    }
  | {
      readonly kind: 'background';
      readonly sessionInstanceId: string;
      readonly turnId: string;
      readonly sequence: number;
    }
  | {
      readonly kind: 'session';
      readonly sessionInstanceId: string;
      readonly sequence: number;
    };

/**
 * Correlation envelopes are immutable. Sequence is monotonic within one
 * requested/background turn or the out-of-turn session channel.
 */
export type ProviderRequestedEventScope = Extract<
  ProviderExecutionEventScope,
  { kind: 'requested' }
>;
export type ProviderBackgroundEventScope = Extract<
  ProviderExecutionEventScope,
  { kind: 'background' }
>;
export type ProviderSessionEventScope = Extract<
  ProviderExecutionEventScope,
  { kind: 'session' }
>;
export type ProviderTurnEventScope =
  | ProviderRequestedEventScope
  | ProviderBackgroundEventScope;

export type ToolExecutionScope =
  | {
      readonly kind: 'main';
    }
  | {
      readonly kind: 'subagent';
      readonly subagentId: string;
    };

interface ProviderEventBase<TType extends string, TScope extends ProviderExecutionEventScope> {
  readonly type: TType;
  readonly scope: TScope;
}

interface ProviderOpaqueEventPayload {
  /** Forward-compatible provider data that feature code must not interpret. */
  readonly providerPayload?: unknown;
}

export type ProviderTurnStartedEvent = ProviderEventBase<
  'turn_started',
  ProviderRequestedEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly accepted: boolean;
    readonly nativeUserMessageId?: string;
    readonly nativeTurnId?: string;
    readonly nativeCheckpointId?: string;
  };

export type ProviderUserMessageStartedEvent = ProviderEventBase<
  'user_message_started',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly content?: string;
    readonly nativeUserMessageId?: string;
  };

export type ProviderAssistantMessageStartedEvent = ProviderEventBase<
  'assistant_message_started',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly nativeAssistantId?: string;
  };

export type ProviderTextDeltaEvent = ProviderEventBase<
  'text_delta',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly text: string;
  };

export type ProviderThinkingDeltaEvent = ProviderEventBase<
  'thinking_delta',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly text: string;
  };

export type ProviderCitationsEvent = ProviderEventBase<
  'citations',
  ProviderTurnEventScope
> & {
  readonly citations: CitationGroup;
};

interface ProviderToolIdentity {
  readonly toolCallId: string;
  readonly parentToolCallId?: string;
  readonly toolScope: ToolExecutionScope;
}

export type ProviderToolStartedEvent = ProviderEventBase<
  'tool_started',
  ProviderTurnEventScope
> &
  ProviderToolIdentity & {
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly providerPayload?: ToolProviderPayload;
  };

export type ProviderToolOutputEvent = ProviderEventBase<
  'tool_output',
  ProviderTurnEventScope
> &
  ProviderToolIdentity & {
    readonly content: string;
    readonly isError?: boolean;
    readonly toolUseResult?: SDKToolUseResult;
    readonly providerPayload?: ToolProviderPayload;
  };

export type ProviderToolCompletedEvent = ProviderEventBase<
  'tool_completed',
  ProviderTurnEventScope
> &
  ProviderToolIdentity & {
    readonly content?: string;
    readonly isError?: boolean;
    readonly toolUseResult?: SDKToolUseResult;
    readonly providerPayload?: ToolProviderPayload;
  };

export type ProviderUsageUpdatedEvent = ProviderEventBase<
  'usage_updated',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly usage: UsageInfo;
  };

export type ProviderContextCompactedEvent = ProviderEventBase<
  'context_compacted',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload;

export type ProviderNoticeEvent = ProviderEventBase<
  'notice',
  ProviderTurnEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly message: string;
    readonly level?: 'info' | 'warning';
  };

export type ProviderSessionStateChangedEvent = ProviderEventBase<
  'session_state_changed',
  ProviderExecutionEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly snapshot: ProviderSessionSnapshot;
  };

export type ProviderModeChangedEvent = ProviderEventBase<
  'mode_changed',
  ProviderExecutionEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly mode: string;
    readonly snapshot: ProviderSessionSnapshot;
  };

export type ProviderTurnCompletionReason =
  | 'completed'
  | 'max-tokens'
  | 'tool-ended'
  | 'provider-ended';

export type ProviderTurnCompletedEvent = ProviderEventBase<
  'turn_completed',
  ProviderRequestedEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly nativeAssistantId?: string;
    readonly nativeCheckpointId?: string;
    readonly planCompleted?: boolean;
    readonly reason: ProviderTurnCompletionReason;
  };

export type ProviderCancelledEvent = ProviderEventBase<
  'cancelled',
  ProviderRequestedEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly reason?: string;
  };

export type ProviderExecutionErrorCategory =
  | 'provider-session-missing'
  | 'authentication'
  | 'configuration'
  | 'transport'
  | 'process-exited'
  | 'provider'
  | 'unknown';

export type ProviderExecutionErrorEvent = ProviderEventBase<
  'execution_error',
  ProviderRequestedEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly category: ProviderExecutionErrorCategory;
    readonly message: string;
    readonly recoverable: boolean;
    readonly missingProviderSessionId?: string;
  };

export type ProviderRequestedExecutionEvent =
  | ProviderTurnStartedEvent
  | (ProviderUserMessageStartedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderAssistantMessageStartedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderTextDeltaEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderThinkingDeltaEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderCitationsEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderToolStartedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderToolOutputEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderToolCompletedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderUsageUpdatedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderContextCompactedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderNoticeEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderSessionStateChangedEvent & { readonly scope: ProviderRequestedEventScope })
  | (ProviderModeChangedEvent & { readonly scope: ProviderRequestedEventScope })
  | ProviderTurnCompletedEvent
  | ProviderCancelledEvent
  | ProviderExecutionErrorEvent;

export type ProviderBackgroundTurnStartedEvent = ProviderEventBase<
  'background_turn_started',
  ProviderBackgroundEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly nativeTurnId?: string;
    readonly providerSessionId?: string;
    readonly snapshotRevision?: number;
  };

export type ProviderBackgroundTurnCompletedEvent = ProviderEventBase<
  'background_turn_completed',
  ProviderBackgroundEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly nativeAssistantId?: string;
    readonly nativeCheckpointId?: string;
    readonly providerSessionId?: string;
    readonly snapshotRevision?: number;
    readonly reason: ProviderTurnCompletionReason;
  };

export type ProviderAsyncSubagentCompletedEvent = ProviderEventBase<
  'async_subagent_completed',
  ProviderSessionEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly originatingTurnId: string;
    readonly subagentId: string;
    readonly status: 'completed' | 'error';
    readonly result?: string;
    readonly providerSessionId?: string;
    readonly snapshotRevision?: number;
  };

export type ProviderSessionErrorEvent = ProviderEventBase<
  'session_error',
  ProviderSessionEventScope
> &
  ProviderOpaqueEventPayload & {
    readonly category: ProviderExecutionErrorCategory;
    readonly message: string;
    readonly recoverable: boolean;
  };

export type ProviderBackgroundOutputEvent =
  | (ProviderUserMessageStartedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderAssistantMessageStartedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderTextDeltaEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderThinkingDeltaEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderCitationsEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderToolStartedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderToolOutputEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderToolCompletedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderUsageUpdatedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderContextCompactedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderNoticeEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderSessionStateChangedEvent & { readonly scope: ProviderBackgroundEventScope })
  | (ProviderModeChangedEvent & { readonly scope: ProviderBackgroundEventScope });

export type ProviderSessionEvent =
  | ProviderBackgroundTurnStartedEvent
  | ProviderBackgroundOutputEvent
  | ProviderBackgroundTurnCompletedEvent
  | ProviderAsyncSubagentCompletedEvent
  | (ProviderSessionStateChangedEvent & { readonly scope: ProviderSessionEventScope })
  | (ProviderModeChangedEvent & { readonly scope: ProviderSessionEventScope })
  | ProviderSessionErrorEvent;

export type ProviderExecutionEvent = ProviderRequestedExecutionEvent;
