import type {
  ConversationMeta,
  ProjectReader,
  ProjectRecord,
  SessionManagerOrganization,
  SessionManagerSort,
} from '@/core/types';
import { orderProjects } from '@/features/chat/projects/projectOrder';
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
  /** The activity that places a session when sorting by last update; a fold's parent takes its newest member's. */
  activityOf?: (conversation: ConversationMeta) => number;
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

type SortTimestamp = (conversation: ConversationMeta) => number;

function sortTimestampOf(
  sort: SessionManagerSort,
  activityOf: SortTimestamp = conversation => conversation.lastActivityAt,
): SortTimestamp {
  return sort === 'created' ? conversation => conversation.createdAt : activityOf;
}

function groupByRecency(
  sortedConversations: readonly ConversationMeta[],
  timestampOf: SortTimestamp,
  now: number,
): SessionListSection[] {
  const sections = RECENCY_GROUPS.map(({ key, label }): SessionListSection => ({
    key,
    kind: 'recency',
    label,
    conversations: [],
  }));
  for (const conversation of sortedConversations) {
    const ageDays = (now - timestampOf(conversation)) / DAY_MS;
    const index = RECENCY_GROUPS.findIndex(({ maxAgeDays }) => ageDays < maxAgeDays);
    sections[index].conversations.push(conversation);
  }
  return sections.filter(section => section.conversations.length > 0);
}

function compareConversations(
  left: ConversationMeta,
  right: ConversationMeta,
  timestampOf: SortTimestamp,
): number {
  return timestampOf(right) - timestampOf(left)
    || left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true })
    || left.id.localeCompare(right.id);
}

function getSectionTimestamp(section: SessionListSection, timestampOf: SortTimestamp): number {
  return section.conversations.reduce((latest, conversation) => Math.max(latest, timestampOf(conversation)), 0);
}

