import type { App } from 'obsidian';

import type { TabId } from '@/features/chat/tabs/ChatTab';
import { ParkedDrafts } from '@/features/chat/tabs/ParkedDrafts';
import type { NavigationRequestCheck, TabConversationNavigation } from '@/features/chat/tabs/TabConversationNavigation';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';

/** Whether Linked content still exists; vaults without path lookup accept every path. */
export function linkedContentExists(app: Pick<App, 'vault'>, contentPath: string): boolean {
  const { vault } = app;
  return typeof vault.getAbstractFileByPath !== 'function'
    || vault.getAbstractFileByPath(contentPath) !== null;
}

/** Manager-owned operations the slot drives and revalidates after every await. */
export interface ViewerSlotHost {
  readonly app: Pick<App, 'vault'>;
  readonly membership: TabMembershipView;
  /** The manager's navigation queue; slot requests supersede and are superseded by its opens. */
  readonly navigation: TabConversationNavigation;
  /** Unsent text no presentation shows; assemblies and rebinds take what is held for them. */
  readonly parkedDrafts: ParkedDrafts;
  /** Creates and activates a provisional tab; only the slot creates previews. */
  createPreview(conversationId: string | null): Promise<AssembledTabRuntime | null>;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId): Promise<boolean>;
  discardTab(tabId: TabId): Promise<boolean>;
  /** Rebinds a preview, parking its unsent text with the session it leaves. */
  rebind(tab: AssembledTabRuntime, conversationId: string, isCurrent: NavigationRequestCheck): Promise<AssembledTabRuntime | null>;
  /** Unloads a narrow tab to its identity; its session keeps running unattached. */
  unloadTab(tab: AssembledTabRuntime): Promise<void>;
  /** Closes a preview and then activates the narrow tab that takes over its session. */
  handOver(tabId: TabId, successorId: TabId): Promise<boolean>;
}

export interface ViewerSlotRequest {
  /** The tab whose command issued the request; the request lapses once it stops being live. */
  sourceTab?: AssembledTabRuntime | null;
  /** Further validity the request keeps through the destination's assembly and hydration. */
  isValid?: () => boolean;
}

/**
 * The wide layout's single replaceable preview. Tabs are a narrow-layout concept: entering wide
 * unloads every tab bound to a session (the pool keeps the session), wide navigation only
 * rebinds or replaces the preview, and leaving wide hands the shown session back to its narrow
 * tab or turns the preview into one. A blank narrow tab keeps its draft session loaded, because
 * nothing else could reacquire it; when selected it stays the wide presentation itself.
 */
export class ViewerSlot {
  constructor(private readonly host: ViewerSlotHost) {}

  /** Shows a session: its live owner elsewhere or a preview already showing it, otherwise the preview. */
  async show(conversationId: string, request: ViewerSlotRequest = {}): Promise<void> {
    const { isValid = () => true } = request;
    await this.host.navigation.enqueue(request.sourceTab ?? null, async (isCurrent) => {
      await this.#show(conversationId, () => isCurrent() && isValid());
    });
  }

  /** Replaces the preview with a blank draft, optionally linked to `linkedContentPath`. */
  async startDraft(options: ViewerSlotRequest & { linkedContentPath?: string } = {}): Promise<void> {
    const { linkedContentPath, sourceTab = null } = options;
    if (sourceTab && !this.host.membership.isTabAlive(sourceTab)) return;
    this.#assertLinkedContentExists(linkedContentPath);

    await this.host.navigation.enqueue(null, async (isCurrent) => {
      await this.#startDraft(isCurrent, linkedContentPath);
    });
  }

  /**
   * Enters the wide layout: unloads every narrow tab bound to a session, parking its unsent
   * text, then shows the selected session in the preview, or the selected blank tab itself.
   * Without an explicit `selected`, the selection is read after any in-flight release settles.
   * A request superseded after unloading leaves the presentation to whatever superseded it.
   */
  async enter(selected?: Readonly<TabIdentity> | null): Promise<void> {
    await this.host.navigation.awaitFence().catch(() => undefined);
    const target = selected === undefined ? this.#activeIdentity() : selected;
    if (target?.lifecycleState === 'provisional') return;
    const selection = target ? { id: target.id, conversationId: target.conversationId } : null;
    await this.host.navigation.enqueue(null, async (isCurrent) => {
      const { membership, parkedDrafts } = this.host;
      for (const tab of membership.getAllTabs()) {
        if (tab.lifecycleState !== 'open' || !tab.conversationId || !membership.isTabAlive(tab)) continue;
        parkedDrafts.park(tab);
        await this.host.unloadTab(tab);
      }
      if (!isCurrent()) return;
      if (selection?.conversationId) await this.#show(selection.conversationId, isCurrent);
      else if (selection) await this.host.switchToTab(selection.id);
      else await this.#startDraft(isCurrent);
    });
  }

