import type {
  ProviderCancelledEvent,
  ProviderExecutionErrorEvent,
  ProviderTurnCompletedEvent,
} from './ProviderExecutionEvent';

export type ProviderExecutionTerminalEvent =
  | ProviderTurnCompletedEvent
  | ProviderCancelledEvent
  | ProviderExecutionErrorEvent;

export type ProviderExecutionOutcomeStatus =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'invalidated';

export interface ProviderExecutionOutcome {
  readonly status: ProviderExecutionOutcomeStatus;
  readonly accepted: boolean;
  readonly planCompleted: boolean;
  readonly nativeUserMessageId?: string;
  readonly nativeAssistantMessageId?: string;
  readonly nativeCheckpointId?: string;
  readonly error?: ProviderExecutionErrorEvent;
  readonly recoverable?: boolean;
}

export interface ProviderExecutionOutcomeInput {
  readonly accepted: boolean;
  readonly terminal?: ProviderExecutionTerminalEvent;
  readonly interruption?: Extract<ProviderExecutionOutcomeStatus, 'cancelled' | 'invalidated'>;
  readonly nativeUserMessageId?: string;
  readonly nativeAssistantMessageId?: string;
  readonly nativeCheckpointId?: string;
}

/**
 * Converts one requested execution's terminal state into the provider-neutral
 * result consumed by conversation and feature orchestration.
 */
export function createProviderExecutionOutcome(
  input: ProviderExecutionOutcomeInput,
): ProviderExecutionOutcome {
  if (input.interruption) {
    return {
      status: input.interruption,
      accepted: input.accepted,
      planCompleted: false,
      nativeUserMessageId: input.nativeUserMessageId,
      nativeAssistantMessageId: input.nativeAssistantMessageId,
      nativeCheckpointId: input.nativeCheckpointId,
    };
  }

  const terminal = input.terminal;
  if (!terminal || terminal.type === 'cancelled') {
    return {
      status: 'cancelled',
      accepted: input.accepted,
      planCompleted: false,
      nativeUserMessageId: input.nativeUserMessageId,
      nativeAssistantMessageId: input.nativeAssistantMessageId,
      nativeCheckpointId: input.nativeCheckpointId,
    };
  }

  if (terminal.type === 'turn_completed') {
    return {
      status: 'completed',
      accepted: input.accepted,
      planCompleted: terminal.planCompleted === true,
      nativeUserMessageId: input.nativeUserMessageId,
      nativeAssistantMessageId:
        terminal.nativeAssistantId ?? input.nativeAssistantMessageId,
      nativeCheckpointId: terminal.nativeCheckpointId ?? input.nativeCheckpointId,
    };
  }

  return {
    status: 'error',
    accepted: input.accepted,
    planCompleted: false,
    nativeUserMessageId: input.nativeUserMessageId,
    nativeAssistantMessageId: input.nativeAssistantMessageId,
    nativeCheckpointId: input.nativeCheckpointId,
    error: terminal,
    recoverable: terminal.recoverable,
  };
}
