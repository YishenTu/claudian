import { testClock } from '@test/helpers/testClock';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import type { ConversationMeta, SessionAutoArchiveAfter } from '@/core/types';
import { InactiveSessionArchiver } from '@/features/chat/conversation/InactiveSessionArchiver';
import { setLocale } from '@/i18n/i18n';

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
    const archiveConversations = vi.fn(async (
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

  beforeEach(() => { (Notice as unknown as Mock).mockClear(); });
  afterEach(() => setLocale('en'));

  it.each<[SessionAutoArchiveAfter, string[], string]>([
    ['7d', ['old', 'older'], 'Auto-archived 2 inactive sessions'],
    ['14d', ['older'], 'Auto-archived 1 inactive session'],
    ['30d', ['older'], 'Auto-archived 1 inactive session'],
  ])('archives unpinned closed sessions inactive longer than %s', async (after, expected, notice) => {
    const { archiver, archiveConversations } = createArchiver(after, conversations);

    await archiver.run();

    expect(archiveConversations).toHaveBeenCalledWith(expected, expect.any(Function));
    expect(Notice).toHaveBeenCalledExactlyOnceWith(notice);
  });

  it('reports the actual archived count in the current locale across successive runs', async () => {
    const candidates = [session('first', 8), session('second', 9), session('third', 10)];
    const outcomes = [
      ['en', 1, [['Auto-archived 1 inactive session']]],
      ['zh-CN', 1, [['已自动归档 1 个不活跃会话']]],
      ['zh-CN', 2, [['已自动归档 2 个不活跃会话']]],
      ['zh-CN', 0, []],
      ['en', 2, [['Auto-archived 2 inactive sessions']]],
    ] as const;
    for (const [locale, archived, notices] of outcomes) {
      setLocale(locale);
      (Notice as unknown as Mock).mockClear();
      const { archiver, archiveConversations } = createArchiver('7d', candidates);
      archiveConversations.mockResolvedValueOnce(archived);

      await archiver.run();

      expect(archiveConversations).toHaveBeenCalledExactlyOnceWith(['first', 'second', 'third'], expect.any(Function));
      expect((Notice as unknown as Mock).mock.calls).toEqual(notices);
    }
  });

  it.each([
    ['en', 'Failed to auto-archive inactive sessions'],
    ['zh-CN', '无法自动归档不活跃会话'],
  ] as const)('reports a requested archive failure in %s', async (locale, notice) => {
    setLocale(locale);
    const { archiver, archiveConversations } = createArchiver('7d', [session('old', 8)]);
    archiveConversations.mockRejectedValueOnce(new Error('write failed'));

    archiver.request();

    await vi.waitFor(() => expect(Notice).toHaveBeenCalledTimes(1));
    expect(Notice).toHaveBeenCalledWith(notice);
  });

  it('does not attempt to archive while the setting is off', async () => {
    const { archiver, archiveConversations } = createArchiver('off', conversations);

    await archiver.run();

    expect(archiveConversations).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });

  it('shows no notice when nothing is inactive', async () => {
    const idle = createArchiver('7d', [session('recent', 6)]);
    await idle.archiver.run();

    expect(idle.archiveConversations).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });
});
