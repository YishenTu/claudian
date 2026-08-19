import type { ConversationMeta } from '@/core/types';
import {
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
      createConversation('older', { lastActivityAt: 10 }),
      createConversation('newer', { lastActivityAt: 20 }),
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

  it('uses lastActivityAt for the last-updated sort', () => {
    const sections = organizeSessionList([
      createConversation('older-update', {
        lastActivityAt: 10,
      }),
      createConversation('newer-update', {
        lastActivityAt: 20,
      }),
    ], {
      organization: 'list',
      sort: 'last-updated',
      language: 'en',
    });

    expect(sections[0].conversations.map(conversation => conversation.id)).toEqual([
      'newer-update',
      'older-update',
    ]);
  });
});
