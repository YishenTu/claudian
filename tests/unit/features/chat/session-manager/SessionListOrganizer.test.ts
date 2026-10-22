import { testClock } from '@test/helpers/testClock';

import type { ConversationMeta, ProjectReader, ProjectRecord } from '@/core/types';
import {
  deriveSessionListModel,
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
  const base = {
    organization: 'linked-content', sort: 'last-updated', projectSort: 'last-updated', language: 'en', scope: 'active',
  } as const;

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
      isGroupCollapsed: (groupKey: string) => groupKey === 'content:Projects/Plan.md',
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

describe('deriveSessionListModel with a projects section', () => {
  function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    return {
      id, name: `${id} project`, instructions: '', memoryPath: `.claudian/projects/${id}.md`,
      isPinned: false, createdAt: 1, ...overrides,
    };
  }
  function reader(records: readonly ProjectRecord[]): Pick<ProjectReader, 'list' | 'get'> {
    return {
      list: () => records,
      get: id => records.find(record => record.id === id) ?? null,
    };
  }
  const records = [
    project('alpha', { createdAt: 3 }),
    project('beta', { createdAt: 2, isPinned: true }),
    project('empty', { createdAt: 15 }),
    project('quiet', { createdAt: 40 }),
  ];
  const conversations = [
    createConversation('alpha-new', { title: 'Alpha new', projectId: 'alpha', lastActivityAt: 30, createdAt: 8 }),
    createConversation('beta-chat', { title: 'Beta chat', projectId: 'beta', lastActivityAt: 20 }),
    createConversation('alpha-old', {
      title: 'Alpha old', projectId: 'alpha', lastActivityAt: 10, linkedContentPath: 'Notes/Plan.md', isPinned: true,
    }),
    createConversation('quiet-chat', { title: 'Quiet chat', projectId: 'quiet', lastActivityAt: 12, createdAt: 2 }),
    createConversation('stale', { title: 'Stale member', projectId: 'deleted', lastActivityAt: 25 }),
    createConversation('loose', { title: 'Loose chat', lastActivityAt: 5, linkedContentPath: 'Notes/Plan.md' }),
    createConversation('pinned', { title: 'Pinned chat', isPinned: true, lastActivityAt: 4 }),
    createConversation('archived', { title: 'Old', projectId: 'alpha', isArchived: true, lastActivityAt: 50 }),
  ];
  const base = {
    organization: 'list', sort: 'last-updated', projectSort: 'last-updated', language: 'en', scope: 'active',
    projects: reader(records),
  } as const;
  const ids = (sections: readonly { conversations: readonly ConversationMeta[] }[]) => (
    sections.flatMap(section => section.conversations.map(({ id }) => id))
  );
  const projectRows = (model: ReturnType<typeof deriveSessionListModel>) => (
    (model.projectSections ?? []).map(section => [section.project.id, section.conversations.map(({ id }) => id)])
  );

  it('orders projects pinned first, then by last member activity falling back to creation', () => {
    const model = deriveSessionListModel(conversations, base);

    expect(projectRows(model)).toEqual([
      ['beta', ['beta-chat']],
      // Activity of active members only: the archived member does not lift alpha.
      ['alpha', ['alpha-new', 'alpha-old']],
      ['empty', []],
      ['quiet', ['quiet-chat']],
    ]);
    expect(model.pinnedProjectSections).toEqual([]);
    expect(model.projectSections?.every(section => section.kind === 'project')).toBe(true);
    expect(model.projectSections?.map(section => section.key)).toEqual([
      'project:beta', 'project:alpha', 'project:empty', 'project:quiet',
    ]);
  });

  it('lists a pinned project under Pinned with all its members', () => {
    const pinnedAlpha = records.map(record => (
      record.id === 'alpha' ? { ...record, isPinned: true } : { ...record, isPinned: false }
    ));
    const model = deriveSessionListModel(conversations, {
      ...base, projects: reader(pinnedAlpha), showPinnedSection: true,
    });

    expect(projectRows({ ...model, projectSections: model.pinnedProjectSections })).toEqual([
      // Its pinned member stays with the project instead of joining the pinned sessions.
      ['alpha', ['alpha-new', 'alpha-old']],
    ]);
    expect(projectRows(model).map(([id]) => id)).toEqual(['beta', 'empty', 'quiet']);
    expect(model.pinnedConversations.map(({ id }) => id)).toEqual(['pinned']);
    expect(model.isEmpty).toBe(false);
  });

  it('orders projects by creation for the created project sort', () => {
    const model = deriveSessionListModel(conversations, { ...base, projectSort: 'created' });

    expect(model.projectSections?.map(section => section.project.id)).toEqual(['beta', 'quiet', 'empty', 'alpha']);
  });

  it('keeps unpinned members out of the session list, but lists pinned members only under Pinned', () => {
    const list = deriveSessionListModel(conversations, { ...base, showPinnedSection: true });
    expect(list.pinnedConversations.map(({ id }) => id)).toEqual(['alpha-old', 'pinned']);
    expect(projectRows(list).find(([id]) => id === 'alpha')).toEqual(['alpha', ['alpha-new']]);
    expect(ids(list.sections)).toEqual(['stale', 'loose']);
    // Pinning keeps the membership: project actions still cover the pinned member.
    expect(list.conversationsByProject.get('alpha')?.map(({ id }) => id)).toEqual(['alpha-new', 'alpha-old']);

    const linked = deriveSessionListModel(conversations, { ...base, organization: 'linked-content' });
    expect(linked.sections.map(section => [section.key, section.conversations.map(({ id }) => id)])).toEqual([
      ['ungrouped', ['stale', 'pinned']],
      ['content:Notes/Plan.md', ['loose']],
    ]);
    expect(linked.conversationsByLinkedContent.get('Notes/Plan.md')?.map(({ id }) => id)).toEqual(['loose']);
    expect(linked.conversationsByProject.get('alpha')?.map(({ id }) => id)).toEqual(['alpha-new', 'alpha-old']);
  });

  it.each([
    ['unpinned', new Set<string>(), []],
    ['pinned', new Set(['Notes/Plan.md']), ['loose']],
  ])('keeps a pinned project member out of its %s Linked content group', (_case, pinnedLinkedContentPaths, pinnedGroupIds) => {
    const model = deriveSessionListModel(conversations, {
      ...base, organization: 'linked-content', showPinnedSection: true, pinnedLinkedContentPaths,
    });

    // The project wins: the member is listed under Pinned on its own, and only project actions cover it.
    expect(model.pinnedConversations.map(({ id }) => id)).toEqual(['alpha-old', 'pinned']);
    expect(ids(model.pinnedContentSections)).toEqual(pinnedGroupIds);
    expect(model.conversationsByLinkedContent.get('Notes/Plan.md')?.map(({ id }) => id)).toEqual(['loose']);
  });

  it('keeps every session in the list without a projects section or in the archive', () => {
    const { projects: _projects, ...withoutProjects } = base;
    const flat = deriveSessionListModel(conversations, withoutProjects);
    expect(flat.projectSections).toBeNull();
    expect(ids(flat.sections)).toHaveLength(conversations.length - 1);

    const archived = deriveSessionListModel(conversations, { ...base, scope: 'archived' });
    expect(archived.projectSections).toBeNull();
    expect(ids(archived.sections)).toEqual(['archived']);
  });

  it('shows empty projects while there are no sessions', () => {
    const model = deriveSessionListModel([], base);

    expect(model.projectSections?.map(section => section.project.id)).toEqual(['beta', 'quiet', 'empty', 'alpha']);
    expect(model.isEmpty).toBe(true);
  });

  it('keeps projects with matching members or a matching name while searching', () => {
    const byMember = deriveSessionListModel(conversations, { ...base, searchQuery: 'old' });
    expect(projectRows(byMember)).toEqual([['alpha', ['alpha-old']]]);
    expect(byMember.conversationsByProject.get('alpha')?.map(({ id }) => id)).toEqual(['alpha-new', 'alpha-old']);

    const byName = deriveSessionListModel(conversations, { ...base, searchQuery: 'empty project' });
    expect(projectRows(byName)).toEqual([['empty', []]]);
    expect(byName.isEmpty).toBe(true);
  });

  it('finds a member listed under Pinned by its project name, as its unpinned siblings are', () => {
    const model = deriveSessionListModel(conversations, { ...base, showPinnedSection: true, searchQuery: 'alpha project' });

    expect(projectRows(model)).toEqual([['alpha', ['alpha-new']]]);
    expect(model.pinnedConversations.map(({ id }) => id)).toEqual(['alpha-old']);
  });
});
