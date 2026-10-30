import { testDate } from '@test/helpers/testClock';

import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

it.each([
  { state: { forkSource: { sessionId: 'source', resumeAt: 'turn-1' } }, sessionId: null, pending: true, resolved: 'source' },
  { state: { threadId: 'fork-thread', forkSource: { sessionId: 'source', resumeAt: 'turn-1' } }, sessionId: null, pending: false, resolved: 'fork-thread' },
  { state: { threadId: 'thread' }, sessionId: 'thread', pending: false, resolved: 'thread' },
])('resolves the native identity and pending-fork state for $state', ({ state, sessionId, pending, resolved }) => {
  const conversation: Conversation = {
    id: 'conversation', providerId: 'codex', title: 'Conversation', sessionId, providerState: state, messages: [],
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  const service = new CodexConversationHistoryService();
  expect(service.isPendingForkConversation(conversation)).toBe(pending);
  expect(service.resolveSessionIdForConversation(conversation)).toBe(resolved);
});
