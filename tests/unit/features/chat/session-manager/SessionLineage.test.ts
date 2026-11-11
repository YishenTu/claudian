import type { ConversationMeta, ConversationOriginKind } from '@/core/types';
import { lineageChildrenLabel } from '@/features/chat/session-manager/SessionLineage';

function child(id: string, kind: ConversationOriginKind): ConversationMeta {
  return {
    id, providerId: 'claude', title: id, createdAt: 1, lastActivityAt: 1, messageCount: 0, preview: '',
    origin: { kind, conversationId: 'parent' },
  };
}

describe('lineageChildrenLabel', () => {
  it.each([
    [['session-tool'], '1 Agent Session'],
    [['session-tool', 'session-tool', 'session-tool', 'fork'], '3 Agent Sessions · 1 Fork'],
    [['fork', 'fork'], '2 Forks'],
  ] as const)('labels %j as %s', (kinds, expected) => {
    expect(lineageChildrenLabel(kinds.map((kind, index) => child(`c${index}`, kind)))).toBe(expected);
  });
});
