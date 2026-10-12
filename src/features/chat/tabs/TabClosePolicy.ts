import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { deactivateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import type { TabMembership } from '@/features/chat/tabs/TabMembership';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

/** Manager operations a close drives; membership is revalidated after every await. */
export interface TabCloseHost {
  readonly membership: TabMembership;
  switchToTab(tabId: TabId): Promise<void>;
  /** Creates an inactive blank tab so the view keeps one live tab. */
  createReplacement(): Promise<AssembledTabRuntime | null>;
  /** Creates an inactive draft preview to succeed an active preview; null outside the wide layout. */
  createPreviewReplacement(): Promise<AssembledTabRuntime | null>;
  /** Releases manager metadata (command discovery) that outlives membership; returns failures. */
  releaseMetadata(tabId: TabId): readonly unknown[];
  /** Publishes a completed close; not called once the manager is destroyed. */
  onTabClosed(tabId: TabId): void;
}

export function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * Close and discard: claims the tab reversibly, publishes a successor (the last retained tab
 * for a preview, otherwise a neighbour or a fresh blank tab), then tears down irreversibly.
 * Owns in-flight closes so shutdown can join them, and the single shared replacement assembly.
 */
export class TabClosePolicy {
  readonly #inFlight = new Set<Promise<boolean>>();
  #replacement: Promise<AssembledTabRuntime | null> | null = null;

  constructor(private readonly host: TabCloseHost) {}

  /** Closes a tab unless it is the last blank draft; running session work continues. */
  close(tabId: TabId): Promise<boolean> {
    return this.#track(this.#close(tabId, true));
  }

  /** Closes a tab even when it is the last blank draft, installing a fresh draft when needed. */
  discard(tabId: TabId): Promise<boolean> {
    return this.#track(this.#close(tabId, false));
  }

  /**
   * Closes a tab whose successor needs its session: tears it down first, then activates the
   * successor, falling back to any live tab when that activation fails.
   */
  handOver(tabId: TabId, successorId: TabId): Promise<boolean> {
    return this.#track(this.#handOver(tabId, successorId));
  }

  /** Waits for every admitted close, including ones started meanwhile; returns their failures. */
  async drain(): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (this.#inFlight.size > 0) {
      const results = await Promise.allSettled([...this.#inFlight]);
      for (const result of results) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
    }
    return errors;
  }

  #track(operation: Promise<boolean>): Promise<boolean> {
    const tracked = operation.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
    return tracked;
  }

  async #close(tabId: TabId, preserveLastBlank: boolean): Promise<boolean> {
    const { membership } = this.host;
    const member = membership.getMember(tabId);
    if (!member) return false;
    const tab = membership.getIdentity(tabId)!;
    const runtime = member.kind === 'assembled' ? member.runtime : null;
    if (tab.lifecycleState === 'closing' || membership.isCloseClaimed(tabId)) return false;

    // The last tab, already a blank draft, stays as the view's draft container.
    if (
      preserveLastBlank
      && membership.size === 1
      && !tab.conversationId
      && (!runtime || runtime.state.messages.length === 0)
    ) {
      return false;
    }

    // Reserve the close before fallible replacement assembly without fencing state callbacks.
    membership.claimClose(tabId);
    try {
      const idsBefore = membership.getTabIdentities().map(identity => identity.id);
      const closingIndex = idsBefore.indexOf(tabId);
      // Closing the active wide preview shows a draft; elsewhere a preview returns to the retained
      // tab the user last worked in, not its neighbour.
      const previewReplacement = tab.lifecycleState === 'provisional' && membership.getActiveTabId() === tabId
        ? await this.host.createPreviewReplacement()
        : null;
      const retainedId = tab.lifecycleState === 'provisional' && !previewReplacement
        ? membership.getRetainedActiveTabId(tabId, true)
        : null;
      const successor = previewReplacement
        ?? (retainedId ? membership.getIdentity(retainedId) : null)
        ?? this.#findLiveTab(idsBefore, closingIndex)
        ?? await this.#ensureLiveTab();
      if (!successor || membership.getMember(tabId) !== member) return false;

      // Keep the active source reversible until successor activation and publication commit.
      if (membership.getActiveTabId() === tabId) {
        await this.host.switchToTab(successor.id);
        const activeId = membership.getActiveTabId();
        const activeTab = activeId ? membership.getTab(activeId) : null;
        if (!activeTab || activeTab === tab || !membership.isAvailableToAdmittedClose(activeTab)) {
          return false;
        }
      }

      // Replacement admission is complete; teardown is now irreversible.
      const closeErrors = await this.#tearDown(tabId, runtime);
      if (!membership.isDestroyed()) {
        // Reconcile after every close because a different active tab may be closing concurrently.
        try {
          await this.#reconcileActiveTab(idsBefore, closingIndex);
        } catch (error) {
          closeErrors.push(error);
        }
      }

      throwCollectedErrors(closeErrors, `Failed to close tab ${tabId} cleanly`);
      return true;
    } finally {
      membership.releaseCloseClaim(tabId);
    }
  }

  async #handOver(tabId: TabId, successorId: TabId): Promise<boolean> {
    const { membership } = this.host;
    const member = membership.getMember(tabId);
    const successor = membership.getIdentity(successorId);
    if (!member || !successor || !membership.isTabAlive(successor)) return false;
    const tab = membership.getIdentity(tabId)!;
    if (tab.lifecycleState === 'closing' || membership.isCloseClaimed(tabId)) return false;
    const runtime = member.kind === 'assembled' ? member.runtime : null;
    const idsBefore = membership.getTabIdentities().map(identity => identity.id);

    membership.claimClose(tabId);
    try {
      if (runtime && membership.getActiveTabId() === tabId) deactivateTab(runtime);
      const closeErrors = await this.#tearDown(tabId, runtime);
      if (membership.isDestroyed()) return true;
      try {
        await this.host.switchToTab(successorId);
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        await this.#reconcileActiveTab(idsBefore, idsBefore.indexOf(tabId));
      } catch (error) {
        closeErrors.push(error);
      }
      throwCollectedErrors(closeErrors, `Failed to hand tab ${tabId} over cleanly`);
      return true;
    } finally {
      membership.releaseCloseClaim(tabId);
    }
  }

  /**
   * Irreversibly tears a claimed tab down: releases its metadata and resources, then its
   * membership even if teardown fails, and publishes the close while the manager is live.
   */
  async #tearDown(tabId: TabId, runtime: AssembledTabRuntime | null): Promise<unknown[]> {
    const { membership } = this.host;
    membership.beginClose(tabId);
    // Closing tabs cannot recreate metadata, so in-flight discovery is released once, now.
    const errors: unknown[] = [...this.host.releaseMetadata(tabId)];
    try {
      if (runtime) await destroyTab(runtime);
    } catch (error) {
      errors.push(error);
    }
    membership.remove(tabId);
    if (membership.getActiveTabId() === tabId) membership.setActiveTabId(null);
    if (!membership.isDestroyed()) {
      try {
        this.host.onTabClosed(tabId);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #reconcileActiveTab(idsBefore: readonly TabId[], closingIndex: number): Promise<void> {
    const { membership } = this.host;
    if (membership.isDestroyed()) return;
    const activeId = membership.getActiveTabId();
    const activeTab = activeId ? membership.getTab(activeId) : null;
    if (activeTab && membership.isTabAlive(activeTab)) return;

    let replacement = this.#findLiveTab(idsBefore, closingIndex);
    if (!replacement) {
      try {
        replacement = await this.#ensureLiveTab();
      } catch (error) {
        replacement = this.#findLiveTab(idsBefore, closingIndex);
        if (!replacement) throw error;
      }
    }
    if (!replacement || !membership.isTabAlive(replacement)) return;
    if (membership.getActiveTabId() !== replacement.id) {
      await this.host.switchToTab(replacement.id);
    }
  }

  /** The nearest live tab around the closing position, then any live tab. */
  #findLiveTab(idsBefore: readonly TabId[], closingIndex: number): Readonly<TabIdentity> | null {
    const { membership } = this.host;
    if (membership.isDestroyed()) return null;
    const before = idsBefore.slice(0, Math.max(0, closingIndex)).reverse();
    const after = idsBefore.slice(Math.max(0, closingIndex + 1));
    const candidateIds = new Set<TabId>([
      ...(closingIndex === 0 ? [...after, ...before] : [...before, ...after]),
      ...membership.getTabIdentities().map(identity => identity.id),
    ]);
    for (const id of candidateIds) {
      const candidate = membership.getIdentity(id);
      if (candidate && membership.isTabAlive(candidate)) return candidate;
    }
    return null;
  }

  /** Any live tab, or one shared blank replacement while none exists. */
  async #ensureLiveTab(): Promise<Readonly<TabIdentity> | null> {
    const { membership } = this.host;
    if (membership.isDestroyed()) return null;
    const existing = membership.getTabIdentities().find(identity => membership.isTabAlive(identity));
    if (existing) return existing;
    if (this.#replacement) return this.#replacement;

    const replacement = this.host.createReplacement();
    this.#replacement = replacement;
    try {
      return await replacement;
    } finally {
      if (this.#replacement === replacement) this.#replacement = null;
    }
  }
}
