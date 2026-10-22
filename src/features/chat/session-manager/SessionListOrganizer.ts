import type {
  ConversationMeta,
  ProjectReader,
  ProjectRecord,
  SessionManagerOrganization,
  SessionManagerSort,
} from '@/core/types';
import { resolveLiveProject } from '@/features/chat/execution/projectInstructions';
import { isProvisionalNotePath } from '@/features/chat/session-manager/ProvisionalNoteNames';

export type SessionListSectionKind = 'list' | 'recency' | 'content' | 'ungrouped' | 'missing' | 'project';

export interface SessionListSection {
  key: string;
  kind: SessionListSectionKind;
  label?: string;
  contentPath?: string;
  projectId?: string;
  conversations: ConversationMeta[];
}

/** Live project records; a conversation's `projectId` counts only when `get` resolves it. */
export type SessionListProjects = Pick<ProjectReader, 'list' | 'get'>;

interface OrganizeSessionListOptions {
  organization: SessionManagerOrganization;
  sort: SessionManagerSort;
  language: string;
  includeContentPaths?: readonly string[];
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  /** Splits the flat list into recency groups relative to `now`. */
  groupByRecency?: { now: number };
}

const DAY_MS = 86_400_000;
const RECENCY_GROUPS: ReadonlyArray<{ key: string; label: string; maxAgeDays: number }> = [
  { key: 'recency:7d', label: 'Past week', maxAgeDays: 7 },
  { key: 'recency:14d', label: 'Past 2 weeks', maxAgeDays: 14 },
  { key: 'recency:30d', label: 'Past month', maxAgeDays: 30 },
  { key: 'recency:older', label: 'Older', maxAgeDays: Infinity },
];

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

function getSortTimestamp(conversation: ConversationMeta, sort: SessionManagerSort): number {
  return sort === 'created' ? conversation.createdAt : getLastActivityTimestamp(conversation);
}

