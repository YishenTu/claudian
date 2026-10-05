import { StartupProfiler } from '@/core/performance/StartupProfiler';
import type { ProviderId } from '@/core/providers/types';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';

/** `aborted`: the tab stopped being live; `failed`: the error state is rendered with a retry. */
export type TabHydrationOutcome = 'aborted' | 'ready' | 'failed';

export interface TabHydrationDeps {
  isTabAlive(tab: AssembledTabRuntime): boolean;
  ensureWorkspaceServices(
    tab: AssembledTabRuntime,
    providerId: ProviderId | null,
    reason: string,
  ): Promise<boolean>;
  /** Invoked by the rendered retry control; the caller owns re-activation. */
  readonly onRetry: (tab: AssembledTabRuntime) => void;
}

/**
 * Loads an activated tab's conversation into its UI. Hydration has its own lifetime: it
 * never creates provider execution, and a tab that stops being live aborts it silently.
 */
export class TabHydration {
  #profiledFirstHydration = false;

  constructor(private readonly deps: TabHydrationDeps) {}

  /**
   * Shows a loading state after paint, prepares provider workspace services, then hydrates.
   * Failures before hydration starts propagate so the caller can roll back activation.
   */
  async hydrateActivatedTab(tab: AssembledTabRuntime): Promise<TabHydrationOutcome> {
    const { deps } = this;
    const providerId = tab.providerId;
    const needsHydration = !!tab.conversationId && tab.hydrationState !== 'ready';
    if (needsHydration) {
      tab.hydrationState = 'loading';
      renderTabHydrationState(tab, undefined, deps.onRetry);
      await waitForTabPaint(tab);
      if (!deps.isTabAlive(tab)) return 'aborted';
    }

    try {
      if (!await deps.ensureWorkspaceServices(tab, providerId, 'tab-activation')) {
        return 'aborted';
      }

      if (needsHydration && tab.conversationId) {
        const span = this.#profiledFirstHydration ? null : StartupProfiler.start('active-hydration');
        this.#profiledFirstHydration = true;
        try {
          await tab.controllers.conversationController.switchTo(tab.conversationId);
        } finally {
          if (span) {
            StartupProfiler.finish(span);
          }
        }
        if (!deps.isTabAlive(tab)) return 'aborted';
        tab.hydrationState = 'ready';
      } else if (tab.conversationId && tab.state.messages.length > 0) {
        tab.hydrationState = 'ready';
      } else if (!tab.conversationId && tab.state.messages.length === 0) {
        // New tab with no conversation - initialize welcome greeting
        tab.controllers.conversationController.initializeWelcome();
        tab.hydrationState = 'ready';
      }
    } catch (error) {
      if (!deps.isTabAlive(tab)) return 'aborted';
      tab.hydrationState = 'failed';
      renderTabHydrationState(tab, error, deps.onRetry);
      return 'failed';
    }

    return deps.isTabAlive(tab) ? 'ready' : 'aborted';
  }
}

function waitForTabPaint(tab: AssembledTabRuntime): Promise<void> {
  return new Promise(resolve => {
    scheduleAnimationFrame(resolve, tab.dom.contentEl.ownerDocument?.defaultView ?? null);
  });
}

function renderTabHydrationState(
  tab: AssembledTabRuntime,
  error: unknown,
  onRetry: (tab: AssembledTabRuntime) => void,
): void {
  const messagesEl = tab.dom.messagesEl;
  messagesEl.empty();

  const statusEl = messagesEl.createDiv({ cls: 'claudian-tab-hydration' });
  if (!error) {
    statusEl.createDiv({
      cls: 'claudian-tab-hydration-loading',
      text: 'Loading conversation…',
    });
    return;
  }

  statusEl.createDiv({
    cls: 'claudian-tab-hydration-error',
    text: error instanceof Error ? error.message : 'Failed to load conversation',
  });
  const retryButton = statusEl.createEl('button', {
    cls: 'mod-cta claudian-tab-hydration-retry',
    text: 'Retry',
  });
  retryButton.addEventListener('click', () => {
    onRetry(tab);
  });
}
