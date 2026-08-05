import type {
  ProviderExecutionErrorEvent,
  ProviderTurnCompletedEvent,
} from '@/core/execution';
import { createProviderExecutionOutcome } from '@/core/execution/ProviderExecutionOutcome';

const scope = {
  kind: 'requested' as const,
  sessionInstanceId: 'session-1',
  executionId: 'execution-1',
  turnId: 'turn-1',
  sequence: 1,
};

function completedEvent(): ProviderTurnCompletedEvent {
  return {
    type: 'turn_completed',
    scope,
    reason: 'completed',
    nativeAssistantId: 'assistant-1',
    nativeCheckpointId: 'checkpoint-1',
    planCompleted: true,
  };
}

function errorEvent(): ProviderExecutionErrorEvent {
  return {
    type: 'execution_error',
    scope,
    category: 'transport',
    message: 'Connection closed',
    recoverable: true,
  };
}

describe('ProviderExecutionOutcome', () => {
  it('preserves terminal completion metadata behind a provider-neutral outcome', () => {
    expect(createProviderExecutionOutcome({
      terminal: completedEvent(),
      accepted: true,
    })).toEqual({
      status: 'completed',
      accepted: true,
      planCompleted: true,
      nativeAssistantMessageId: 'assistant-1',
      nativeCheckpointId: 'checkpoint-1',
    });
  });

  it('classifies recoverable provider errors without losing the provider error event', () => {
    const terminal = errorEvent();

    expect(createProviderExecutionOutcome({
      terminal,
      accepted: true,
    })).toEqual({
      status: 'error',
      accepted: true,
      planCompleted: false,
      error: terminal,
      recoverable: true,
    });
  });

  it('represents cancellation and invalidation without requiring a provider terminal event', () => {
    expect(createProviderExecutionOutcome({
      interruption: 'cancelled',
      accepted: false,
      nativeUserMessageId: 'user-1',
      nativeAssistantMessageId: 'assistant-1',
    })).toEqual({
      status: 'cancelled',
      accepted: false,
      planCompleted: false,
      nativeUserMessageId: 'user-1',
      nativeAssistantMessageId: 'assistant-1',
    });

    expect(createProviderExecutionOutcome({
      interruption: 'invalidated',
      accepted: true,
    })).toEqual({
      status: 'invalidated',
      accepted: true,
      planCompleted: false,
    });
  });
});
