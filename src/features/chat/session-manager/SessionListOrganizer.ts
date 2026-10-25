import type {
  ConversationMeta,
  ProjectReader,
  ProjectRecord,
  SessionManagerOrganization,
  SessionManagerSort,
} from '@/core/types';
import { compareProjectNames } from '@/features/chat/projects/projectOrder';
import { isProvisionalNotePath } from '@/features/chat/session-manager/ProvisionalNoteNames';

export type SessionListSectionKind = 'list' | 'recency' | 'content' | 'ungrouped' | 'missing' | 'project';

export interface SessionListSection {
  key: string;
  kind: SessionListSectionKind;
  label?: string;
  contentPath?: string;
  conversations: ConversationMeta[];
}

/** A live project with its listed members. */
export interface ProjectListSection extends SessionListSection {
  kind: 'project';
  project: ProjectRecord;
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

const PROJECT_SECTION_KEY_PREFIX = 'project:';

export function projectSectionKey(projectId: string): string {
  return `${PROJECT_SECTION_KEY_PREFIX}${projectId}`;
}

export function isProjectSectionKey(key: string): boolean {
  return key.startsWith(PROJECT_SECTION_KEY_PREFIX);
}

/** Collapse key of a whole session-manager section; kept with the group keys so search expands it too. */
export function sessionManagerSectionKey(section: 'projects' | 'sessions' | 'archived'): string {
  return `section:${section}`;
}

/**
 * Pinned projects first, then by the project sort: latest member activity (creation for a project without
 * members) or creation.
 */
function sortProjects(
  records: readonly ProjectRecord[],
  membersByProject: ReadonlyMap<string, readonly ConversationMeta[]>,
  projectSort: SessionManagerSort,
): ProjectRecord[] {
  const timestamp = (record: ProjectRecord): number => {
    const members = membersByProject.get(record.id) ?? [];
    if (projectSort === 'created' || members.length === 0) return record.createdAt;
    return Math.max(...members.map(getLastActivityTimestamp));
  };
  return [...records].sort((left, right) => (
    Number(right.isPinned) - Number(left.isPinned)
    || timestamp(right) - timestamp(left)
    || compareProjectNames(left, right)
    || left.id.localeCompare(right.id)
  ));
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
   * Live project records for a projects section: unarchived projects outside the archive, archived ones in it.
   * Members of a listed project are listed only there, unless pinned with a Pinned section; without it, every
   * session stays in the session list.
   */
  projects?: SessionListProjects;
  projectSort: SessionManagerSort;
  isGroupCollapsed?: (groupKey: string) => boolean;
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  /** Divides an unpinned flat list into recency groups relative to `now`. */
  groupByRecency?: { now: number };
}

/** The projects listed in a scope; an archived project is listed only in the archive, an active one only outside. */
function projectsInScope(
  projects: SessionListProjects | undefined,
  scope: SessionListModelOptions['scope'],
): SessionListProjects | undefined {
  if (!projects) return undefined;
  const isListed = (project: ProjectRecord): boolean => project.isArchived === (scope === 'archived');
  return {
    list: () => projects.list().filter(isListed),
    get: (id) => {
      const project = projects.get(id);
      return project && isListed(project) ? project : null;
    },
  };
}

/** What a session list shows, derived from the conversation list without any DOM. */
export interface SessionListModel {
  readonly hasSearchTerms: boolean;
  /** No session or pinned Linked content group matches the scope and search; projects do not count. */
  readonly isEmpty: boolean;
  /**
   * Every listed project matching the search, pinned first, with its matching members (pinned members are listed
   * under Pinned instead); null without the section, or in the archive when none matches. With a Pinned section,
   * pinned projects move there.
   */
  readonly projectSections: readonly ProjectListSection[] | null;
  /** Pinned projects listed under Pinned with all their matching members, pinned or not. */
  readonly pinnedProjectSections: readonly ProjectListSection[];
  readonly pinnedContentSections: readonly SessionListSection[];
  /** Pinned sessions outside pinned Linked content groups, in list order. */
  readonly pinnedConversations: readonly ConversationMeta[];
  readonly sections: readonly SessionListSection[];
  /** Group keys in display order for Linked content organization; null for flat lists. */
  readonly groupKeys: readonly string[] | null;
  /** Every in-scope session per Linked content path outside a live project, ignoring search, for group actions. */
  readonly conversationsByLinkedContent: ReadonlyMap<string, readonly ConversationMeta[]>;
  /** Every in-scope session per listed project, ignoring search and pinning, for project actions. */
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

/**
 * Scopes, searches, partitions, and organizes sessions for one list render.
 *
 * Sessions group by live project (its own section, active scope only) or, with Linked content organization, by
 * Linked content; project membership wins. Pinning only moves a session, project, or Linked content group to
 * Pinned, where a pinned group keeps all its members. Archived projects are listed only in the archive, with their
 * archived members; archived members of an active project are listed there as sessions.
 */
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
  const projects = projectsInScope(options.projects, options.scope);
  const conversationsByProject = groupBy(scopedConversations, conversation => (
    projects?.get(conversation.projectId)?.id
  ));
  // A pinned project moves to Pinned whole. Otherwise pinning keeps the membership, but a pinned member is
  // listed under Pinned instead of its project.
  const isPinnedProject = (project: ProjectRecord): boolean => !!options.showPinnedSection && project.isPinned;
  const isListedAsPinned = (conversation: ConversationMeta, project: ProjectRecord): boolean => (
    !!options.showPinnedSection && conversation.isPinned === true && !isPinnedProject(project)
  );
  const listedConversations = projects
    ? scopedConversations.filter((conversation) => {
        const project = projects.get(conversation.projectId);
        return !project || isListedAsPinned(conversation, project);
      })
    : scopedConversations;
  // A member also matches by its live project's name, so one listed under Pinned is found like its project.
  const matchesConversation = (conversation: ConversationMeta): boolean => matchesSearch([
    conversation.title,
    conversation.linkedContentPath ?? '',
    projects?.get(conversation.projectId)?.name ?? '',
  ].join('\n'));
  const filteredConversations = searchTerms.length === 0
    ? listedConversations
    : listedConversations.filter(matchesConversation);
  // A project matching the search lists all its members; otherwise it lists only matching members, if any.
  const projectSections = projects
    ? sortProjects(projects.list(), conversationsByProject, options.projectSort).flatMap((project) => {
        const nameMatches = matchesSearch(project.name);
        const members = (conversationsByProject.get(project.id) ?? []).filter(conversation => (
          !isListedAsPinned(conversation, project) && (nameMatches || matchesConversation(conversation))
        ));
        if (!nameMatches && members.length === 0) return [];
        const section: ProjectListSection = {
          key: projectSectionKey(project.id),
          kind: 'project',
          project,
          conversations: members.sort((left, right) => compareConversations(left, right, sort)),
        };
        return [section];
      })
    : null;
  const pinnedProjectSections = projectSections?.filter(section => isPinnedProject(section.project)) ?? [];
  const unpinnedProjectSections = options.scope === 'archived' && projectSections?.length === 0
    ? null
    : projectSections?.filter(section => !isPinnedProject(section.project)) ?? null;
  // Project membership wins over Linked content, so a pinned member listed under Pinned joins no Linked content group.
  const linkedContentPathOf = (conversation: ConversationMeta): string | undefined => (
    projects?.get(conversation.projectId) ? undefined : conversation.linkedContentPath
  );
  const conversationsByLinkedContent = groupBy(listedConversations, linkedContentPathOf);
  const pinnedLinkedContentPaths = isGrouped
    && options.showPinnedSection
    && options.scope !== 'archived'
    ? options.pinnedLinkedContentPaths ?? new Set<string>()
    : new Set<string>();
  const isInPinnedContentGroup = (conversation: ConversationMeta): boolean => {
    const contentPath = linkedContentPathOf(conversation);
    return !!contentPath && pinnedLinkedContentPaths.has(contentPath);
  };
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
      projectSections: unpinnedProjectSections,
      pinnedProjectSections,
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
      options.isGroupCollapsed?.(section.key) ? total : total + section.conversations.length
    ), 0)
  );
  const visibleSessionConversationTotal = isGrouped
    ? countExpanded(sections)
    : sessionConversations.length;
  return {
    hasSearchTerms: searchTerms.length > 0,
    isEmpty,
    projectSections: unpinnedProjectSections,
    pinnedProjectSections,
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
