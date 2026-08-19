import type {
  ConversationMeta,
  SessionManagerOrganization,
  SessionManagerSort,
} from '../../../core/types';
import { isProvisionalNotePath } from './ProvisionalNoteNames';

export { isProvisionalNotePath } from './ProvisionalNoteNames';

export type SessionListSectionKind = 'list' | 'content' | 'ungrouped' | 'missing';

export interface SessionListSection {
  key: string;
  kind: SessionListSectionKind;
  label?: string;
  contentPath?: string;
  conversations: ConversationMeta[];
}

interface OrganizeSessionListOptions {
  organization: SessionManagerOrganization;
  sort: SessionManagerSort;
  language: string;
  includeContentPaths?: readonly string[];
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
}

export function isLegacyProvisionalLinkedContent(
  contentPath: string,
  options: Pick<OrganizeSessionListOptions, 'contentExists' | 'contentIsNote' | 'language'>,
): boolean {
  if (!isProvisionalNotePath(contentPath, options.language)) return false;
  if (options.contentExists?.(contentPath) === false) return false;
  return options.contentIsNote?.(contentPath) !== false;
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

export function getLinkedContentTitle(contentPath: string): string {
  const filename = contentPath.replace(/\\/g, '/').split('/').pop() ?? contentPath;
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

  const contentGroups = new Map<string, SessionListSection>();
  for (const contentPath of options.includeContentPaths ?? []) {
    const kind: SessionListSectionKind = options.contentExists?.(contentPath) === false
      ? 'missing'
      : 'content';
    contentGroups.set(contentPath, {
      key: `${kind}:${contentPath}`,
      kind,
      label: getLinkedContentTitle(contentPath),
      contentPath,
      conversations: [],
    });
  }
  const ungrouped: ConversationMeta[] = [];
  for (const conversation of sortedConversations) {
    const contentPath = conversation.linkedContentPath;
    if (!contentPath || isLegacyProvisionalLinkedContent(contentPath, options)) {
      ungrouped.push(conversation);
      continue;
    }

    const kind: SessionListSectionKind = options.contentExists?.(contentPath) === false
      ? 'missing'
      : 'content';
    let group = contentGroups.get(contentPath);
    if (!group) {
      group = {
        key: `${kind}:${contentPath}`,
        kind,
        label: getLinkedContentTitle(contentPath),
        contentPath,
        conversations: [],
      };
      contentGroups.set(contentPath, group);
    }
    group.conversations.push(conversation);
  }

  const sections = [...contentGroups.values()];
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
