import {
  listDiscoveredCommandEntries,
  loadProviderCommands,
  type ProviderCommandLoaderDiscovery,
  resolveCommandDiscoveryTimeoutMs,
  toLoaderDiscovery,
} from '@/core/providers/commands/catalogCommandDiscovery';
import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { Conversation, SlashCommand } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { AssembledTabRuntime, ProviderCatalogInfo, TabMembershipView } from '@/features/chat/tabs/types';
import { throwIfAborted } from '@/utils/abort';

type ProviderRuntimeCommandCacheEntry = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  key: string;
};

type ProviderCommandLookup = {
  commandContextRevision: number;
  conversation: Conversation | null;
  tab: {
    conversationId: string | null;
    providerId: ProviderId;
  };
};

type ProviderCommandContext = ProviderCommandLookup & {
  allowIsolatedMetadataCreation: boolean;
  cacheKey: string;
  providerGeneration: number;
  resourceGeneration: number;
};

type SDKCommandDiscovery = ProviderCommandLoaderDiscovery;

const ABORT_MESSAGE = 'Provider command discovery aborted';

/**
 * Owns on-demand provider command discovery for one tab manager. Discovery reads the
 * live session snapshot first, then an isolated metadata probe for the active tab only;
 * it never runs eagerly and never creates chat sessions.
 */
export class TabCommandDiscovery {
  private readonly providerRuntimeCommandCache = new Map<TabId, ProviderRuntimeCommandCacheEntry>();
  private readonly providerCommandDiscoveryStores = new Map<
    TabId,
    ProviderCommandDiscoveryStore<ProviderCommandEntry>
  >();
  private readonly providerResourceGenerations = new Map<ProviderId, number>();
  private readonly tabCommandContextRevisions = new Map<TabId, number>();

  /** Membership and liveness are revalidated through `membership` across every await. */
  constructor(
    private readonly plugin: ChatFeatureHost,
    private readonly membership: TabMembershipView,
  ) {}

  /** Starts per-tab discovery metadata for a newly assembled runtime. */
  registerTab(tabId: TabId): void {
    this.tabCommandContextRevisions.set(tabId, 0);
    this.#ensureDiscoveryStore(tabId);
  }

