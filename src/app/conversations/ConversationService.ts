import type { ProviderId } from '@/core/providers/types';
import type {
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
  ConversationPlacement,
  ConversationSummary,
  ProjectMutations,
  ProjectReader,
} from '@/core/types';

import type { PinnedLinkedContentPathCoordinator } from '../settings/PinnedLinkedContentPathCoordinator';
import type { ConversationRepository } from './ConversationRepository';
import type { NativeSessionArchiveSync } from './NativeSessionArchiveSync';
import type { SessionMetadataLoader } from './SessionMetadataLoader';

export interface ConversationServiceDeps {
  readonly repository: ConversationRepository;
  /** Omitted only when this conversation domain has no projects. */
  readonly projects?: Pick<ProjectReader, 'get'> & Pick<ProjectMutations, 'setArchived'>;
  readonly sessionMetadata: Pick<SessionMetadataLoader, 'ensureLoaded'>;
  readonly pinnedLinkedContentPaths: PinnedLinkedContentPathCoordinator;
  readonly nativeSessionArchives: Pick<NativeSessionArchiveSync, 'sync'>;
  /** Publishes a committed list change; projection failures never roll the commit back. */
  onConversationListChanged(): void;
}

/**
 * Application conversation operations. Mutations go through the repository,
 * then publish one list change; archive state changes are mirrored to native
 * provider sessions after they commit.
 */
export class ConversationService {
  // Creation, placement, restore and final project archive share this ordering point.
  // Tab closure and provider callbacks stay outside it.
  #projectMembershipQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConversationServiceDeps) {}

  notifyConversationListChanged(): void {
    this.deps.onConversationListChanged();
  }

  async createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
    /** Kept only when it names a live project at creation. */
    projectId?: string;
  }): Promise<Conversation> {
    const conversation = await this.#mutateProjectMembership(() => this.deps.repository.create(options));
    this.notifyConversationListChanged();
    return conversation;
  }

  switchConversation(id: string): Promise<Conversation | null> {
    return this.deps.repository.switchTo(id);
  }

  async assignConversationToCurrentDevice(id: string): Promise<boolean> {
    const assigned = await this.deps.repository.assignToCurrentDevice(id);
    if (assigned) this.notifyConversationListChanged();
    return assigned;
  }

  async deleteConversation(id: string): Promise<void> {
    await this.deps.repository.delete(id);
    this.notifyConversationListChanged();
  }

  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    return this.deps.repository.handleMissingProviderSession(id, missingProviderSessionId);
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await this.deps.repository.rename(id, title);
    this.notifyConversationListChanged();
  }

  async completeConversationTitleGeneration(id: string, expectedTitle: string, title: string | null): Promise<void> {
    await this.deps.repository.completeTitleGeneration(id, expectedTitle, title);
    this.notifyConversationListChanged();
  }

  async updateConversation(id: string, updates: ConversationMutablePatch): Promise<void> {
    await this.deps.repository.update(id, updates);
    this.notifyConversationListChanged();
  }

  /** One write per conversation and one list refresh; see `ConversationRepository.setPlacement`. */
  async setConversationsPlacement(ids: readonly string[], placement: ConversationPlacement): Promise<void> {
    await this.#mutateProjectMembership(() =>
      this.#mutateConversations(ids, id => this.deps.repository.setPlacement(id, placement)));
  }

  async setLinkedContentPinned(contentPath: string, isPinned: boolean): Promise<void> {
    const changed = await this.deps.pinnedLinkedContentPaths.setPinned(contentPath, isPinned);
    if (changed) {
      this.notifyConversationListChanged();
    }
  }

  async setConversationArchived(id: string, isArchived: boolean): Promise<void> {
    const changed = isArchived
      ? await this.deps.repository.setArchived(id, true)
      : await this.#mutateProjectMembership(async () => {
          await this.#restoreProjectsOf([id]);
          return this.deps.repository.setArchived(id, false);
        });
    this.notifyConversationListChanged();
    if (changed) await this.deps.nativeSessionArchives.sync([id]);
  }

  async restoreConversations(ids: readonly string[]): Promise<void> {
    const restoredIds: string[] = [];
    try {
      await this.#mutateProjectMembership(async () => {
        await this.#restoreProjectsOf(ids);
        await this.#mutateConversations(ids, async (id) => {
          if (await this.deps.repository.setArchived(id, false)) restoredIds.push(id);
        });
      });
    } finally {
      await this.deps.nativeSessionArchives.sync(restoredIds);
    }
  }

  /** Rechecks membership and holds off new admissions through the durable project archive write. */
  async archiveProjectIfEmpty(projectId: string): Promise<void> {
    await this.#mutateProjectMembership(async () => {
      if (this.deps.repository.list().some(record => record.projectId === projectId && !record.isArchived)) return;
      await this.deps.projects?.setArchived(projectId, true);
    });
  }

  async #restoreProjectsOf(conversationIds: readonly string[]): Promise<void> {
    const projects = this.deps.projects;
    if (!projects) return;
    const ids = new Set(conversationIds);
    const projectIds = new Set(this.deps.repository.list().flatMap(conversation => (
      ids.has(conversation.id) && projects.get(conversation.projectId)?.isArchived
        ? [conversation.projectId!]
        : []
    )));
    for (const projectId of projectIds) await projects.setArchived(projectId, false);
  }

  #mutateProjectMembership<T>(mutate: () => Promise<T>): Promise<T> {
    const result = this.#projectMembershipQueue.then(mutate);
    this.#projectMembershipQueue = result.catch(() => undefined);
    return result;
  }

  async archiveConversationsIf(
    ids: readonly string[],
    shouldArchive: (conversation: Readonly<Conversation>) => boolean,
  ): Promise<number> {
    const archivedIds: string[] = [];
    try {
      await this.#mutateConversations(ids, async (id) => {
        if (await this.deps.repository.archiveIf(id, shouldArchive)) archivedIds.push(id);
      });
    } finally {
      await this.deps.nativeSessionArchives.sync(archivedIds);
    }
    return archivedIds.length;
  }

  /** Reconciles linked content identity and pinned paths after a Vault rename; publication is the caller's. */
  async applyVaultRename(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): Promise<void> {
    await this.deps.repository.rewriteLinkedContentPaths(oldPath, newPath, { includeDescendants });
    await this.deps.pinnedLinkedContentPaths.rewritePaths(oldPath, newPath, includeDescendants);
  }

  /** Unpins deleted Vault content; conversations keep their identity for Missing content. */
  async applyVaultDeletion(path: string, includeDescendants: boolean): Promise<void> {
    await this.deps.pinnedLinkedContentPaths.removePaths(path, includeDescendants);
  }

  getConversationById(id: string): Promise<Conversation | null> {
    return this.deps.repository.getById(id);
  }

  getCachedConversation(id: string): Conversation | null {
    return this.deps.repository.getCachedConversation(id);
  }

  getConversationSummary(id: string): ConversationSummary | null {
    return this.deps.repository.getSummary(id);
  }

  getConversationSync(id: string): Conversation | null {
    return this.deps.repository.getSync(id);
  }

  getConversationList(): ConversationMeta[] {
    return this.deps.repository.list();
  }

  async ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void> {
    await this.deps.sessionMetadata.ensureLoaded(conversationIds);
  }

  /** Applies independent per-session writes, then refreshes views once. */
  async #mutateConversations(
    ids: readonly string[],
    mutate: (id: string) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(ids.map(mutate));
    this.notifyConversationListChanged();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }
}
