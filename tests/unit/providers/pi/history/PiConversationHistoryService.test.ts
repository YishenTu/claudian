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

it('sanitizes known fields while preserving unknown provider state', () => {
  const service = new PiConversationHistoryService();
  const conversation = createConversation('/tmp/session.jsonl');
  conversation.providerState = {
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

it('removes only the exact stale path before falling back to its logical session id', async () => {
  const conversation = createConversation('/trusted/missing.jsonl');
  conversation.sessionId = '/trusted/missing.jsonl';
  conversation.providerState = {
    futureResumeCursor: { token: 'keep-me' },
    leafEntryId: 'assistant-1',
    parentSession: '/trusted/parent.jsonl',
    sessionFile: '/trusted/missing.jsonl',
    sessionId: 's1',
  };
  const service = new PiConversationHistoryService();

  const update1 = await service.resolveMissingConversationSession?.(
    conversation,
    '/vault',
    '/trusted/missing.jsonl',
  );
  expect(update1.outcome).toBe('reset');
  Object.assign(conversation, update1.changes);

  expect(conversation.sessionId).toBeNull();
  expect(conversation.providerState).toEqual({
    futureResumeCursor: { token: 'keep-me' },
    leafEntryId: 'assistant-1',
    parentSession: '/trusted/parent.jsonl',
    previousSessions: [{
      leafEntryId: 'assistant-1',
      sessionFile: '/trusted/missing.jsonl',
      sessionId: '/trusted/missing.jsonl',
    }],
    sessionId: 's1',
  });
  expect(service.resolveSessionIdForConversation(conversation)).toBe('s1');
});

it('does not restore a stale path after reset and persistence reconstruction', async () => {
  const missingPath = '/trusted/missing.jsonl';
  const conversation = createConversation(missingPath);
  conversation.providerState = {
    futureResumeCursor: { token: 'keep-me' },
    leafEntryId: 'assistant-1',
    parentSession: '/trusted/parent.jsonl',
    sessionFile: missingPath,
    sessionId: missingPath,
  };
  conversation.sessionId = missingPath;
  const service = new PiConversationHistoryService();

  const update2 = await service.resolveMissingConversationSession?.(
    conversation,
    '/vault',
    missingPath,
  );
  expect(update2.outcome).toBe('reset');
  Object.assign(conversation, update2.changes);

  const recreatedConversation: Conversation = {
    ...conversation,
    providerState: service.buildPersistedProviderState?.(conversation),
  };
  expect(recreatedConversation.sessionId).toBeNull();
  expect(recreatedConversation.providerState).toEqual({
    bindingRetired: true,
    futureResumeCursor: { token: 'keep-me' },
    previousSessions: [{
      leafEntryId: 'assistant-1',
      sessionFile: missingPath,
      sessionId: missingPath,
    }],
  });
  expect(
    new PiConversationHistoryService().resolveSessionIdForConversation(
      recreatedConversation,
    ),
  ).toBe(missingPath);
});

it('preserves a newer binding when the reported target is not current', async () => {
  const conversation = createConversation('/trusted/current.jsonl');
  conversation.providerState = {
    futureResumeCursor: { token: 'keep-me' },
    sessionFile: '/trusted/current.jsonl',
    sessionId: 'current-id',
  };
  const providerState = conversation.providerState;
  const service = new PiConversationHistoryService();

  const update4 = await service.resolveMissingConversationSession?.(
    conversation,
    '/vault',
    'stale-id',
  );
  expect(update4.outcome).toBe('preserve');
  Object.assign(conversation, update4.changes);

  expect(conversation.sessionId).toBe('s1');
  expect(conversation.providerState).toBe(providerState);
});