  /** Invalidates cached and in-flight discovery after a tab's command context changes. */
  invalidateTab(tabId: TabId): void {
    if (!this.#advanceCommandContextRevision(tabId)) return;
    this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
  }

  invalidateProviders(providerIds?: ProviderId | ProviderId[]): void {
    const filter = providerIds
      ? new Set(Array.isArray(providerIds) ? providerIds : [providerIds])
      : null;
    for (const tab of this.membership.getAllTabs()) {
      if (!this.membership.isTabAlive(tab)) continue;
      const providerId = getSessionProviderId(tab, this.plugin);
      if (!providerId || (filter && !filter.has(providerId))) continue;
      this.invalidateTab(tab.id);
    }
  }

  invalidateProviderResources(
    providerIds: ProviderId | ProviderId[],
    generation: number,
  ): void {
    const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
    for (const providerId of ids) {
      this.providerResourceGenerations.set(
        providerId,
        Math.max(this.#getProviderResourceGeneration(providerId), generation),
      );
    }

    const filter = new Set(ids);
    for (const tab of this.membership.getAllTabs()) {
      const providerId = getSessionProviderId(tab, this.plugin);
      if (!providerId || !filter.has(providerId)) continue;
      this.invalidateTab(tab.id);
    }
  }

  /** Resolves the command dropdown config and discovery source for a live tab. */
  getProviderCatalogConfig(tab: Readonly<TabIdentity>): ProviderCatalogInfo {
    if (this.membership.isDestroyed() || tab.lifecycleState === 'closing') return null;

    const providerId = getSessionProviderId(tab, this.plugin);
    if (!providerId) return null;
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return null;

    return {
      config: catalog.getDropdownConfig(),
      discovery: this.#ensureDiscoveryStore(tab.id),
    };
  }

  async #getProviderCommandDiscovery(
    tabId: TabId,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>> {
    throwIfAborted(signal, ABORT_MESSAGE);
    const targetTab = this.membership.getTab(tabId);
    if (!targetTab || !this.membership.isTabAlive(targetTab)) return { status: 'empty' };

    const providerId = getSessionProviderId(targetTab, this.plugin);
    if (!providerId) return { status: 'empty' };
    const discovery = await this.#getSdkCommandDiscovery(targetTab.id, signal);
    throwIfAborted(signal, ABORT_MESSAGE);
    if (!this.#isTabProviderCurrent(targetTab, providerId)) return { status: 'empty' };
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) {
      const { result } = discovery;
      return result.status === 'error' || result.status === 'requires-session' ? result : { status: 'empty' };
    }
    const entries = await listDiscoveredCommandEntries(catalog, discovery, signal);
    if (!this.#isTabProviderCurrent(targetTab, providerId)) return { status: 'empty' };
    return entries;
  }

  /** Cancels and forgets a tab's discovery state. */
  releaseTab(tabId: TabId): void {
    this.providerCommandDiscoveryStores.get(tabId)?.dispose();
    this.providerRuntimeCommandCache.delete(tabId);
    this.providerCommandDiscoveryStores.delete(tabId);
    this.tabCommandContextRevisions.delete(tabId);
  }

  /** Tab IDs that still own any discovery state, including state outliving membership. */
  getTrackedTabIds(): TabId[] {
    return [...new Set<TabId>([
      ...this.providerRuntimeCommandCache.keys(),
      ...this.providerCommandDiscoveryStores.keys(),
      ...this.tabCommandContextRevisions.keys(),
    ])];
  }

  /** Releases every tab's discovery state. */
  releaseAll(): void {
    for (const tabId of this.getTrackedTabIds()) this.releaseTab(tabId);
  }

  #isTabProviderCurrent(tab: AssembledTabRuntime, providerId: ProviderId): boolean {
    return this.membership.isTabAlive(tab) && getSessionProviderId(tab, this.plugin) === providerId;
  }

  async #getSdkCommandDiscovery(
    tabId: TabId,
    signal: AbortSignal,
  ): Promise<SDKCommandDiscovery> {
    throwIfAborted(signal, ABORT_MESSAGE);
    const targetTab = this.membership.getTab(tabId);
    if (!targetTab || !this.membership.isTabAlive(targetTab)) {
      return { result: { status: 'empty' } };
    }

    const providerId = getSessionProviderId(targetTab, this.plugin);
    if (!providerId) return { result: { status: 'empty' } };
    await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'command-picker');
    throwIfAborted(signal, ABORT_MESSAGE);
    if (!this.#isTabProviderCurrent(targetTab, providerId)) return { result: { status: 'empty' } };

    const staticCapabilities = ProviderRegistry.getCapabilities(providerId);
    if (!staticCapabilities.supportsProviderCommands) {
      return { result: { status: 'empty' } };
    }

    const liveCommands = targetTab.executionCoordinator.getCommandSnapshot(
      targetTab.conversationId, providerId,
    );
    if (liveCommands !== undefined) {
      return {
        result: normalizeProviderCommandDiscoveryItems([...liveCommands]),
        commandSnapshot: liveCommands,
      };
    }

    const commandLoader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    const lookup = await this.#buildLookup(targetTab, providerId);
    throwIfAborted(signal, ABORT_MESSAGE);
    const commandContext = this.#buildContext(targetTab, providerId, lookup);
    if (!this.#isContextCurrent(targetTab, providerId, commandContext)) {
      return { result: { status: 'empty' } };
    }
    if (
      targetTab.conversationId === null
      && commandLoader
      && targetTab.id !== this.membership.getActiveTabId()
    ) {
      return { result: { status: 'empty' }, commandSnapshot: [] };
    }
    // Without a loader the catalog discovers on its own.
    if (!commandLoader) return { result: { status: 'empty' } };
    const result = await this.#ensureRuntimeCommands(targetTab, providerId, commandContext, signal);
    if (!this.#isTabProviderCurrent(targetTab, providerId)) {
      return { result: { status: 'empty' } };
    }
    return toLoaderDiscovery(result);
  }

  /** Returns the cached loader answer for this context, or loads it under the store's signal. */
  async #ensureRuntimeCommands(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    context: ProviderCommandContext,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    const cached = this.providerRuntimeCommandCache.get(tab.id);
    if (cached?.key === context.cacheKey) return cached.result;

    const result = await loadProviderCommands(providerId, {
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      conversation: context.conversation,
      plugin: this.plugin.providerHost,
      signal,
    });
    if (this.#isContextCurrent(tab, providerId, context)) {
      if (result.status === 'ready' || result.status === 'empty') {
        this.providerRuntimeCommandCache.set(tab.id, { key: context.cacheKey, result });
      } else {
        this.providerRuntimeCommandCache.delete(tab.id);
      }
    }
    return result;
  }

