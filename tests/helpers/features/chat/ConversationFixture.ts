import { testDate } from '@test/helpers/testClock';

import type { Conversation } from '@/core/types';

export function conversationRecord(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return { id, sessionId: null, providerId: 'claude', title: id, createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), messages: [], ...overrides };
}
