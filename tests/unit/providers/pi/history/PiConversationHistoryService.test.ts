import type { Conversation } from '@/core/types';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

function createConversation(sessionFile: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-1',
    messages: [],
    providerId: 'pi',
    providerState: { sessionFile, sessionId: 's1' },
    sessionId: 's1',
    title: 'Pi',
    lastActivityAt: 1,
  };
}

it('sanitizes known fields, drops the retired marker, and preserves unknown provider state', () => {
  const service = new PiConversationHistoryService();
  const conversation = createConversation('/tmp/session.jsonl');
  conversation.providerState = {
    // Earlier versions marked retired bindings; the marker is dropped on the next write.
    bindingRetired: true,
    empty: '',
    futureResumeCursor: { token: 'cursor-1' },
    leafEntryId: 'leaf-1',
    parentSession: '/tmp/source.jsonl',
    previousSessions: [
      {
        leafEntryId: 'previous-leaf',
        sessionFile: '/tmp/previous.jsonl',
        sessionId: 'previous-session',
      },
      { sessionId: ' ' },
      { ignored: true },
    ],
    sessionFile: '/tmp/session.jsonl',
    sessionId: 's1',
  };

  expect(service.buildPersistedProviderState?.(conversation)).toEqual({
    empty: '',
    futureResumeCursor: { token: 'cursor-1' },
    leafEntryId: 'leaf-1',
    parentSession: '/tmp/source.jsonl',
    previousSessions: [{
      leafEntryId: 'previous-leaf',
      sessionFile: '/tmp/previous.jsonl',
      sessionId: 'previous-session',
    }],
    sessionFile: '/tmp/session.jsonl',
    sessionId: 's1',
  });
});