  /**
   * Leaves the wide layout: the shown session returns to its narrow tab, or the preview becomes
   * one; other previews close, and the view always ends with a live tab. Overlapping calls share
   * one cleanup, which fences navigation.
   */
  async release(): Promise<void> {
    if (this.host.membership.isDestroyed()) return;
    await this.host.navigation.fence(async () => {
      const { membership, parkedDrafts } = this.host;
      const active = this.#activePreview();
      const narrowTab = active ? this.#narrowTabFor(active) : null;
      if (active && narrowTab) {
        parkedDrafts.park(active, ParkedDrafts.keyFor(narrowTab));
        await this.host.handOver(active.id, narrowTab.id);
      } else if (active) {
        commitProvisionalTab(active);
      }
      await this.#closePreviews(null);
      if (membership.isDestroyed() || this.#hasLivePresentation()) return;
      // An interrupted entry may have unloaded the active tab before showing anything.
      const fallback = membership.getActiveTabId()
        ?? membership.getRetainedActiveTabId()
        ?? membership.getTabIdentities()[0]?.id;
      if (fallback) await this.host.switchToTab(fallback);
    });
  }

  async #show(conversationId: string, isCurrent: NavigationRequestCheck): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (await host.navigation.focusOwner(conversationId, isCurrent, { previewsOnly: true }) || !isCurrent()) return;

    const preview = this.#livePreviews()[0];
    if (preview) {
      const switched = await host.rebind(preview, conversationId, isCurrent);
      if (switched && membership.isTabAlive(switched)) {
        await host.switchToTab(switched.id);
        return;
      }
      if (!isCurrent()) return;
    }

    // Selections never rebind a narrow tab: when no preview can show the session, create one.
    const createdTab = await host.createPreview(conversationId);
    if (!isCurrent() && createdTab) await this.#discardUnowned(createdTab, conversationId);
  }

  async #startDraft(isCurrent: NavigationRequestCheck, linkedContentPath?: string): Promise<void> {
    const { membership, parkedDrafts } = this.host;
    this.#assertLinkedContentExists(linkedContentPath);
    // The draft being replaced keeps its text for the next one, which takes it on assembly.
    for (const preview of this.#livePreviews()) parkedDrafts.park(preview);
    const tab = await this.host.createPreview(null);
    if (!tab) throw new Error('Failed to create a provisional chat tab');
    if (!isCurrent()) {
      await this.#discardUnowned(tab, null);
      return;
    }
    try {
      if (linkedContentPath !== undefined) {
        this.#assertLinkedContentExists(linkedContentPath);
        tab.linkedContent.selectExplicit(linkedContentPath);
      }
      if (membership.getActiveTabId() === tab.id) tab.composer.focus();
    } catch (error) {
      await this.host.closeTab(tab.id).catch(() => false);
      throw error;
    }
    // One preview per view: the draft replaces every earlier one.
    await this.#closePreviews(tab.id);
  }

  /** The narrow tab that takes the shown session back when wide ends. */
  #narrowTabFor(preview: AssembledTabRuntime): Readonly<TabIdentity> | null {
    const { membership } = this.host;
    if (!preview.conversationId) return null;
    return membership.getTabIdentities().find(tab => (
      tab.lifecycleState === 'open' && membership.isTabAlive(tab) && tab.conversationId === preview.conversationId
    )) ?? null;
  }

  #hasLivePresentation(): boolean {
    const { membership } = this.host;
    const activeId = membership.getActiveTabId();
    const active = activeId ? membership.getTab(activeId) : null;
    return !!active && membership.isTabAlive(active);
  }

  #activeIdentity(): Readonly<TabIdentity> | null {
    const { membership } = this.host;
    const activeId = membership.getActiveTabId();
    return activeId ? membership.getIdentity(activeId) : null;
  }

  #activePreview(): AssembledTabRuntime | null {
    const { membership } = this.host;
    const activeId = membership.getActiveTabId();
    const active = activeId ? membership.getTab(activeId) : null;
    return active && membership.isTabAlive(active) && active.lifecycleState === 'provisional' ? active : null;
  }

  #livePreviews(): AssembledTabRuntime[] {
    const { membership } = this.host;
    return membership.getAllTabs()
      .filter(tab => membership.isTabAlive(tab) && tab.lifecycleState === 'provisional');
  }

  async #closePreviews(keptTabId: TabId | null): Promise<void> {
    const { membership } = this.host;
    const previewIds = membership.getAllTabs()
      .filter(tab => tab.lifecycleState === 'provisional' && tab.id !== keptTabId)
      .map(tab => tab.id);
    for (const tabId of previewIds) {
      const tab = membership.getTab(tabId);
      if (!tab || !membership.isTabAlive(tab) || tab.lifecycleState !== 'provisional') continue;
      if (await this.host.closeTab(tabId)) continue;
      const refused = membership.getTab(tabId);
      if (refused && membership.isTabAlive(refused)) commitProvisionalTab(refused);
    }
  }

  /** Removes a preview a superseded request created, unless the user already claimed it. */
  async #discardUnowned(tab: AssembledTabRuntime, conversationId: string | null): Promise<void> {
    if (
      this.host.membership.getTab(tab.id) === tab
      && tab.conversationId === conversationId
      && !tab.session.isUserClaimed
    ) {
      await this.host.discardTab(tab.id);
    }
  }

  #assertLinkedContentExists(contentPath: string | undefined): void {
    if (contentPath !== undefined && !linkedContentExists(this.host.app, contentPath)) {
      throw new Error('Linked content is no longer available');
    }
  }
}
