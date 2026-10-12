import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabId, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';
import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';

export type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
};

/** Revalidates a queued request after each await: false once it was superseded or lost its source. */
export type NavigationRequestCheck = () => boolean;

/** Manager-owned membership operations that navigation drives and revalidates after every await. */
export interface TabConversationNavigationHost {
  readonly plugin: ChatFeatureHost;
  readonly view: TabManagerViewHost;
  readonly membership: TabMembershipView;
  switchToTab(tabId: TabId): Promise<void>;
  /** Creates a retained tab; previews are created only by the viewer slot. */
  createTab(conversationId: string, activate: boolean): Promise<AssembledTabRuntime | null>;
  discardTab(tabId: TabId): Promise<boolean>;
  canCreateTab(): boolean;
  rebind(tab: AssembledTabRuntime, conversationId: string | null, isCurrent: NavigationRequestCheck): Promise<AssembledTabRuntime | null>;
}

/**
 * Serializes conversation navigation for one manager. Only the newest request may act, a
 * runtime-originated request stays bound to its source tab, and a fence (preview cleanup)
 * refuses new navigation until it finishes. The viewer slot shares this queue.
 */
export class TabConversationNavigation {
  #requestRevision = 0;
  #tail: Promise<void> = Promise.resolve();
  #fence: Promise<void> | null = null;

  constructor(private readonly host: TabConversationNavigationHost) {}

