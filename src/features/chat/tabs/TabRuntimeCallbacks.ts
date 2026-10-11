import { type ForkTargetHost, openForkTarget } from '@/features/chat/tabs/forking/ForkTarget';
import type { TabCommandDiscovery } from '@/features/chat/tabs/TabCommandDiscovery';
import type { TabConversationNavigation } from '@/features/chat/tabs/TabConversationNavigation';
import type { TabMembership } from '@/features/chat/tabs/TabMembership';
import type { TabProviderPresence } from '@/features/chat/tabs/TabProviderPresence';
import type { TabRuntimeFactoryOptions } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime, TabLayoutPolicy, TabManagerCallbacks } from '@/features/chat/tabs/types';

/** Manager collaborators that runtime events reach; liveness is revalidated through `membership`. */
export interface TabRuntimeCallbackHost {
  readonly membership: TabMembership;
  readonly callbacks: TabManagerCallbacks;
  readonly commandDiscovery: TabCommandDiscovery;
  readonly providerPresence: TabProviderPresence;
  readonly navigation: TabConversationNavigation;
  readonly layoutPolicy: TabLayoutPolicy;
  readonly forkTargetHost: ForkTargetHost;
  /** Shutdown has begun but the final identity snapshot is not sealed yet. */
  isShutdownSnapshotOpen(): boolean;
  startNew(tab: AssembledTabRuntime): Promise<void>;
}

export type TabRuntimeCallbacks = Omit<
  TabRuntimeFactoryOptions,
  | 'plugin' | 'containerEl' | 'component' | 'mentionDataProvider' | 'conversation' | 'tabId'
  | 'initialState' | 'draftModel' | 'providerId' | 'lifecycleState'
>;

/**
 * Translates one runtime's events into manager publications. Requests (fork, open, new) require
 * a live tab; state reports require a mutable one, so a closing tab can still record terminal
 * state; identity reports stay accepted until the shutdown snapshot is sealed.
 */
export function createTabRuntimeCallbacks(
  host: TabRuntimeCallbackHost,
  getRuntime: () => AssembledTabRuntime | null,
): TabRuntimeCallbacks {
  const { membership, callbacks, commandDiscovery, providerPresence } = host;
  const liveRuntime = (): AssembledTabRuntime | null => {
    const runtime = getRuntime();
    return runtime && membership.isTabAlive(runtime) ? runtime : null;
  };
  return {
    getProviderCatalogConfig: tab => commandDiscovery.getProviderCatalogConfig(tab),
    isRuntimeLive: runtime => membership.isTabAlive(runtime),
    forkRequestCallback: (forkContext) => {
      const sourceTab = liveRuntime();
      return sourceTab ? openForkTarget(host.forkTargetHost, sourceTab, forkContext) : Promise.resolve();
    },
    openConversation: async (id) => {
      const sourceTab = liveRuntime();
      if (!sourceTab) return;
      // The active layout may give session selection its own semantics (the wide viewer slot).
      if (await host.layoutPolicy.openPicked(id, sourceTab)) return;
      if (!membership.isTabAlive(sourceTab)) return;
      await host.navigation.open(id, {}, sourceTab);
    },
    startNewConversation: async () => {
      const sourceTab = liveRuntime();
      if (!sourceTab) return;
      if (await host.layoutPolicy.startNew(sourceTab)) return;
      if (!membership.isTabAlive(sourceTab)) return;
      await host.startNew(sourceTab);
    },
    onStreamingChanged: (runtime, isStreaming) => {
      if (membership.isTabStateMutable(runtime)) callbacks.onTabStreamingChanged?.(runtime.id, isStreaming);
    },
    onWorkChanged: (runtime) => {
      if (membership.isTabStateMutable(runtime)) callbacks.onTabWorkChanged?.(runtime.id);
    },
    onRewindingChanged: (runtime, isRewinding) => {
      if (membership.isTabStateMutable(runtime)) callbacks.onTabRewindingChanged?.(runtime.id, isRewinding);
    },
    onAttentionChanged: (runtime, attention) => {
      if (membership.isTabStateMutable(runtime)) callbacks.onTabAttentionChanged?.(runtime.id, attention);
    },
    captureReviewableSettlement: (runtime, outcome) => {
      const shouldReport = membership.isTabStateMutable(runtime) && membership.getActiveTabId() !== runtime.id;
      // Activation (or a new turn) acknowledges review; a settlement captured before it is stale.
      const reviewEpoch = runtime.state.reviewEpoch;
      return () => {
        if (
          shouldReport
          && membership.isTabStateMutable(runtime)
          && runtime.state.reviewEpoch === reviewEpoch
        ) {
          runtime.state.markReviewRequired(outcome);
        }
      };
    },
    onConversationIdChanged: (runtime, conversationId) => {
      if (!membership.isOwned(runtime)) return;
      const destroyed = membership.isDestroyed();
      if (destroyed && !host.isShutdownSnapshotOpen()) return;
      if (!destroyed) commandDiscovery.invalidateTab(runtime.id);
      callbacks.onTabConversationChanged?.(runtime.id, conversationId);
      providerPresence.startForTab(runtime);
    },
    onDraftModelChanged: (runtime, draftModel) => {
      if (!membership.isTabStateMutable(runtime)) return;
      callbacks.onTabDraftChanged?.(runtime.id, draftModel);
      providerPresence.startForTab(runtime);
    },
    onCommandContextChanged: (runtime) => {
      commandDiscovery.invalidateTab(runtime.id);
    },
    onProviderChanged: async (runtime, providerId) => {
      if (!membership.isTabAlive(runtime)) return;
      commandDiscovery.invalidateTab(runtime.id);
      if (!await providerPresence.ensureWorkspaceServices(runtime, providerId, 'provider-selection')) return;
      callbacks.onTabProviderChanged?.(runtime.id, providerId);
    },
  };
}
