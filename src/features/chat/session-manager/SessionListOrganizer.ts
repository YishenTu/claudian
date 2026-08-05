import type {
  ConversationMeta,
  SessionManagerOrganization,
  SessionManagerSort,
} from '../../../core/types';
import { isProvisionalNotePath } from './ProvisionalNoteNames';

export { isProvisionalNotePath } from './ProvisionalNoteNames';

export type SessionListSectionKind = 'list' | 'note' | 'ungrouped' | 'missing';

export interface SessionListSection {
  key: string;
  kind: SessionListSectionKind;
  label?: string;
  notePath?: string;
  conversations: ConversationMeta[];
}

interface OrganizeSessionListOptions {
  organization: SessionManagerOrganization;
  sort: SessionManagerSort;
  language: string;
  includeNotePaths?: readonly string[];
  noteExists?: (notePath: string) => boolean;
}

function getLastActivityTimestamp(conversation: ConversationMeta): number {
  return conversation.lastActivityAt;
}

function compareConversations(
  left: ConversationMeta,
  right: ConversationMeta,
  sort: SessionManagerSort,
): number {
  const getTimestamp = sort === 'created'
    ? (conversation: ConversationMeta) => conversation.createdAt
    : getLastActivityTimestamp;
  const leftTimestamp = getTimestamp(left);
  const rightTimestamp = getTimestamp(right);
  return rightTimestamp - leftTimestamp
    || left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true })
    || left.id.localeCompare(right.id);
}

function getSectionTimestamp(
  section: SessionListSection,
  sort: SessionManagerSort,
): number {
  return section.conversations.reduce((latest, conversation) => {
    const timestamp = sort === 'created'
      ? conversation.createdAt
      : getLastActivityTimestamp(conversation);
    return Math.max(latest, timestamp);
  }, 0);
}

function compareSections(
  left: SessionListSection,
  right: SessionListSection,
  sort: SessionManagerSort,
): number {
  return getSectionTimestamp(right, sort) - getSectionTimestamp(left, sort)
    || (left.label ?? '').localeCompare(right.label ?? '', undefined, {
      sensitivity: 'base',
      numeric: true,
    });
}

export function getLinkedNoteTitle(notePath: string): string {
  const filename = notePath.replace(/\\/g, '/').split('/').pop() ?? notePath;
  return filename.replace(/\.md$/i, '');
}

export function organizeSessionList(
  conversations: readonly ConversationMeta[],
  options: OrganizeSessionListOptions,
): SessionListSection[] {
  const sortedConversations = [...conversations].sort((left, right) => (
    compareConversations(left, right, options.sort)
  ));
  if (options.organization === 'list') {
    return [{
      key: 'list',
      kind: 'list',
      conversations: sortedConversations,
    }];
  }

  const noteGroups = new Map<string, SessionListSection>();
  for (const notePath of options.includeNotePaths ?? []) {
    const kind: SessionListSectionKind = options.noteExists?.(notePath) === false
      ? 'missing'
      : 'note';
    noteGroups.set(notePath, {
      key: `${kind}:${notePath}`,
      kind,
      label: getLinkedNoteTitle(notePath),
      notePath,
      conversations: [],
    });
  }
  const ungrouped: ConversationMeta[] = [];
  for (const conversation of sortedConversations) {
    const notePath = conversation.currentNote;
    if (!notePath || isProvisionalNotePath(notePath, options.language)) {
      ungrouped.push(conversation);
      continue;
    }

    const kind: SessionListSectionKind = options.noteExists?.(notePath) === false
      ? 'missing'
      : 'note';
    let group = noteGroups.get(notePath);
    if (!group) {
      group = {
        key: `${kind}:${notePath}`,
        kind,
        label: getLinkedNoteTitle(notePath),
        notePath,
        conversations: [],
      };
      noteGroups.set(notePath, group);
    }
    group.conversations.push(conversation);
  }

  const sections = [...noteGroups.values()];
  if (ungrouped.length > 0) {
    sections.push({
      key: 'ungrouped',
      kind: 'ungrouped',
      label: 'Unlinked',
      conversations: ungrouped,
    });
  }
  return sections.sort((left, right) => (
    compareSections(left, right, options.sort)
  ));
}