  async #buildLookup(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ): Promise<ProviderCommandLookup> {
    const commandContextRevision = this.tabCommandContextRevisions.get(tab.id) ?? 0;
    const conversationId = tab.conversationId;
    const conversation = conversationId
      ? await this.plugin.getConversationById(conversationId)
      : null;
    return {
      commandContextRevision,
      conversation,
      tab: {
        conversationId,
        providerId,
      },
    };
  }

  #getProviderResourceGeneration(providerId: ProviderId): number {
    return this.providerResourceGenerations.get(providerId)
      ?? this.plugin.getAgentSkillResourceGeneration?.()
      ?? 0;
  }

  #advanceCommandContextRevision(tabId: TabId): boolean {
    const tab = this.membership.getTab(tabId);
    if (!tab || !this.membership.isTabStateMutable(tab)) return false;

    this.tabCommandContextRevisions.set(
      tabId,
      (this.tabCommandContextRevisions.get(tabId) ?? 0) + 1,
    );
    this.providerRuntimeCommandCache.delete(tabId);
    return true;
  }

  #isContextCurrent(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    context: ProviderCommandContext,
  ): boolean {
    return this.#isTabProviderCurrent(tab, providerId)
      && tab.conversationId === context.tab.conversationId
      && (this.tabCommandContextRevisions.get(tab.id) ?? 0) === context.commandContextRevision
      && this.plugin.providerHost.executionLifecycleRegistry.getProviderGeneration(providerId)
        === context.providerGeneration
      && this.#getProviderResourceGeneration(providerId) === context.resourceGeneration;
  }

  #buildContext(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    lookup: ProviderCommandLookup,
  ): ProviderCommandContext {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    const fingerprint = loader?.getCacheFingerprint(this.plugin.settings) ?? 'catalog';
    const commandContextRevision = lookup.commandContextRevision;
    const providerGeneration = this.plugin.providerHost.executionLifecycleRegistry
      .getProviderGeneration(providerId);
    const resourceGeneration = this.#getProviderResourceGeneration(providerId);
    // Isolated metadata processes start only for the tab whose picker asked.
    const allowIsolatedMetadataCreation = tab.id === this.membership.getActiveTabId();

    return {
      ...lookup,
      allowIsolatedMetadataCreation,
      cacheKey: [
        providerId,
        commandContextRevision,
        providerGeneration,
        resourceGeneration,
        fingerprint,
        allowIsolatedMetadataCreation ? 1 : 0,
      ].join('|'),
      commandContextRevision,
      providerGeneration,
      resourceGeneration,
    };
  }

  async #watchCommands(tabId: TabId, signal: AbortSignal, onChange: () => void): Promise<void> {
    const tab = this.membership.getTab(tabId);
    if (!tab || !this.membership.isTabAlive(tab) || tabId !== this.membership.getActiveTabId()) return;
    const providerId = getSessionProviderId(tab, this.plugin);
    if (!providerId) return;
    await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'command-picker');
    signal.throwIfAborted();
    if (!this.#isTabProviderCurrent(tab, providerId) || tabId !== this.membership.getActiveTabId()) return;
    const loader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    const lookup = await this.#buildLookup(tab, providerId);
    signal.throwIfAborted();
    if (!this.#isTabProviderCurrent(tab, providerId) || tabId !== this.membership.getActiveTabId()) return;
    await loader?.watchCommands?.({
      allowIsolatedMetadataCreation: true, conversation: lookup.conversation, plugin: this.plugin.providerHost, signal,
    }, () => { if (!signal.aborted && this.#isTabProviderCurrent(tab, providerId) && tabId === this.membership.getActiveTabId()) onChange(); });
  }

  #ensureDiscoveryStore(
    tabId: TabId,
  ): ProviderCommandDiscoveryStore<ProviderCommandEntry> {
    const existing = this.providerCommandDiscoveryStores.get(tabId);
    if (existing) {
      return existing;
    }

    const discovery = new ProviderCommandDiscoveryStore(
      signal => this.#getProviderCommandDiscovery(tabId, signal),
      {
        watchChanges: (signal, onChange) => this.#watchCommands(tabId, signal, onChange),
        onBeforeRetry: () => {
          this.#advanceCommandContextRevision(tabId);
        },
        resolveTimeoutMs: () => {
          const tab = this.membership.getTab(tabId);
          if (!tab || !this.membership.isTabAlive(tab)) return undefined;
          const providerId = getSessionProviderId(tab, this.plugin);
          if (!providerId) return undefined;
          const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
          return catalog
            ? resolveCommandDiscoveryTimeoutMs(catalog.getDropdownConfig())
            : undefined;
        },
      },
    );
    this.providerCommandDiscoveryStores.set(tabId, discovery);
    return discovery;
  }
}
