import type { ProviderId } from '@/core/providers/types';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import { TabHydration } from '@/features/chat/tabs/TabHydration';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { activateTab, deactivateTab } from '@/features/chat/tabs/TabLifecycle';
import type { TabMembership } from '@/features/chat/tabs/TabMembership';
import { TabSwitchScheduler } from '@/features/chat/tabs/TabSwitchScheduler';
import type { AssembledTabRuntime, TabManagerCallbacks } from '@/features/chat/tabs/types';

/** Manager operations activation drives; membership is revalidated after every await. */
export interface TabActivationHost {
  readonly membership: TabMembership;
  readonly callbacks: TabManagerCallbacks;
  /** Assembles a restored tab's runtime on its ID without activating it. */
  assembleRestored(identity: TabIdentity): Promise<AssembledTabRuntime | null>;
  ensureWorkspaceServices(tab: AssembledTabRuntime, providerId: ProviderId | null, reason: string): Promise<boolean>;
}

/**
 * Optimistic activation: one switch runs at a time, the new active tab is published before
 * hydration, a failure restores the previous owner, and only a switch that commits is recorded
 * in the committed activation history.
 */
export class TabActivation {
  readonly #scheduler: TabSwitchScheduler;
  readonly #hydration: TabHydration;

  constructor(private readonly host: TabActivationHost) {
    const { membership } = host;
    this.#scheduler = new TabSwitchScheduler({
      canStart: (tabId) => {
        const identity = membership.getIdentity(tabId);
        return !!identity && membership.isTabAlive(identity);
      },
      isDestroyed: () => membership.isDestroyed(),
      getActiveTabId: () => membership.getActiveTabId(),
      executeSwitch: (tabId, onActivationStarted) => this.#executeSwitch(tabId, onActivationStarted),
    });
    this.#hydration = new TabHydration({
      isTabAlive: tab => membership.isTabAlive(tab),
      ensureWorkspaceServices: (tab, providerId, reason) => host.ensureWorkspaceServices(tab, providerId, reason),
      onRetry: (tab) => {
        if (membership.isTabAlive(tab)) void this.switchTo(tab.id);
      },
    });
  }

  get requestRevision(): number {
    return this.#scheduler.requestRevision;
  }

  /** Records the newest activation intent before a new tab's assembly begins. */
  reserveIntent(tabId: TabId): number {
    return this.#scheduler.reserveIntent(tabId);
  }

  /**
   * Activates a tab being admitted. The request keeps its own settlement; `onActivationStarted`
   * reports the predecessor its rollback must restore.
   */
  activateAdmitted(
    tabId: TabId,
    requestRevision: number | null,
    onActivationStarted: (previousTabId: TabId | null) => void,
  ): Promise<void> {
    return this.#scheduler.request(
      tabId,
      true,
      requestRevision ?? this.#scheduler.reserveIntent(tabId),
      onActivationStarted,
    );
  }

  /** Switches to a live tab, assembling a restored one first; publishes the committed switch. */
  async switchTo(tabId: TabId): Promise<void> {
    const { membership } = this.host;
    const identity = membership.getIdentity(tabId);
    if (!identity || !membership.isTabAlive(identity)) return;
    const previousTabId = membership.getActiveTabId();
    await this.#scheduler.request(tabId, false, this.#scheduler.reserveIntent(tabId));
    if (membership.getActiveTabId() !== tabId || previousTabId === tabId) return;

    try {
      this.host.callbacks.onActiveTabCommitted?.(previousTabId, tabId);
    } catch {
      // Selection is committed; an observer failure must not roll it back.
    }
  }

  async waitForIdle(): Promise<void> {
    await this.#scheduler.waitForIdle();
  }

  /**
   * Withdraws a failed admission's optimistic activation and reactivates its predecessor.
   * Returns rollback failures.
   */
  rollbackAdmission(tab: AssembledTabRuntime, previousTabId: TabId | null): unknown[] {
    const { membership } = this.host;
    const errors: unknown[] = [];
    if (membership.getActiveTabId() !== tab.id) return errors;
    try {
      deactivateTab(tab);
    } catch (error) {
      errors.push(error);
    }
    membership.setActiveTabId(null);

    const previousTab = previousTabId ? membership.getTab(previousTabId) : null;
    if (!membership.isDestroyed() && previousTab && previousTab.lifecycleState !== 'closing') {
      try {
        this.#activate(previousTab);
      } catch (error) {
        membership.setActiveTabId(null);
        errors.push(error);
      }
    }
    return errors;
  }

  /** Makes `tab` the optimistic active tab and acknowledges its review attention. */
  #activate(tab: AssembledTabRuntime): void {
    this.host.membership.setActiveTabId(tab.id);
    activateTab(tab);
    tab.session.runtime.peekModel?.acknowledgeReviewIfVisible();
  }

  /** Activation and rollback body; the scheduler runs one at a time after its liveness check. */
  async #executeSwitch(
    tabId: TabId,
    onActivationStarted?: (previousTabId: TabId | null) => void,
  ): Promise<void> {
    const { callbacks, membership } = this.host;
    const member = membership.getMember(tabId);
    if (!member) return;
    const previousTabId = membership.getActiveTabId();
    let activeTabChangePublicationStarted = false;
    let switchRolledBack = false;
    onActivationStarted?.(previousTabId);

    let tab = member.kind === 'assembled' ? member.runtime : null;
    try {
      if (member.kind === 'restored') {
        tab = await this.host.assembleRestored(member.identity);
      }
      if (!tab || !membership.isTabAlive(tab)) return;
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = membership.getTab(previousTabId);
        if (currentTab) deactivateTab(currentTab);
      }

      this.#activate(tab);
      if (callbacks.onActiveTabChanged) {
        activeTabChangePublicationStarted = true;
        callbacks.onActiveTabChanged(previousTabId, tabId);
      }

      if (await this.#hydration.hydrateActivatedTab(tab) !== 'ready') return;
      try {
        callbacks.onTabSwitched?.(previousTabId, tabId);
      } catch {
        // Selection is committed; a completion observer cannot roll it back.
      }
    } catch (error) {
      switchRolledBack = true;
      const rollbackErrors = tab
        ? this.#restorePreviousTab(tab, previousTabId, activeTabChangePublicationStarted)
        : [];
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Failed to switch to tab ${tabId} and restore the previous tab`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (
        !switchRolledBack
        && membership.getActiveTabId() === tabId
        && tab
        && membership.isTabAlive(tab)
      ) {
        membership.recordCommittedActivation(tabId);
      }
    }
  }

  #restorePreviousTab(
    failedTab: AssembledTabRuntime,
    previousTabId: TabId | null,
    republishPreviousTab: boolean,
  ): unknown[] {
    const { callbacks, membership } = this.host;
    const rollbackErrors: unknown[] = [];
    const activeTabId = membership.getActiveTabId();
    const failedTabWasActive = activeTabId === failedTab.id;
    const previousTabWasActive = activeTabId === previousTabId;

    if (failedTabWasActive) {
      try {
        deactivateTab(failedTab);
      } catch (error) {
        rollbackErrors.push(error);
      }
      membership.setActiveTabId(null);
    }

    const previousTab = previousTabId ? membership.getTab(previousTabId) : null;
    if (
      !membership.isDestroyed()
      && previousTab
      && membership.isOwned(previousTab)
      && (failedTabWasActive || previousTabWasActive)
    ) {
      let previousTabRestored = false;
      try {
        this.#activate(previousTab);
        previousTabRestored = true;
      } catch (error) {
        membership.setActiveTabId(null);
        rollbackErrors.push(error);
      }
      if (previousTabRestored && republishPreviousTab) {
        try {
          callbacks.onActiveTabChanged?.(failedTab.id, previousTab.id);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
    }

    return rollbackErrors;
  }
}
