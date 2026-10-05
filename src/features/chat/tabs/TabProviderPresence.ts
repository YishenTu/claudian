import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { refreshTabWorkspaceServices } from '@/features/chat/tabs/tabProviderUI';
import type { TabSessionState } from '@/features/chat/tabs/TabSession';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';

/**
 * Owns provider workspace readiness driven by tab presence. Providers declaring
 * `startsSharedRuntimeOnTabPresence` start their shared runtime once per provider while a
 * committed tab uses them; this never creates a session, thread, or turn.
 */
export class TabProviderPresence {
  readonly #runtimeStarts = new Map<ProviderId, Promise<void>>();

  constructor(
    private readonly plugin: ChatFeatureHost,
    private readonly membership: TabMembershipView,
    private readonly hasCommittedTabFor: (providerId: ProviderId) => boolean,
  ) {}

  /** Best-effort passive startup; explicit actions report startup failures themselves. */
  startForTab(tab: TabSessionState): void {
    const providerId = tab.providerId;
    if (this.membership.isDestroyed() || tab.lifecycleState === 'closing' || !providerId
      || !ProviderRegistry.isEnabled(providerId, this.plugin.settings)
      || !ProviderRegistry.getCapabilities(providerId).startsSharedRuntimeOnTabPresence
      || this.#runtimeStarts.has(providerId)) return;
    const startup = (async () => {
      await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'tab-presence');
      if (this.membership.isDestroyed() || !this.hasCommittedTabFor(providerId)) return;
      await ProviderWorkspaceRegistry.getIfInitialized(providerId)?.startRuntime?.();
    })();
    this.#runtimeStarts.set(providerId, startup);
    void startup.catch(() => undefined).finally(() => {
      if (this.#runtimeStarts.get(providerId) === startup) this.#runtimeStarts.delete(providerId);
    });
  }

  /**
   * Initializes the provider workspace, then refreshes the tab's provider services.
   * Returns false when the tab stopped being live while initialization was pending.
   */
  async ensureWorkspaceServices(
    tab: AssembledTabRuntime,
    providerId: ProviderId | null,
    reason: string,
  ): Promise<boolean> {
    if (providerId) {
      await ProviderWorkspaceRegistry.ensureInitialized(
        this.plugin.providerHost,
        providerId,
        reason,
      );
    }
    if (!this.membership.isTabAlive(tab)) {
      return false;
    }
    refreshTabWorkspaceServices(tab, this.plugin);
    this.startForTab(tab);
    return true;
  }
}
