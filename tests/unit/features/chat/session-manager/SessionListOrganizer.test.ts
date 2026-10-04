import { testClock } from '@test/helpers/testClock';

import type { ConversationMeta } from '@/core/types';
import {
  deriveSessionListModel,
  isProvisionalNotePath,
  organizeSessionList,
} from '@/features/chat/session-manager/SessionListOrganizer';

function createConversation(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  return {
    id,
    providerId: 'claude',
    title: id,
    createdAt: 1,
    lastActivityAt: 1,
    messageCount: 0,
    preview: '',
    ...overrides,
  };
}

describe('SessionListOrganizer', () => {
  it.each([
    ['Untitled.md', 'en'],
    ['Untitled 1.md', 'en'],
    ['Untitled 42.md', 'en'],
    ['未命名.md', 'zh'],
    ['未命名 2.md', 'zh-TW'],
    ['Notes/Sans titre 3.md', 'fr'],
  ])('recognizes the localized provisional note path %s', (path, language) => {
    expect(isProvisionalNotePath(path, language)).toBe(true);
  });

  it.each([
    ['Untitled project.md', 'en'],
    ['Untitled-1.md', 'en'],
    ['未命名项目.md', 'zh'],
    ['Sans titre final.md', 'fr'],
  ])('does not overmatch the ordinary note path %s', (path, language) => {
    expect(isProvisionalNotePath(path, language)).toBe(false);
  });

  it('groups by full note path and keeps same-name notes in separate groups', () => {
    const sections = organizeSessionList([
      createConversation('a', { linkedContentPath: 'Projects/A/Plan.md', lastActivityAt: 10 }),
      createConversation('b', { linkedContentPath: 'Projects/B/Plan.md', lastActivityAt: 30 }),
      createConversation('c', { linkedContentPath: 'Projects/A/Plan.md', lastActivityAt: 20 }),
    ], {
      organization: 'linked-content',
      sort: 'last-updated',
      language: 'en',
      contentExists: () => true,
    });

    expect(sections.map(section => section.contentPath)).toEqual([
      'Projects/B/Plan.md',
      'Projects/A/Plan.md',
    ]);
    expect(sections.map(section => section.label)).toEqual(['Plan', 'Plan']);
    expect(sections[1].conversations.map(conversation => conversation.id)).toEqual(['c', 'a']);
  });

  it('keeps unlinked and provisional sessions out of content groups', () => {
    const sections = organizeSessionList([
      createConversation('unlinked', { lastActivityAt: 20 }),
      createConversation('provisional', {
        linkedContentPath: 'Inbox/Untitled 2.md',
        lastActivityAt: 30,
      }),
      createConversation('linked', {
        linkedContentPath: 'Notes/Real note.md',
        lastActivityAt: 10,
      }),
    ], {
      organization: 'linked-content',
      sort: 'last-updated',
      language: 'en',
      contentExists: () => true,
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ kind: 'ungrouped', label: 'Unlinked' });
    expect(sections[0].conversations.map(conversation => conversation.id)).toEqual([
      'provisional',
      'unlinked',
    ]);
    expect(sections[1]).toMatchObject({ kind: 'content', contentPath: 'Notes/Real note.md' });
  });

  it('does not suppress existing folders or non-Note files with provisional names', () => {
    const sections = organizeSessionList([
      createConversation('folder', {
        linkedContentPath: 'Projects/Untitled',
        lastActivityAt: 20,
      }),
      createConversation('file', {
        linkedContentPath: 'Assets/Untitled',
        lastActivityAt: 10,
      }),
    ], {
      organization: 'linked-content',
      sort: 'last-updated',
      language: 'en',
      contentExists: () => true,
      contentIsNote: () => false,
    });

    expect(sections.map(section => section.contentPath)).toEqual([
      'Projects/Untitled',
      'Assets/Untitled',
    ]);
    expect(sections.flatMap(section => section.conversations).map(({ id }) => id))
      .toEqual(['folder', 'file']);
  });

  it('retains missing note paths as distinct missing groups', () => {
    const sections = organizeSessionList([
      createConversation('missing-a', { linkedContentPath: 'Gone/A.md' }),
      createConversation('missing-b', { linkedContentPath: 'Gone/B.md' }),
      createConversation('missing-untitled', { linkedContentPath: 'Gone/Untitled.md' }),
    ], {
      organization: 'linked-content',
      sort: 'created',
      language: 'en',
      contentExists: () => false,
    });

    expect(sections.map(section => ({
      kind: section.kind,
      label: section.label,
      contentPath: section.contentPath,
    }))).toEqual([
      { kind: 'missing', label: 'A', contentPath: 'Gone/A.md' },
      { kind: 'missing', label: 'B', contentPath: 'Gone/B.md' },
      { kind: 'missing', label: 'Untitled', contentPath: 'Gone/Untitled.md' },
    ]);
  });

  it('includes requested linked-content groups even when they have no sessions', () => {
    const sections = organizeSessionList([], {
      organization: 'linked-content',
      sort: 'last-updated',
      language: 'en',
      includeContentPaths: ['Projects/Plan.md'],
      contentExists: () => true,
    });

    expect(sections).toEqual([{
      conversations: [],
      key: 'content:Projects/Plan.md',
      kind: 'content',
      label: 'Plan',
      contentPath: 'Projects/Plan.md',
    }]);
  });

  it('returns one flat section for the chronological organization', () => {
    const sections = organizeSessionList([
      createConversation('older', { title: 'A older', createdAt: 2, lastActivityAt: 10 }),
      createConversation('newer', { title: 'Z newer', createdAt: 1, lastActivityAt: 20 }),
    ], {
      organization: 'list',
      sort: 'last-updated',
      language: 'en',
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('list');
    expect(sections[0].conversations.map(conversation => conversation.id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it.each(['last-updated', 'created'] as const)(
    'splits the flat list into recency groups by the %s timestamp',
    (sort) => {
      const now = testClock();
      const ago = (days: number): number => now().getTime() - days * 86_400_000;
      const at = (days: number): Partial<ConversationMeta> => (
        sort === 'created'
          ? { createdAt: ago(days), lastActivityAt: ago(0) }
          : { createdAt: ago(100), lastActivityAt: ago(days) }
      );
      const sections = organizeSessionList([
        createConversation('today', at(0)),
        createConversation('six-days', at(6.9)),
        createConversation('seven-days', at(7)),
        createConversation('thirteen-days', at(13.9)),
        createConversation('fourteen-days', at(14)),
        createConversation('twenty-nine-days', at(29.9)),
        createConversation('thirty-days', at(30)),
        createConversation('ancient', at(400)),
      ], {
        organization: 'list',
        sort,
        language: 'en',
        groupByRecency: { now: now().getTime() },
      });

      expect(sections.map(section => [section.label, section.conversations.map(({ id }) => id)])).toEqual([
        ['Past week', ['today', 'six-days']],
        ['Past 2 weeks', ['seven-days', 'thirteen-days']],
        ['Past month', ['fourteen-days', 'twenty-nine-days']],
        ['Older', ['thirty-days', 'ancient']],
      ]);
    },
  );
});

describe('deriveSessionListModel', () => {
  const conversations = [
    createConversation('plan-a', { title: 'Plan draft', linkedContentPath: 'Projects/Plan.md', lastActivityAt: 5 }),
    createConversation('plan-b', { title: 'Plan review', linkedContentPath: 'Projects/Plan.md', lastActivityAt: 4 }),
    createConversation('pinned', { title: 'Pinned chat', isPinned: true, lastActivityAt: 3 }),
    createConversation('loose', { title: 'Loose chat', lastActivityAt: 2 }),
    createConversation('archived', { title: 'Old chat', isArchived: true, lastActivityAt: 1 }),
  ];
  const base = { organization: 'linked-content', sort: 'last-updated', language: 'en', scope: 'active' } as const;

  it('partitions pinned sessions and pinned Linked content out of the session groups', () => {
    const model = deriveSessionListModel(conversations, {
      ...base,
      showPinnedSection: true,
      pinnedLinkedContentPaths: new Set(['Projects/Plan.md']),
    });

    expect(model.pinnedContentSections.map(section => section.conversations.map(({ id }) => id)))
      .toEqual([['plan-a', 'plan-b']]);
    expect(model.pinnedConversations.map(({ id }) => id)).toEqual(['pinned']);
    expect(model.sections.flatMap(section => section.conversations.map(({ id }) => id))).toEqual(['loose']);
    expect(model.groupKeys).toEqual(['content:Projects/Plan.md', 'ungrouped']);
    expect(model.visibleConversationTotal).toBe(4);
  });

  it('keeps group actions on every in-scope session while search narrows the rows', () => {
    const model = deriveSessionListModel(conversations, { ...base, searchQuery: 'review' });

    expect(model.sections.flatMap(section => section.conversations.map(({ id }) => id))).toEqual(['plan-b']);
    expect(model.conversationsByLinkedContent.get('Projects/Plan.md')?.map(({ id }) => id))
      .toEqual(['plan-a', 'plan-b']);
    expect(model.hasSearchTerms).toBe(true);
  });

  it('excludes collapsed groups from the paged total', () => {
    const model = deriveSessionListModel(conversations, {
      ...base,
      collapsedGroupKeys: new Set(['content:Projects/Plan.md']),
    });

    expect(model.visibleConversationTotal).toBe(2);
  });

  it('reports an empty archived search with no group keys for a flat list', () => {
    const model = deriveSessionListModel(conversations, {
      ...base,
      organization: 'list',
      scope: 'archived',
      searchQuery: 'missing',
    });

    expect(model.isEmpty).toBe(true);
    expect(model.hasSearchTerms).toBe(true);
    expect(model.groupKeys).toBeNull();
  });
});
