import { Notice } from 'obsidian';

import type { Conversation, ConversationMeta } from '@/core/types';
import type { ChatTabManagerHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import type { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';
import type { TabId } from '@/features/chat/tabs/ChatTab';

/** Application conversation writes the lifecycle applies after its tab policy. */
export interface ConversationLifecycleStore {
  getConversationList(): readonly Pick<ConversationMeta, 'id' | 'isArchived'>[];
  deleteConversation(id: string): Promise<void>;
  setConversationArchived(id: string, isArchived: boolean): Promise<void>;
  setConversationsPinned(ids: readonly string[], isPinned: boolean): Promise<void>;
  restoreConversations(ids: readonly string[]): Promise<void>;
  archiveConversationsIf(
    ids: readonly string[],
    shouldArchive: (conversation: Readonly<Conversation>) => boolean,
  ): Promise<number>;
}

export interface ConversationLifecycleDeps {
  readonly sessions: Pick<SessionRuntimePool, 'get' | 'isRunning' | 'retire' | 'whenSettled'>;
  readonly conversations: ConversationLifecycleStore;
  readonly views: { getAllViews(): readonly ChatViewHost[] };
}

interface BoundTab {
  readonly manager: ChatTabManagerHost;
  readonly tabId: TabId;
}

export type ArchivableConversation = Readonly<Pick<Conversation, 'id' | 'isPinned' | 'lastActivityAt'>>;

/**
 * The single owner of archive, restore, pin, and delete across every chat view. A session
 * counts as running while its runtime has foreground or background work, including without a view.
 */
export class ConversationLifecycle {
  constructor(private readonly deps: ConversationLifecycleDeps) {}

  /** Includes session work with no attached tab. */
  isRunning(conversationId: string): boolean {
    return this.deps.sessions.isRunning(conversationId);
  }

  /** Pins or unpins sessions in one batch; pinning affects only the session list. */
  async setPinned(conversationIds: readonly string[], isPinned: boolean): Promise<void> {
    await this.deps.conversations.setConversationsPinned(conversationIds, isPinned);
  }

  /** Archives after closing the session's idle tabs, or restores it without opening one. */
  async setArchived(conversationId: string, isArchived: boolean): Promise<void> {
    if (!isArchived) {
      await this.deps.conversations.setConversationArchived(conversationId, false);
      return;
    }
    if (!await this.#closeTabsBeforeArchive(conversationId)) {
      new Notice('Running sessions cannot be archived');
      return;
    }
    await this.#archiveAndClear([conversationId], conversation =>
      !this.isRunning(conversation.id) && this.#boundTabs(conversation.id).length === 0);
  }

  /** Archives a batch, skipping sessions that are running or reopened before their write. */
  async archive(conversationIds: readonly string[]): Promise<void> {
    const closedIds: string[] = [];
    for (const conversationId of conversationIds) {
      if (await this.#closeTabsBeforeArchive(conversationId)) closedIds.push(conversationId);
    }
    // A session can be reopened while later tabs close; recheck at each archive write.
    const archivedCount = closedIds.length === 0
      ? 0
      : await this.#archiveAndClear(
          closedIds,
          conversation => !this.isRunning(conversation.id) && this.#boundTabs(conversation.id).length === 0,
        );
    const skippedCount = conversationIds.length - archivedCount;
    if (skippedCount > 0) {
      new Notice(`Skipped ${skippedCount} ${skippedCount === 1 ? 'session that is' : 'sessions that are'} open or running`);
    }
  }

  /** Archives closed sessions whose `shouldArchive` still holds at each write. */
  archiveIf(
    conversationIds: readonly string[],
    shouldArchive: (conversation: ArchivableConversation) => boolean,
  ): Promise<number> {
    return this.#archiveAndClear(conversationIds, conversation =>
      !this.isRunning(conversation.id) && shouldArchive(conversation));
  }

  async #archiveAndClear(
    ids: readonly string[],
    shouldArchive: (conversation: Readonly<Conversation>) => boolean,
  ): Promise<number> {
    try {
      return await this.deps.conversations.archiveConversationsIf(ids, shouldArchive);
    } finally {
      // Persistence may commit part of a batch before failing. Read committed metadata only,
      // outside its write queue, and revalidate so a concurrent restore keeps its mailbox.
      const archived = new Set(this.deps.conversations.getConversationList()
        .filter(conversation => conversation.isArchived).map(conversation => conversation.id));
      for (const id of ids) {
        if (archived.has(id)) this.deps.sessions.get(id)?.mailbox?.clear();
      }
    }
  }

  restore(conversationIds: readonly string[]): Promise<void> {
    return this.deps.conversations.restoreConversations(conversationIds);
  }

  /**
   * Deletes sessions in order, skipping any whose runtimes are running. Tabs bound to a
   * deleted session are reset by the deletion callback, not here.
   */
  async delete(conversationIds: readonly string[]): Promise<void> {
    let skippedCount = 0;
    for (const conversationId of conversationIds) {
      if (this.isRunning(conversationId)) {
        skippedCount += 1;
        continue;
      }
      await this.deps.conversations.deleteConversation(conversationId);
    }
    if (skippedCount === 0) return;
    new Notice(conversationIds.length === 1
      ? 'Running sessions cannot be deleted'
      : `Skipped ${skippedCount} ${skippedCount === 1 ? 'session that is' : 'sessions that are'} running`);
  }

  /**
   * Repository deletion callback: returns every view's tabs bound to the record to a blank draft.
   * User deletion skips running sessions, so a running session here is a provider-reported missing
   * session deleted from inside its own turn. That turn is awaiting this callback and returns its
   * unsent input to the composer when it settles; the tabs reset afterwards and carry that input.
   */
  async resetDeletedConversationTabs(conversationId: string): Promise<void> {
    this.deps.sessions.get(conversationId)?.mailbox?.clear();
    if (this.deps.sessions.isRunning(conversationId)) {
      void this.deps.sessions.whenSettled(conversationId)
        .then(settled => settled ? this.#retireDeletedSession(conversationId) : undefined)
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : 'Failed to close the deleted session');
        });
      return;
    }
    await this.#retireDeletedSession(conversationId);
  }

  async #retireDeletedSession(conversationId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const manager of this.#managers()) {
      try {
        await manager.resetConversationTabs(conversationId);
      } catch (error) {
        errors.push(error);
      }
    }
    // A tab that failed to reset still shows the session; it is disposed once that tab lets go.
    try { await this.deps.sessions.retire(conversationId); }
    catch (error) { errors.push(error); }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  /** Closes every tab showing the session; returns false without closing anything when it is running. */
  async #closeTabsBeforeArchive(conversationId: string): Promise<boolean> {
    const boundTabs = this.#boundTabs(conversationId);
    // Running sessions cannot be archived, including detached main and side work.
    if (this.isRunning(conversationId)) return false;

    for (const { manager, tabId } of boundTabs) {
      if (!await manager.closeTab(tabId)) {
        throw new Error('Failed to close the session before archiving');
      }
    }
    return true;
  }

  #boundTabs(conversationId: string): BoundTab[] {
    const boundTabs: BoundTab[] = [];
    for (const manager of this.#managers()) {
      for (const tab of manager.getTabIdentities()) {
        if (tab.conversationId === conversationId) boundTabs.push({ manager, tabId: tab.id });
      }
    }
    return boundTabs;
  }

  #managers(): ChatTabManagerHost[] {
    const managers = new Set<ChatTabManagerHost>();
    for (const view of this.deps.views.getAllViews()) {
      const manager = view.getTabManager();
      if (manager) managers.add(manager);
    }
    return [...managers];
  }
}
