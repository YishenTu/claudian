import type { ProviderExecutionEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import {
  attachRequestedTurnIdentity,
  INITIAL_REQUESTED_TURN_IDENTITY,
  reduceRequestedTurnIdentity,
  type RequestedTurnIdentity,
} from '@/features/chat/execution/RequestedTurnIdentity';

function reduce(events: Array<Record<string, unknown>>): RequestedTurnIdentity {
  return events.reduce<RequestedTurnIdentity>(
    (identity, event) => reduceRequestedTurnIdentity(identity, event as unknown as ProviderExecutionEvent),
    INITIAL_REQUESTED_TURN_IDENTITY,
  );
}

function createPair() {
  const user: ChatMessage = { id: 'user', role: 'user', content: 'Hello', timestamp: 1 };
  const assistant: ChatMessage = { id: 'assistant', role: 'assistant', content: '', timestamp: 2 };
  return { user, assistant };
}

describe('RequestedTurnIdentity', () => {
  it('ignores user echoes before the provider accepts the turn', () => {
    const identity = reduce([
      { type: 'turn_started', accepted: false, nativeUserMessageId: 'rejected-user' },
      { type: 'user_message_started', nativeUserMessageId: 'unaccepted-echo' },
    ]);
    const pair = createPair();

    attachRequestedTurnIdentity(pair, identity);

    expect(identity).toBe(INITIAL_REQUESTED_TURN_IDENTITY);
    expect(pair.user.userMessageId).toBeUndefined();
  });

  it('returns the same identity for events that carry none', () => {
    const accepted = reduce([{ type: 'turn_started', accepted: true, nativeUserMessageId: 'native-user' }]);

    expect(reduceRequestedTurnIdentity(
      accepted,
      { type: 'text_delta', text: 'hi' } as unknown as ProviderExecutionEvent,
    )).toBe(accepted);
  });

  it('stops writing to the submitted pair after a steer boundary', () => {
    const identity = reduce([
      { type: 'turn_started', accepted: true },
      { type: 'user_message_started', nativeUserMessageId: 'native-user' },
      { type: 'user_message_started', nativeUserMessageId: 'steer-user' },
      { type: 'turn_completed', nativeUserMessageId: 'steer-user', nativeCheckpointId: 'checkpoint' },
    ]);
    const pair = createPair();

    attachRequestedTurnIdentity(pair, identity);

    expect(identity).toMatchObject({ nativeUserMessageId: 'native-user', bindsSubmittedMessages: false });
    expect(pair.user.userMessageId).toBeUndefined();
    expect(pair.assistant.assistantMessageId).toBeUndefined();
  });
});
