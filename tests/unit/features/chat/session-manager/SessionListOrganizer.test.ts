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
      createConversation('a', { currentNote: 'Projects/A/Plan.md', lastActivityAt: 10 }),
      createConversation('b', { currentNote: 'Projects/B/Plan.md', lastActivityAt: 30 }),
      createConversation('c', { currentNote: 'Projects/A/Plan.md', lastActivityAt: 20 }),
    ], {
      organization: 'linked-note',
      sort: 'last-updated',
      language: 'en',
      noteExists: () => true,
    });

    expect(sections.map(section => section.notePath)).toEqual([
      'Projects/B/Plan.md',
      'Projects/A/Plan.md',
    ]);
    expect(sections.map(section => section.label)).toEqual(['Plan', 'Plan']);
    expect(sections[1].conversations.map(conversation => conversation.id)).toEqual(['c', 'a']);
  });

  it('keeps unlinked and provisional sessions out of note groups', () => {
    const sections = organizeSessionList([
      createConversation('unlinked', { lastActivityAt: 20 }),
      createConversation('provisional', {
        currentNote: 'Inbox/Untitled 2.md',
        lastActivityAt: 30,
      }),
      createConversation('linked', {
        currentNote: 'Notes/Real note.md',
        lastActivityAt: 10,
      }),
    ], {
      organization: 'linked-note',
      sort: 'last-updated',
      language: 'en',
      noteExists: () => true,
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ kind: 'ungrouped', label: 'Unlinked' });
    expect(sections[0].conversations.map(conversation => conversation.id)).toEqual([
      'provisional',
      'unlinked',
    ]);
    expect(sections[1]).toMatchObject({ kind: 'note', notePath: 'Notes/Real note.md' });
  });

  it('retains missing note paths as distinct missing groups', () => {
    const sections = organizeSessionList([
      createConversation('missing-a', { currentNote: 'Gone/A.md' }),
      createConversation('missing-b', { currentNote: 'Gone/B.md' }),
    ], {
      organization: 'linked-note',
      sort: 'created',
      language: 'en',
      noteExists: () => false,
    });

    expect(sections.map(section => ({
      kind: section.kind,
      label: section.label,
      notePath: section.notePath,
    }))).toEqual([
      { kind: 'missing', label: 'A', notePath: 'Gone/A.md' },
      { kind: 'missing', label: 'B', notePath: 'Gone/B.md' },
    ]);
  });

  it('includes requested linked-note groups even when they have no sessions', () => {
    const sections = organizeSessionList([], {
      organization: 'linked-note',
      sort: 'last-updated',
      language: 'en',
      includeNotePaths: ['Projects/Plan.md'],
      noteExists: () => true,
    });

    expect(sections).toEqual([{
      conversations: [],
      key: 'note:Projects/Plan.md',
      kind: 'note',
      label: 'Plan',
      notePath: 'Projects/Plan.md',
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
