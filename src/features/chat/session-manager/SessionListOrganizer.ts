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

type SessionListSort = SessionManagerSort | 'response-activity';

interface OrganizeSessionListOptions {
  organization: SessionManagerOrganization;
  sort: SessionListSort;
  language: string;
  noteExists?: (notePath: string) => boolean;
}

function getLastUpdatedTimestamp(conversation: ConversationMeta): number {
  return conversation.updatedAt
    ?? conversation.lastResponseAt
    ?? conversation.createdAt;
}

function getResponseActivityTimestamp(conversation: ConversationMeta): number {
  return conversation.lastResponseAt ?? conversation.createdAt;
}

function compareConversations(
  left: ConversationMeta,
  right: ConversationMeta,
  sort: SessionListSort,
): number {
  if (sort === 'title') {
    return left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true })
      || getLastUpdatedTimestamp(right) - getLastUpdatedTimestamp(left)
      || left.id.localeCompare(right.id);
  }

  const getTimestamp = sort === 'created'
    ? (conversation: ConversationMeta) => conversation.createdAt
    : sort === 'response-activity'
      ? getResponseActivityTimestamp
      : getLastUpdatedTimestamp;
  const leftTimestamp = getTimestamp(left);
  const rightTimestamp = getTimestamp(right);
  return rightTimestamp - leftTimestamp
    || left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true })
    || left.id.localeCompare(right.id);
}

function getSectionTimestamp(
  section: SessionListSection,
  sort: Exclude<SessionListSort, 'title'>,
): number {
  return section.conversations.reduce((latest, conversation) => {
    const timestamp = sort === 'created'
      ? conversation.createdAt
      : sort === 'response-activity'
        ? getResponseActivityTimestamp(conversation)
        : getLastUpdatedTimestamp(conversation);
    return Math.max(latest, timestamp);
  }, 0);
}

function compareSections(
  left: SessionListSection,
  right: SessionListSection,
  sort: SessionListSort,
): number {
  if (sort === 'title') {
    return (left.label ?? '').localeCompare(right.label ?? '', undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  }
  return getSectionTimestamp(right, sort) - getSectionTimestamp(left, sort)
    || (left.label ?? '').localeCompare(right.label ?? '', undefined, {
      sensitivity: 'base',
      numeric: true,
    });
}

function getNoteLabel(notePath: string): string {
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
        label: getNoteLabel(notePath),
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
      label: 'Ungrouped',
      conversations: ungrouped,
    });
  }
  return sections.sort((left, right) => (
    compareSections(left, right, options.sort)
  ));
}