function groupByRecency(
  sortedConversations: readonly ConversationMeta[],
  sort: SessionManagerSort,
  now: number,
): SessionListSection[] {
  const sections = RECENCY_GROUPS.map(({ key, label }): SessionListSection => ({
    key,
    kind: 'recency',
    label,
    conversations: [],
  }));
  for (const conversation of sortedConversations) {
    const ageDays = (now - getSortTimestamp(conversation, sort)) / DAY_MS;
    const index = RECENCY_GROUPS.findIndex(({ maxAgeDays }) => ageDays < maxAgeDays);
    sections[index].conversations.push(conversation);
  }
  return sections.filter(section => section.conversations.length > 0);
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

export function projectSectionKey(projectId: string): string {
  return `project:${projectId}`;
}

/** Collapse key of a whole session-manager section; kept with the group keys so search expands it too. */
export function sessionManagerSectionKey(section: 'projects' | 'sessions' | 'archived'): string {
  return `section:${section}`;
}

/**
 * Pinned projects first, then by the project sort: latest member activity (creation for a project without
 * members) or creation. Each section holds its members in session order.
 */
function organizeProjects(
  records: readonly ProjectRecord[],
  membersByProject: ReadonlyMap<string, readonly ConversationMeta[]>,
  projectSort: SessionManagerSort,
  sort: SessionManagerSort,
  visibleMembers: (record: ProjectRecord, members: readonly ConversationMeta[]) => readonly ConversationMeta[],
): SessionListSection[] {
  const timestamp = (record: ProjectRecord): number => {
    const members = membersByProject.get(record.id) ?? [];
    if (projectSort === 'created' || members.length === 0) return record.createdAt;
    return Math.max(...members.map(getLastActivityTimestamp));
  };
  return [...records]
    .sort((left, right) => (
      Number(right.isPinned) - Number(left.isPinned)
      || timestamp(right) - timestamp(left)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
      || left.id.localeCompare(right.id)
    ))
    .map(record => ({
      key: projectSectionKey(record.id),
      kind: 'project',
      label: record.name,
      projectId: record.id,
      conversations: [...visibleMembers(record, membersByProject.get(record.id) ?? [])]
        .sort((left, right) => compareConversations(left, right, sort)),
    }));
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
    if (options.groupByRecency) {
      return groupByRecency(sortedConversations, options.sort, options.groupByRecency.now);
    }
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

export interface SessionListModelOptions {
  organization: SessionManagerOrganization;
  sort: SessionManagerSort;
  language: string;
  scope?: 'active' | 'archived';
  searchQuery?: string;
  /** Partitions pinned sessions and pinned Linked content into their own section. */
  showPinnedSection?: boolean;
  pinnedLinkedContentPaths?: ReadonlySet<string>;
  /**
   * Live project records for a projects section outside the archive. Members of a live project are listed
   * only there, unless pinned with a Pinned section; without it, or in the archive, every session stays in
   * the session list.
   */
  projects?: SessionListProjects;
  projectSort?: SessionManagerSort;
  collapsedGroupKeys?: ReadonlySet<string>;
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  /** Divides an unpinned flat list into recency groups relative to `now`. */
  groupByRecency?: { now: number };
}

/** What a session list shows, derived from the conversation list without any DOM. */
export interface SessionListModel {
  readonly hasSearchTerms: boolean;
  /** No session or pinned Linked content group matches the scope and search; projects do not count. */
  readonly isEmpty: boolean;
  /**
   * Every live project matching the search, pinned first, with its matching members (pinned members are listed
   * under Pinned instead); null without the section.
   */
  readonly projectSections: readonly SessionListSection[] | null;
  readonly pinnedContentSections: readonly SessionListSection[];
  /** Pinned sessions outside pinned Linked content groups, in list order. */
  readonly pinnedConversations: readonly ConversationMeta[];
  readonly sections: readonly SessionListSection[];
  /** Group keys in display order for Linked content organization; null for flat lists. */
  readonly groupKeys: readonly string[] | null;
  /** Every in-scope session per Linked content path, ignoring search, for group actions. */
  readonly conversationsByLinkedContent: ReadonlyMap<string, readonly ConversationMeta[]>;
  /** Every in-scope session per live project, ignoring search, for project actions and counts. */
  readonly conversationsByProject: ReadonlyMap<string, readonly ConversationMeta[]>;
  /** Session list rows shown when every expanded group is fully paged in. */
  readonly visibleConversationTotal: number;
}

function getSearchTerms(searchQuery: string | undefined): string[] {
  return (searchQuery ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function groupBy(
  conversations: readonly ConversationMeta[],
  keyOf: (conversation: ConversationMeta) => string | undefined,
): Map<string, ConversationMeta[]> {
  const groups = new Map<string, ConversationMeta[]>();
  for (const conversation of conversations) {
    const key = keyOf(conversation);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(conversation);
    groups.set(key, group);
  }
  return groups;
}

/** Scopes, searches, partitions, and organizes sessions for one list render. */
export function deriveSessionListModel(
  conversations: readonly ConversationMeta[],
  options: SessionListModelOptions,
): SessionListModel {
  const { organization, sort, language } = options;
  const isGrouped = organization === 'linked-content';
  const scopedConversations = options.scope === 'archived'
    ? conversations.filter(conversation => conversation.isArchived)
    : options.scope === 'active'
      ? conversations.filter(conversation => !conversation.isArchived)
      : conversations;
  const searchTerms = getSearchTerms(options.searchQuery);
  const matchesSearch = (text: string): boolean => {
    const searchableText = text.toLocaleLowerCase();
    return searchTerms.every(term => searchableText.includes(term));
  };
  const projects = options.scope === 'archived' ? undefined : options.projects;
  const liveProjectId = (conversation: ConversationMeta): string | undefined => (
    projects ? resolveLiveProject(projects, conversation.projectId)?.id : undefined
  );
  const conversationsByProject = groupBy(scopedConversations, liveProjectId);
  // Pinning keeps the membership, but a pinned member is listed under Pinned instead of its project.
  const isListedAsPinned = (conversation: ConversationMeta): boolean => (
    !!options.showPinnedSection && conversation.isPinned === true
  );
  const listedConversations = projects
    ? scopedConversations.filter(conversation => !liveProjectId(conversation) || isListedAsPinned(conversation))
    : scopedConversations;
  const matchesConversation = (conversation: ConversationMeta): boolean => (
    matchesSearch([conversation.title, conversation.linkedContentPath ?? ''].join('\n'))
  );
  const filteredConversations = searchTerms.length === 0
    ? listedConversations
    : listedConversations.filter(matchesConversation);
  const projectSections = projects
    ? organizeProjects(
        projects.list(),
        conversationsByProject,
        options.projectSort ?? 'last-updated',
        sort,
        (record, members) => {
          const unpinnedMembers = members.filter(conversation => !isListedAsPinned(conversation));
          return searchTerms.length === 0 || matchesSearch(record.name)
            ? unpinnedMembers
            : unpinnedMembers.filter(matchesConversation);
        },
      ).filter(section => (
        searchTerms.length === 0 || section.conversations.length > 0 || matchesSearch(section.label ?? '')
      ))
    : null;
  const conversationsByLinkedContent = groupBy(
    listedConversations,
    conversation => conversation.linkedContentPath,
  );
  const pinnedLinkedContentPaths = isGrouped
    && options.showPinnedSection
    && options.scope !== 'archived'
    ? options.pinnedLinkedContentPaths ?? new Set<string>()
    : new Set<string>();
  const isInPinnedContentGroup = (conversation: ConversationMeta): boolean => (
    !!conversation.linkedContentPath
    && pinnedLinkedContentPaths.has(conversation.linkedContentPath)
  );
  const pinnedContentConversations = filteredConversations.filter(isInPinnedContentGroup);
  const pinnedConversations = options.showPinnedSection
    ? filteredConversations.filter(conversation => (
        conversation.isPinned && !isInPinnedContentGroup(conversation)
      ))
    : [];
  const sessionConversations = options.showPinnedSection
    ? filteredConversations.filter(conversation => (
        !conversation.isPinned && !isInPinnedContentGroup(conversation)
      ))
    : filteredConversations;
  const pinnedPathsWithMatchingSessions = new Set(
    pinnedContentConversations.flatMap(conversation => (
      conversation.linkedContentPath ? [conversation.linkedContentPath] : []
    )),
  );
  const visiblePinnedContentPaths = [...pinnedLinkedContentPaths].filter(contentPath => (
    searchTerms.length === 0
    || pinnedPathsWithMatchingSessions.has(contentPath)
    || matchesSearch(contentPath)
  ));
  const pinnedContentSections = organizeSessionList(pinnedContentConversations, {
    organization: 'linked-content',
    sort,
    language,
    includeContentPaths: visiblePinnedContentPaths,
    contentExists: options.contentExists,
    contentIsNote: options.contentIsNote,
  }).filter(section => section.contentPath !== undefined);
  const isEmpty = filteredConversations.length === 0 && pinnedContentSections.length === 0;
  if (isEmpty) {
    return {
      hasSearchTerms: searchTerms.length > 0,
      isEmpty,
      projectSections,
      pinnedContentSections,
      pinnedConversations: [],
      sections: [],
      groupKeys: isGrouped ? [] : null,
      conversationsByLinkedContent,
      conversationsByProject,
      visibleConversationTotal: 0,
    };
  }

  const sortedPinnedConversations = organizeSessionList(pinnedConversations, {
    organization: 'list',
    sort,
    language,
  })[0]?.conversations ?? [];
  const sections = organizeSessionList(sessionConversations, {
    organization,
    sort,
    language,
    contentExists: options.contentExists,
    contentIsNote: options.contentIsNote,
    groupByRecency: options.groupByRecency,
  });
  const countExpanded = (groupSections: readonly SessionListSection[]): number => (
    groupSections.reduce((total, section) => (
      options.collapsedGroupKeys?.has(section.key) ? total : total + section.conversations.length
    ), 0)
  );
  const visibleSessionConversationTotal = isGrouped
    ? countExpanded(sections)
    : sessionConversations.length;
  return {
    hasSearchTerms: searchTerms.length > 0,
    isEmpty,
    projectSections,
    pinnedContentSections,
    pinnedConversations: sortedPinnedConversations,
    sections,
    groupKeys: isGrouped
      ? [...pinnedContentSections.map(({ key }) => key), ...sections.map(({ key }) => key)]
      : null,
    conversationsByLinkedContent,
    conversationsByProject,
    visibleConversationTotal: countExpanded(pinnedContentSections)
      + sortedPinnedConversations.length
      + visibleSessionConversationTotal,
  };
}
