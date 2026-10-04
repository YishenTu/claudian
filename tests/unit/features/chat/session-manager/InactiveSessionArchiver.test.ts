import { testClock } from '@test/helpers/testClock';
import { Notice } from 'obsidian';

import type { ConversationMeta, SessionAutoArchiveAfter } from '@/core/types';
import { InactiveSessionArchiver } from '@/features/chat/session-manager/InactiveSessionArchiver';

describe('InactiveSessionArchiver', () => {
  const clock = testClock();
  const inactiveFor = (days: number): number => clock().getTime() - days * 86_400_000;

  function session(id: string, inactiveDays: number, extra: Partial<ConversationMeta> = {}): ConversationMeta {
    return {
      id, providerId: 'claude', title: id, messageCount: 1, preview: '',
      createdAt: inactiveFor(inactiveDays + 1), lastActivityAt: inactiveFor(inactiveDays), ...extra,
    };
  }

  function createArchiver(after: SessionAutoArchiveAfter, conversations: ConversationMeta[]) {
    const archiveConversations = jest.fn(async (
      ids: readonly string[],
      shouldArchive: (conversation: ConversationMeta) => boolean,
    ) => ids.filter(id => shouldArchive(conversations.find(conversation => conversation.id === id)!)).length);
    const host = {
      settings: { sessionAutoArchiveAfter: after },
      getConversationList: () => conversations,
      getWorkspaceConversationIds: () => new Set(['open-old']),
      conversationLifecycle: { archiveIf: archiveConversations },
    };
    return { archiver: new InactiveSessionArchiver(host as never, clock), archiveConversations };
  }

  const conversations = [
    session('recent', 6),
    session('old', 8),
    session('older', 40),
    session('pinned-old', 40, { isPinned: true }),
    session('archived-old', 40, { isArchived: true }),
    session('open-old', 40),
  ];

  beforeEach(() => { (Notice as unknown as jest.Mock).mockClear(); });

  it.each<[SessionAutoArchiveAfter, string[]]>([
    ['7d', ['old', 'older']],
    ['14d', ['older']],
    ['30d', ['older']],
  ])('archives unpinned closed sessions inactive longer than %s', async (after, expected) => {
    const { archiver, archiveConversations } = createArchiver(after, conversations);

    await archiver.run();

    expect(archiveConversations).toHaveBeenCalledWith(expected, expect.any(Function));
    expect(Notice).toHaveBeenCalledWith(`Auto-archived ${expected.length} inactive ${expected.length === 1 ? 'session' : 'sessions'}`);
  });

  it('shows no notice when nothing is inactive', async () => {
    const idle = createArchiver('7d', [session('recent', 6)]);
    await idle.archiver.run();

    expect(idle.archiveConversations).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });
});