  /** Opens a conversation, reusing an existing owner before creating or rebinding a tab. */
  open(
    conversationId: string,
    options: OpenConversationOptions,
    sourceTab: AssembledTabRuntime | null,
  ): Promise<void> {
    const { preferNewTab = false, activate = true } = options;
    return this.enqueue(sourceTab, isCurrent => this.#openImmediately(
      conversationId,
      preferNewTab,
      activate,
      sourceTab,
      isCurrent,
    ));
  }

  /**
   * Runs `operation` after every earlier request settles. It is skipped once a newer request is
   * queued, the manager is destroyed, or `sourceTab` stops being live; `isCurrent` repeats that
   * check after the operation's own awaits.
   */
  async enqueue(
    sourceTab: AssembledTabRuntime | null,
    operation: (isCurrent: NavigationRequestCheck) => Promise<void>,
  ): Promise<void> {
    const { membership } = this.host;
    if (
      membership.isDestroyed()
      || this.#fence
      || (sourceTab && !membership.isTabAlive(sourceTab))
    ) return;
    const requestRevision = ++this.#requestRevision;
    const isCurrent = (): boolean => this.#isCurrent(requestRevision, sourceTab);
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        await operation(isCurrent);
      });
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  /**
   * Supersedes and drains queued navigation, then runs `operation` while new navigation is
   * refused. An overlapping call joins the running fence, propagating its failure.
   */
  async fence(operation: () => Promise<void>): Promise<void> {
    if (this.#fence) {
      await this.#fence;
      return;
    }
    const run = (async () => {
      await this.invalidateAndDrain();
      await operation();
    })();
    this.#fence = run;
    try {
      await run;
    } finally {
      if (this.#fence === run) this.#fence = null;
    }
  }

  /** Joins an in-flight fence, propagating its failure. */
  async awaitFence(): Promise<void> {
    await this.#fence;
  }

  /** Supersedes every queued request and waits for the in-flight one to settle. */
  async invalidateAndDrain(): Promise<void> {
    this.#requestRevision += 1;
    await this.#tail;
  }

  /**
   * Shows the conversation's live owner, in this view or another one. Returns true once an
   * owner shows it; false when none does, so the caller picks its own target. The wide viewer
   * passes `previewsOnly`, since its layout never shows this view's narrow tabs.
   */
  async focusOwner(
    conversationId: string,
    isCurrent: NavigationRequestCheck,
    options: { previewsOnly?: boolean } = {},
  ): Promise<boolean> {
    const { host } = this;
    const { membership } = host;

    const attachment = host.plugin.sessionRuntimes.getAttachment(conversationId);
    if (attachment) {
      await attachment.owner.reveal(isCurrent);
      if (!isCurrent()) return true;
      if (host.plugin.sessionRuntimes.getAttachment(conversationId) === attachment) return true;
    }

    const localTarget = membership.getTabIdentities()
      .find(tab => (
        membership.isTabAlive(tab)
        && tab.conversationId === conversationId
        && (!options.previewsOnly || tab.lifecycleState === 'provisional')
      ));
    if (localTarget) {
      await host.switchToTab(localTarget.id);
      if (!isCurrent()) return true;
      // Activation may replace a restored tab with its assembled runtime under the same ID.
      const currentTarget = membership.getTabIdentities().find(tab => tab.id === localTarget.id);
      if (
        currentTarget?.conversationId === conversationId
        && !membership.isCloseClaimed(currentTarget.id)
      ) {
        return true;
      }
    }

    // Another view (split workspace) may own it; compare views directly rather than leaves.
    const crossViewResult = host.plugin.findConversationAcrossViews(conversationId);
    if (!crossViewResult || crossViewResult.view === host.view) return false;

    await revealWorkspaceLeaf(host.plugin.app.workspace, crossViewResult.view.leaf);
    if (!isCurrent()) return true;
    const refreshedTarget = host.plugin.findConversationAcrossViews(conversationId);
    const targetManager = refreshedTarget?.view.getTabManager() ?? null;
    const ownsConversation = (): boolean => !!targetManager
      && targetManager.isTabLive(crossViewResult.tabId)
      && targetManager.getTabIdentities()
        .find(tab => tab.id === crossViewResult.tabId)?.conversationId === conversationId;
    if (
      refreshedTarget?.view !== crossViewResult.view
      || refreshedTarget.tabId !== crossViewResult.tabId
      || !targetManager
      || !ownsConversation()
    ) {
      return false;
    }
    await targetManager.focusTab(crossViewResult.tabId);
    if (!isCurrent()) return true;
    return ownsConversation();
  }

  #isCurrent(
    requestRevision: number,
    sourceTab: AssembledTabRuntime | null,
  ): boolean {
    const { membership } = this.host;
    return !membership.isDestroyed()
      && requestRevision === this.#requestRevision
      && (!sourceTab || membership.isTabAlive(sourceTab));
  }

  #getActiveTab(): AssembledTabRuntime | null {
    const activeTabId = this.host.membership.getActiveTabId();
    return activeTabId ? this.host.membership.getTab(activeTabId) : null;
  }

  async #openImmediately(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    sourceTab: AssembledTabRuntime | null,
    isCurrent: NavigationRequestCheck,
  ): Promise<void> {
    const { host } = this;
    const { membership } = host;

    if (await this.focusOwner(conversationId, isCurrent) || !isCurrent()) return;

    if (preferNewTab) {
      const createdTab = await host.createTab(conversationId, activate);
      if (!isCurrent()) {
        if (
          createdTab
          && membership.getTab(createdTab.id) === createdTab
          && createdTab.conversationId === conversationId
          && !createdTab.session.isUserClaimed
        ) {
          await host.discardTab(createdTab.id);
        }
        return;
      }
      if (
        createdTab
        && membership.isTabAlive(createdTab)
        && createdTab.conversationId === conversationId
      ) {
        return;
      }
    }

    // Fall back to a live local owner when an awaited target disappears.
    // Don't set tab.conversationId here: the controller callback commits it only
    // after a successful switch.
    const preferredTab = sourceTab ?? this.#getActiveTab();
    const activeTab = preferredTab && membership.isTabAlive(preferredTab)
      ? preferredTab
      : membership.getAllTabs().find(tab => membership.isTabAlive(tab)) ?? null;
    if (!activeTab) return;
    const switched = await host.rebind(activeTab, conversationId, isCurrent);
    if (switched && membership.isTabAlive(switched)) {
      commitProvisionalTab(switched);
      if (membership.getActiveTabId() !== switched.id) {
        await host.switchToTab(switched.id);
      }
    }
  }
}
