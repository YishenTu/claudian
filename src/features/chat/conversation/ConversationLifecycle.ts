import { Notice } from 'obsidian';

import type { Conversation } from '@/core/types';
import type { ChatTabManagerHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import type { TabId } from '@/features/chat/tabs/ChatTab';

/** Application conversation writes the lifecycle applies after its tab policy. */
export interface ConversationLifecycleStore {
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
 * counts as running when any tab bound to it, in any view, has foreground or background work.
 */
export class ConversationLifecycle {
  constructor(private readonly deps: ConversationLifecycleDeps) {}

  /** True while a tab bound to the session has work that closing or resetting would interrupt. */
  isRunning(conversationId: string): boolean {
    return this.#boundTabs(conversationId).some(({ manager, tabId }) => manager.isTabWorking(tabId));
  }

  /** Pins or unpins sessions in one batch; pinning retains their provisional previews. */
  async setPinned(conversationIds: readonly string[], isPinned: boolean): Promise<void> {
    await this.deps.conversations.setConversationsPinned(conversationIds, isPinned);
    if (!isPinned) return;
    const ids = new Set(conversationIds);
    for (const manager of this.#managers()) {
      const tabIds = manager.getTabIdentities()
        .filter(tab => tab.conversationId !== null && ids.has(tab.conversationId))
        .map(tab => tab.id);
      if (tabIds.length > 0) manager.retainTabs(tabIds);
    }
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
    await this.deps.conversations.setConversationArchived(conversationId, true);
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
      : await this.deps.conversations.archiveConversationsIf(
          closedIds,
          conversation => this.#boundTabs(conversation.id).length === 0,
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
    return this.deps.conversations.archiveConversationsIf(conversationIds, shouldArchive);
  }

  restore(conversationIds: readonly string[]): Promise<void> {
    return this.deps.conversations.restoreConversations(conversationIds);
  }

  /**
   * Deletes sessions in order, skipping any whose bound tabs are running. Tabs bound to a
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

  /** Repository deletion callback: returns every view's tabs bound to the record to a blank draft. */
  async resetDeletedConversationTabs(conversationId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const manager of this.#managers()) {
      try {
        await manager.resetConversationTabs(conversationId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  /** Closes every tab showing the session; returns false without closing anything when it is running. */
  async #closeTabsBeforeArchive(conversationId: string): Promise<boolean> {
    const boundTabs = this.#boundTabs(conversationId);
    // Closing would interrupt foreground turns, background work, async subagents, and side chats.
    if (boundTabs.some(({ manager, tabId }) => manager.isTabWorking(tabId))) return false;

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
