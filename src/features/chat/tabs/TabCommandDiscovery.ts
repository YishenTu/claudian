import { resolveCommandDiscoveryTimeoutMs } from '@/core/providers/commands/catalogCommandDiscovery';
import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { Conversation, SlashCommand } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabId, TabProviderCatalogContext } from '@/features/chat/tabs/ChatTab';
import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import type { AssembledTabRuntime, ProviderCatalogInfo, TabMembershipView } from '@/features/chat/tabs/types';
import { throwIfAborted, toAbortError } from '@/utils/abort';

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

type ProviderCommandLoadEntry = {
  abortController: AbortController;
  key: string;
  promise: Promise<ProviderCommandDiscoveryResult<SlashCommand>>;
};

type SDKCommandDiscovery = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  commandSnapshot?: readonly SlashCommand[];
};

const ABORT_MESSAGE = 'Provider command discovery aborted';

/**
 * Owns on-demand provider command discovery for one tab manager. Discovery reads the
 * live session snapshot first, then an isolated metadata probe for the active tab only;
 * it never runs eagerly and never creates chat sessions.
 */
export class TabCommandDiscovery {
  private readonly providerRuntimeCommandLoads = new Map<TabId, ProviderCommandLoadEntry>();
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
      const providerId = getTabProviderId(tab, this.plugin);
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
      ProviderWorkspaceRegistry.getCommandCatalog(providerId)?.setCommandSnapshot([]);
    }

    const filter = new Set(ids);
    for (const tab of this.membership.getAllTabs()) {
      const providerId = getTabProviderId(tab, this.plugin);
      if (!providerId || !filter.has(providerId)) continue;
      this.invalidateTab(tab.id);
    }
  }

  /** Resolves the command dropdown config and discovery source for a live tab. */
  getProviderCatalogConfig(tab: TabProviderCatalogContext): ProviderCatalogInfo {
    if (this.membership.isDestroyed() || tab.lifecycleState === 'closing') return null;

    const providerId = getTabProviderId(tab, this.plugin);
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

    const providerId = getTabProviderId(targetTab, this.plugin);
    if (!providerId) return { status: 'empty' };
    const discovery = await this.#getSdkCommandDiscovery(targetTab.id, signal);
    throwIfAborted(signal, ABORT_MESSAGE);
    if (!this.#isTabProviderCurrent(targetTab, providerId)) return { status: 'empty' };
    const { result } = discovery;
    if (result.status === 'error' || result.status === 'requires-session') {
      return result;
    }

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return { status: 'empty' };
    const entries = await catalog.listDropdownEntries({
      includeBuiltIns: true,
      signal,
      allowCachedCommandSnapshot: discovery.commandSnapshot !== undefined,
      ...(discovery.commandSnapshot !== undefined
        ? { commandSnapshot: discovery.commandSnapshot }
        : {}),
    });
    if (!this.#isTabProviderCurrent(targetTab, providerId)) return { status: 'empty' };
    return normalizeProviderCommandDiscoveryItems(entries);
  }

  /** Cancels and forgets a tab's discovery state, collecting failures for the caller. */
  releaseTab(tabId: TabId): unknown[] {
    const errors: unknown[] = [];
    try {
      this.#cancelRuntimeCommandLoad(tabId);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.providerCommandDiscoveryStores.get(tabId)?.invalidate();
    } catch (error) {
      errors.push(error);
    } finally {
      this.providerRuntimeCommandLoads.delete(tabId);
      this.providerRuntimeCommandCache.delete(tabId);
      this.providerCommandDiscoveryStores.delete(tabId);
      this.tabCommandContextRevisions.delete(tabId);
    }
    return errors;
  }

  /** Tab IDs that still own any discovery state, including state outliving membership. */
  getTrackedTabIds(): TabId[] {
    return [...new Set<TabId>([
      ...this.providerRuntimeCommandLoads.keys(),
      ...this.providerRuntimeCommandCache.keys(),
      ...this.providerCommandDiscoveryStores.keys(),
      ...this.tabCommandContextRevisions.keys(),
    ])];
  }

  clear(): void {
    this.providerRuntimeCommandLoads.clear();
    this.providerRuntimeCommandCache.clear();
    this.providerCommandDiscoveryStores.clear();
    this.tabCommandContextRevisions.clear();
  }

  #isTabProviderCurrent(tab: AssembledTabRuntime, providerId: ProviderId): boolean {
    return this.membership.isTabAlive(tab) && getTabProviderId(tab, this.plugin) === providerId;
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

    const providerId = getTabProviderId(targetTab, this.plugin);
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

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
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
    let result: ProviderCommandDiscoveryResult<SlashCommand> = { status: 'empty' };
    let hasCommandSnapshot = false;

    if (commandLoader) {
      hasCommandSnapshot = true;
      result = await this.#ensureRuntimeCommands(targetTab, providerId, lookup, signal);
    }

    if (!this.#isTabProviderCurrent(targetTab, providerId)) {
      return { result: { status: 'empty' } };
    }

    if (
      catalog
      && hasCommandSnapshot
      && targetTab.id === this.membership.getActiveTabId()
      && this.#isContextCurrent(targetTab, providerId, commandContext)
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      catalog.setCommandSnapshot(result.status === 'ready' ? [...result.items] : []);
    }
    return {
      result,
      ...(hasCommandSnapshot && (result.status === 'ready' || result.status === 'empty')
        ? { commandSnapshot: result.status === 'ready' ? result.items : [] }
        : {}),
    };
  }

  async #ensureRuntimeCommands(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    lookup: ProviderCommandLookup,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    throwIfAborted(signal, ABORT_MESSAGE);
    if (
      !this.membership.isTabAlive(tab)
      || !this.#isCommandLoaderAvailable(providerId)
    ) {
      return { status: 'empty' };
    }

    const context = this.#buildContext(tab, providerId, lookup);
    if (!this.#isContextCurrent(tab, providerId, context)) {
      return { status: 'empty' };
    }
    const cached = this.providerRuntimeCommandCache.get(tab.id);
    if (cached && cached.key === context.cacheKey) {
      return cached.result.status === 'ready'
        ? { status: 'ready', items: cached.result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
        : cached.result;
    }

    const existing = this.providerRuntimeCommandLoads.get(tab.id);
    if (existing?.key === context.cacheKey) {
      const result = await this.#awaitLoad(existing, signal);
      return this.#isTabProviderCurrent(tab, providerId) ? result : { status: 'empty' };
    }
    this.#cancelRuntimeCommandLoad(tab.id);
    if (!this.#isContextCurrent(tab, providerId, context)) {
      return { status: 'empty' };
    }

    const abortController = new AbortController();
    const load = this.#loadRuntimeCommands(
      tab,
      providerId,
      context,
      abortController.signal,
    ).finally(() => {
      if (this.providerRuntimeCommandLoads.get(tab.id)?.promise === load) {
        this.providerRuntimeCommandLoads.delete(tab.id);
      }
    });
    const entry: ProviderCommandLoadEntry = {
      abortController,
      key: context.cacheKey,
      promise: load,
    };
    this.providerRuntimeCommandLoads.set(tab.id, entry);
    const result = await this.#awaitLoad(entry, signal);
    return this.#isTabProviderCurrent(tab, providerId) ? result : { status: 'empty' };
  }

  #isCommandLoaderAvailable(providerId: ProviderId): boolean {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    if (!loader) return false;
    return loader.isAvailable(this.plugin.settings);
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
    this.#cancelRuntimeCommandLoad(tabId);
    this.providerRuntimeCommandCache.delete(tabId);
    return true;
  }

  #cancelRuntimeCommandLoad(tabId: TabId): void {
    const load = this.providerRuntimeCommandLoads.get(tabId);
    if (!load) {
      return;
    }
    load.abortController.abort();
    this.providerRuntimeCommandLoads.delete(tabId);
  }

  async #awaitLoad(
    load: ProviderCommandLoadEntry,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    if (signal.aborted) {
      load.abortController.abort();
      throwIfAborted(signal, ABORT_MESSAGE);
    }

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        load.abortController.abort();
        reject(toAbortError(signal, ABORT_MESSAGE));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([load.promise, aborted]);
    } finally {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
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

  async #loadRuntimeCommands(
    tab: AssembledTabRuntime,
    providerId: ProviderId,
    context: ProviderCommandContext,
    signal: AbortSignal,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    const loader = ProviderWorkspaceRegistry.getCommandLoader(providerId);
    if (!loader) {
      return { status: 'empty' };
    }
    const result = await loader.loadCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      conversation: context.conversation,
      plugin: this.plugin.providerHost,
      signal,
    });

    if (
      this.#isContextCurrent(tab, providerId, context)
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      this.providerRuntimeCommandCache.set(tab.id, {
        key: context.cacheKey,
        result: result.status === 'ready'
          ? { status: 'ready', items: result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
          : result,
      });
    } else if (this.#isContextCurrent(tab, providerId, context)) {
      this.providerRuntimeCommandCache.delete(tab.id);
    }
    return result;
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
        onBeforeRetry: () => {
          this.#advanceCommandContextRevision(tabId);
        },
        resolveTimeoutMs: () => {
          const tab = this.membership.getTab(tabId);
          if (!tab || !this.membership.isTabAlive(tab)) return undefined;
          const providerId = getTabProviderId(tab, this.plugin);
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
