import type { App } from 'obsidian';

import type { DraftSessionHold } from '@/features/chat/sessions/SessionRuntimePool';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { ParkedDrafts } from '@/features/chat/tabs/ParkedDrafts';
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
  /**
   * Creates and activates a provisional tab: reattaching a held draft session by key, or
   * seeding a new draft with a saved selection.
   */
  createPreview(conversationId: string | null, draft?: DraftSource): Promise<AssembledTabRuntime | null>;
  /** Keeps a draft session alive while nothing shows it. */
  holdDraft(tab: AssembledTabRuntime): DraftSessionHold;
  /** The key of the draft session an unloaded blank tab holds, if any. */
  heldDraftKey(tabId: TabId): string | null;
  /** Makes an unloaded blank tab the owner of the draft session `tab` shows. */
  adoptDraft(tabId: TabId, tab: AssembledTabRuntime): void;
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

/** Where a blank preview's draft session comes from: a held session, or a saved selection. */
export type DraftSource = { draftSessionKey?: string } & Partial<Pick<TabIdentity, 'draftModel' | 'providerId'>>;

export interface ViewerSlotRequest {
  /** The tab whose command issued the request; the request lapses once it stops being live. */
  sourceTab?: AssembledTabRuntime | null;
  /** Further validity the request keeps through the destination's assembly and hydration. */
  isValid?: () => boolean;
}

/**
 * The wide layout's single replaceable preview. Tabs are a narrow-layout concept: entering wide
 * unloads every tab (the pool keeps each session; an unloaded blank tab holds its draft), wide
 * navigation only rebinds or replaces the preview, and leaving wide hands the shown session
 * back to its narrow tab or turns the preview into one.
 */
export class ViewerSlot {
  /** The wide layout's new session while another session is shown; New returns to it. */
  #newSession: DraftSessionHold | null = null;

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
   * Enters the wide layout: unloads every narrow tab, parking its unsent input, then shows the
   * selected tab's session in the preview (a blank tab's held draft, or a new one it adopts).
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
        if (tab.lifecycleState !== 'open' || !membership.isTabAlive(tab)) continue;
        parkedDrafts.park(tab);
        await this.host.unloadTab(tab);
      }
      if (!isCurrent()) return;
      if (selection?.conversationId) {
        await this.#show(selection.conversationId, isCurrent);
        return;
      }
      const saved = selection ? membership.getIdentity(selection.id) : null;
      const heldKey = saved ? this.host.heldDraftKey(saved.id) : null;
      const draft = await this.#startDraft(
        isCurrent, undefined, saved ? { ...saved, ...(heldKey ? { draftSessionKey: heldKey } : {}) } : undefined,
      );
      // A blank tab that never had a session continues as the draft the viewer now shows.
      if (saved && draft && !heldKey) this.host.adoptDraft(saved.id, draft);
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
      this.#newSession?.release();
      this.#newSession = null;
      const active = this.#activePreview();
      const narrowTab = active ? this.#narrowTabFor(active) : null;
      if (active && narrowTab) {
        parkedDrafts.park(active);
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

  /** Ends the slot's hold on the wide layout's new session when the view's tabs are destroyed. */
  dispose(): void {
    this.#newSession?.release();
    this.#newSession = null;
  }

  async #show(conversationId: string, isCurrent: NavigationRequestCheck): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (await host.navigation.focusOwner(conversationId, isCurrent, { previewsOnly: true }) || !isCurrent()) return;

    const preview = this.#livePreviews()[0];
    if (preview) {
      if (!preview.conversationId) this.#rememberNewSession(preview);
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

  /**
   * Shows a blank draft: the given held draft session, else the wide layout's last new session
   * unless Linked content asks for a fresh one, else a new draft. Resolves to the shown draft.
   */
  async #startDraft(
    isCurrent: NavigationRequestCheck,
    linkedContentPath?: string,
    source?: DraftSource,
  ): Promise<AssembledTabRuntime | null> {
    const { membership, parkedDrafts } = this.host;
    this.#assertLinkedContentExists(linkedContentPath);
    const active = this.#activePreview();
    // The shown blank draft already is the new session.
    if (active && !active.conversationId && linkedContentPath === undefined && source === undefined) {
      active.composer.focus();
      return active;
    }
    const newSession = linkedContentPath === undefined ? this.#currentNewSession() : null;
    const draft = source ?? (newSession ? { draftSessionKey: newSession.key } : undefined);
    for (const preview of this.#livePreviews()) {
      if (!preview.conversationId && linkedContentPath !== undefined) this.#rememberNewSession(preview);
      parkedDrafts.park(preview);
    }
    const tab = await this.host.createPreview(null, draft);
    if (!tab) throw new Error('Failed to create a provisional chat tab');
    // Attached again, the new session no longer needs the slot's hold.
    if (this.#newSession?.key === tab.session.runtime.sessionKey) {
      this.#newSession.release();
      this.#newSession = null;
    }
    if (!isCurrent()) {
      await this.#discardUnowned(tab, null);
      return null;
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
    return tab;
  }

  /** The held new session, released once it has created its conversation: it is no longer new. */
  #currentNewSession(): DraftSessionHold | null {
    if (this.#newSession?.runtime.conversationId) {
      this.#newSession.release();
      this.#newSession = null;
    }
    return this.#newSession;
  }

  /** Holds a blank preview's draft session so New can return to it after another is shown. */
  #rememberNewSession(preview: AssembledTabRuntime): void {
    if (this.#newSession?.key === preview.session.runtime.sessionKey) return;
    this.#newSession?.release();
    this.#newSession = this.host.holdDraft(preview);
  }

  /** The narrow tab that takes the shown session back when wide ends. */
  #narrowTabFor(preview: AssembledTabRuntime): Readonly<TabIdentity> | null {
    const { membership } = this.host;
    const { sessionKey } = preview.session.runtime;
    return membership.getTabIdentities().find(tab => (
      tab.lifecycleState === 'open' && membership.isTabAlive(tab) && (
        (!!preview.conversationId && tab.conversationId === preview.conversationId)
        || this.host.heldDraftKey(tab.id) === sessionKey
      )
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