function compareSections(
  left: SessionListSection,
  right: SessionListSection,
  timestampOf: SortTimestamp,
): number {
  return getSectionTimestamp(right, timestampOf) - getSectionTimestamp(left, timestampOf)
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

/** Pinned projects first, each group in the user's project order. */
function sortProjects(records: readonly ProjectRecord[], projectOrder: readonly string[]): ProjectRecord[] {
  return orderProjects(records, projectOrder)
    .sort((left, right) => Number(right.isPinned) - Number(left.isPinned));
}

export function getLinkedContentTitle(contentPath: string): string {
  const filename = contentPath.replace(/\\/g, '/').split('/').pop() ?? contentPath;
  return filename.replace(/\.md$/i, '');
}

export function organizeSessionList(
  conversations: readonly ConversationMeta[],
  options: OrganizeSessionListOptions,
): SessionListSection[] {
  const timestampOf = sortTimestampOf(options.sort, options.activityOf);
  const sortedConversations = [...conversations].sort((left, right) => (
    compareConversations(left, right, timestampOf)
  ));
  if (options.organization === 'list') {
    if (options.groupByRecency) {
      return groupByRecency(sortedConversations, timestampOf, options.groupByRecency.now);
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
    compareSections(left, right, timestampOf)
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
  /** The saved project order (`savedProjectOrder`). */
  projectOrder?: readonly string[];
  isGroupCollapsed?: (groupKey: string) => boolean;
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  /** Divides an unpinned flat list into recency groups relative to `now`. */
  groupByRecency?: { now: number };
  /** Folds sessions under the listed session that started them (`foldedChildren`); never while searching. */
  foldLineage?: boolean;
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
  /**
   * Sessions folded under the listed session they descend from, by that ancestor's id, in list order. Folded
   * sessions appear in no other list. A fold stays within one top-level section (Pinned, projects, sessions).
   */
  readonly foldedChildren: ReadonlyMap<string, readonly ConversationMeta[]>;
}

/**
 * Folds each session started by another listed session (`origin`) under its outermost listed ancestor, so it
 * shows with the session that started it. Its parent is its nearest listed ancestor: the lineage passes through
 * sessions this list does not show, such as archived ones. A session keeps its own row when it is pinned, or its
 * live project or Linked content differs from that parent's; no Linked content counts as matching.
 */
function foldLineage(
  listed: readonly ConversationMeta[],
  conversations: readonly ConversationMeta[],
  projectIdOf: (conversation: ConversationMeta) => string | undefined,
  sort: SessionManagerSort,
): Map<string, ConversationMeta[]> {
  const byId = new Map(listed.map(conversation => [conversation.id, conversation]));
  const allById = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const nearestListedAncestor = (conversation: ConversationMeta): ConversationMeta | undefined => {
    const passed = new Set([conversation.id]);
    let ancestorId = conversation.origin?.conversationId;
    while (ancestorId !== undefined && !passed.has(ancestorId)) {
      const listedAncestor = byId.get(ancestorId);
      if (listedAncestor) return listedAncestor;
      passed.add(ancestorId);
      ancestorId = allById.get(ancestorId)?.origin?.conversationId;
    }
    return undefined;
  };
  const foldParentOf = (conversation: ConversationMeta): ConversationMeta | null => {
    const parent = conversation.isPinned ? undefined : nearestListedAncestor(conversation);
    return parent !== undefined
      && projectIdOf(conversation) === projectIdOf(parent)
      && (conversation.linkedContentPath === undefined
        || conversation.linkedContentPath === parent.linkedContentPath)
      ? parent
      : null;
  };
  // Null marks a row. Only malformed metadata forms an origin cycle; its members stay rows.
  const roots = new Map<string, ConversationMeta | null>();
  const resolving: ConversationMeta[] = [];
  const rootOf = (conversation: ConversationMeta): ConversationMeta | null => {
    const known = roots.get(conversation.id);
    if (known !== undefined) return known;
    const parent = foldParentOf(conversation);
    if (!parent) {
      roots.set(conversation.id, null);
      return null;
    }
    const cycleStart = resolving.indexOf(parent);
    if (parent === conversation || cycleStart >= 0) {
      const members = cycleStart >= 0 ? resolving.slice(cycleStart) : [];
      for (const member of [...members, conversation]) roots.set(member.id, null);
      return null;
    }
    resolving.push(conversation);
    const parentRoot = rootOf(parent);
    resolving.pop();
    // Resolving the parent can close a cycle through this session.
    if (roots.has(conversation.id)) return roots.get(conversation.id) ?? null;
    const root = parentRoot ?? parent;
    roots.set(conversation.id, root);
    return root;
  };
  const foldedChildren = new Map<string, ConversationMeta[]>();
  for (const conversation of listed) {
    const root = rootOf(conversation);
    if (!root) continue;
    const children = foldedChildren.get(root.id) ?? [];
    children.push(conversation);
    foldedChildren.set(root.id, children);
  }
  for (const children of foldedChildren.values()) {
    children.sort((left, right) => compareConversations(left, right, sortTimestampOf(sort)));
  }
  return foldedChildren;
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
    ? sortProjects(projects.list(), options.projectOrder ?? []).flatMap((project) => {
        const nameMatches = matchesSearch(project.name);
        const members = (conversationsByProject.get(project.id) ?? []).filter(conversation => (
          !isListedAsPinned(conversation, project) && (nameMatches || matchesConversation(conversation))
        ));
        if (!nameMatches && members.length === 0) return [];
        const section: ProjectListSection = {
          key: projectSectionKey(project.id),
          kind: 'project',
          project,
          conversations: members,
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
  const pinnedContentRows = filteredConversations.filter(isInPinnedContentGroup);
  const pinnedRows = options.showPinnedSection
    ? filteredConversations.filter(conversation => (
        conversation.isPinned && !isInPinnedContentGroup(conversation)
      ))
    : [];
  const sessionRows = options.showPinnedSection
    ? filteredConversations.filter(conversation => (
        !conversation.isPinned && !isInPinnedContentGroup(conversation)
      ))
    : filteredConversations;

  // Each top-level section folds on its own, so a fold never pulls a session out of Pinned, its project or the
  // session list. Search lists every match as its own row.
  const foldedChildren = new Map<string, ConversationMeta[]>();
  if (options.foldLineage && searchTerms.length === 0) {
    const membersOf = (sections: readonly ProjectListSection[]) => sections.flatMap(section => section.conversations);
    // Membership, not the scope's listing: the archive lists no active project, yet its members differ.
    const projectIdOf = (conversation: ConversationMeta) => options.projects?.get(conversation.projectId)?.id;
    for (const rows of [
      [...membersOf(pinnedProjectSections), ...pinnedContentRows, ...pinnedRows],
      membersOf(unpinnedProjectSections ?? []),
      sessionRows,
    ]) {
      for (const [parentId, children] of foldLineage(rows, conversations, projectIdOf, sort)) {
        foldedChildren.set(parentId, children);
      }
    }
  }
  const foldedIds = new Set([...foldedChildren.values()].flat().map(({ id }) => id));
  const isListed = (conversation: ConversationMeta): boolean => !foldedIds.has(conversation.id);
  // A fold sits where its newest session would, so work in a child keeps its parent near the top.
  const activityOf = (conversation: ConversationMeta): number => Math.max(
    conversation.lastActivityAt,
    ...(foldedChildren.get(conversation.id) ?? []).map(child => child.lastActivityAt),
  );
  const timestampOf = sortTimestampOf(sort, activityOf);
  const listedProjectSection = (section: ProjectListSection): ProjectListSection => ({
    ...section,
    conversations: section.conversations.filter(isListed)
      .sort((left, right) => compareConversations(left, right, timestampOf)),
  });
  const listedPinnedProjectSections = pinnedProjectSections.map(listedProjectSection);
  const listedProjectSections = unpinnedProjectSections?.map(listedProjectSection) ?? null;
  const pinnedContentConversations = pinnedContentRows.filter(isListed);
  const sessionConversations = sessionRows.filter(isListed);

  const pinnedPathsWithMatchingSessions = new Set(
    pinnedContentRows.flatMap(conversation => (
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
    activityOf,
  }).filter(section => section.contentPath !== undefined);
  const isEmpty = filteredConversations.length === 0 && pinnedContentSections.length === 0;
  if (isEmpty) {
    return {
      hasSearchTerms: searchTerms.length > 0,
      isEmpty,
      projectSections: listedProjectSections,
      pinnedProjectSections: listedPinnedProjectSections,
      pinnedContentSections,
      pinnedConversations: [],
      sections: [],
      groupKeys: isGrouped ? [] : null,
      conversationsByLinkedContent,
      conversationsByProject,
      visibleConversationTotal: 0,
      foldedChildren,
    };
  }

  const sortedPinnedConversations = pinnedRows.filter(isListed)
    .sort((left, right) => compareConversations(left, right, timestampOf));
  const sections = organizeSessionList(sessionConversations, {
    organization,
    sort,
    language,
    contentExists: options.contentExists,
    contentIsNote: options.contentIsNote,
    groupByRecency: options.groupByRecency,
    activityOf,
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
    projectSections: listedProjectSections,
    pinnedProjectSections: listedPinnedProjectSections,
    pinnedContentSections,
    pinnedConversations: sortedPinnedConversations,
    sections,
    groupKeys: isGrouped
      ? [...pinnedContentSections.map(({ key }) => key), ...sections.map(({ key }) => key)]
      : null,
    conversationsByLinkedContent,
    conversationsByProject,
    foldedChildren,
    visibleConversationTotal: countExpanded(pinnedContentSections)
      + sortedPinnedConversations.length
      + visibleSessionConversationTotal,
  };
}
