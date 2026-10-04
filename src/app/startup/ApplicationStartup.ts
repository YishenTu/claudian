import { Notice, type Plugin } from 'obsidian';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import type { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderId, ProviderSessionArchive } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { setLocale } from '@/i18n/i18n';
import type { Locale } from '@/i18n/types';
import { getVaultPath } from '@/utils/path';

import { ConversationRepository } from '../conversations/ConversationRepository';
import { ConversationService } from '../conversations/ConversationService';
import { NativeSessionArchiveSync } from '../conversations/NativeSessionArchiveSync';
import { SessionMetadataLoader } from '../conversations/SessionMetadataLoader';
import { ChatModelSelectionCoordinator } from '../settings/ChatModelSelectionCoordinator';
import { PinnedLinkedContentPathCoordinator } from '../settings/PinnedLinkedContentPathCoordinator';
import { RuntimeSettingsCoordinator } from '../settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '../settings/SettingsCoordinator';
import { SharedStorageService } from '../storage/SharedStorageService';
import { TabWorkspaceMigrationCoordinator } from '../storage/TabWorkspaceMigrationCoordinator';

export type StartupProviderCatalog = Pick<
  typeof ProviderRegistry,
  | 'getCapabilities'
  | 'getConversationHistoryService'
  | 'getProviderDisplayName'
  | 'getRegisteredProviderIds'
  | 'getSettingsStorageAdapter'
>;

export type StartupProviderSettings = Pick<
  typeof ProviderSettingsCoordinator,
  | 'getProviderSettingsSnapshot'
  | 'invalidateConversationSessions'
  | 'normalizeAllModelVariants'
  | 'normalizeProviderSelection'
  | 'persistProjectedProviderState'
  | 'projectActiveProviderState'
>;

export interface ApplicationStartupOptions {
  /** Plugin data owner for settings files and the legacy tab snapshot. */
  readonly plugin: Plugin;
  readonly defaultSettings: Readonly<ClaudianSettings>;
  readonly providers: StartupProviderCatalog;
  readonly providerSettings: StartupProviderSettings;
  /** Defers sessions not selected for restoration to the background metadata scan. */
  readonly deferNonRestoredSessionMetadata: boolean;
  isChatView(value: unknown): boolean;
  isUnloading(): boolean;
  publishCommittedSettings(
    settings: Readonly<ClaudianSettings>,
    previous: Readonly<ClaudianSettings>,
  ): Promise<void>;
  onConversationDeleted(conversationId: string): Promise<void>;
  onConversationListChanged(): void;
  onAllMetadataLoaded(): void;
  /** Initializes provider-owned workspace resources when native history needs them. */
  ensureProviderWorkspace(providerId: ProviderId): Promise<void>;
  /** Null when the provider has no native archive; may initialize provider services. */
  getSessionArchive(providerId: ProviderId): Promise<ProviderSessionArchive | null>;
}

/** Application domains loaded at startup; the composition root owns their wiring and teardown. */
export interface ApplicationDomains {
  readonly storage: SharedStorageService;
  readonly settings: SettingsCoordinator<ClaudianSettings>;
  readonly chatModelSelection: ChatModelSelectionCoordinator;
  readonly conversationRepository: ConversationRepository;
  readonly conversations: ConversationService;
  readonly nativeSessionArchives: NativeSessionArchiveSync;
  readonly runtimeSettings: RuntimeSettingsCoordinator;
  readonly sessionMetadata: SessionMetadataLoader;
  readonly tabWorkspaceMigration: TabWorkspaceMigrationCoordinator;
}

/**
 * Loads persisted settings and session metadata into complete application domains:
 * settings normalization, metadata adoption and model recovery, runtime
 * reconciliation, and pending provider-session invalidation.
 */
export async function startApplication(options: ApplicationStartupOptions): Promise<ApplicationDomains> {
  const { plugin, providers, providerSettings } = options;
  const workspace = plugin.app.workspace;
  const storage = new SharedStorageService(plugin, options.defaultSettings);
  const tabWorkspaceMigration = new TabWorkspaceMigrationCoordinator(
    storage,
    workspace,
    value => options.isChatView(value),
  );
  const { claudian } = await storage.initialize();
  const settings: ClaudianSettings = {
    ...structuredClone(options.defaultSettings),
    ...claudian,
  };
  const settingsCoordinator = new SettingsCoordinator(
    settings,
    async (next) => {
      providerSettings.normalizeProviderSelection(next);
      providerSettings.persistProjectedProviderState(next);
      await storage.saveClaudianSettings(next);
    },
    (next, previous) => options.publishCommittedSettings(next, previous),
  );
  const chatModelSelection = new ChatModelSelectionCoordinator(settingsCoordinator);
  const pinnedLinkedContentPaths = new PinnedLinkedContentPathCoordinator(settingsCoordinator);
  const conversationRepository = new ConversationRepository({
    providers,
    providerSettings,
    ensureProviderWorkspace: providerId => options.ensureProviderWorkspace(providerId),
    getSettings: () => settings,
    getVaultPath: () => getVaultPath(plugin.app),
    persistence: storage.conversationPersistence,
    onConversationDeleted: conversationId => options.onConversationDeleted(conversationId),
  });
  const runtimeSettings: RuntimeSettingsCoordinator = new RuntimeSettingsCoordinator({
    settings: settingsCoordinator,
    conversations: conversationRepository,
    getSettings: () => settings,
    // Consulted only by post-startup commits, after the loader below exists.
    canCompleteInvalidations: (): boolean => sessionMetadata.hasLoadedAll && !options.isUnloading(),
  });
  const sessionMetadata: SessionMetadataLoader = new SessionMetadataLoader({
    sessions: storage.sessions,
    conversations: conversationRepository,
    providerSettings,
    runtimeSettings,
    isUnloading: () => options.isUnloading(),
    whenLayoutReady: (callback) => {
      if (typeof workspace.onLayoutReady === 'function') {
        workspace.onLayoutReady(callback);
      } else {
        callback();
      }
    },
    onConversationListChanged: () => options.onConversationListChanged(),
    onAllMetadataLoaded: () => options.onAllMetadataLoaded(),
  });
  const nativeSessionArchives = new NativeSessionArchiveSync({
    getConversation: id => conversationRepository.getSync(id),
    getSessionArchive: providerId => options.getSessionArchive(providerId),
    onFailure: (providerId, error) => {
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(`${providers.getProviderDisplayName(providerId)} could not archive or restore its sessions: ${reason}`);
    },
  });
  const conversations = new ConversationService({
    repository: conversationRepository,
    sessionMetadata,
    pinnedLinkedContentPaths,
    nativeSessionArchives,
    onConversationListChanged: () => options.onConversationListChanged(),
  });

  const didNormalizePendingSessionInvalidations = runtimeSettings.syncPendingSessionInvalidations();
  const didNormalizeProviderSelection = providerSettings.normalizeProviderSelection(settings);
  const didNormalizeModelVariants = providerSettings.normalizeAllModelVariants(settings);

  const deferRemainingMetadata = options.deferNonRestoredSessionMetadata;
  const initialMetadataScan = deferRemainingMetadata
    ? {
        records: [],
        complete: false,
        invalidMetadataCount: 0,
      }
    : await StartupProfiler.runAsync(
        'session-metadata-load',
        () => sessionMetadata.readInitialMetadata(),
      );
  const initialModelRecoverySources = initialMetadataScan.records.map(({ metadata }) => (
    sessionMetadata.createShell(metadata)
  ));
  const initialEntries = initialMetadataScan.records.map(({ metadata, needsMigration, source }) => ({
    conversation: sessionMetadata.createShell(metadata),
    needsMigration,
    source,
  }));
  StartupProfiler.recordCount('initial-session-metadata-count', initialEntries.length);
  StartupProfiler.recordCount('session-metadata-count', initialEntries.length);
  StartupProfiler.recordCount(
    'invalid-session-metadata-count',
    initialMetadataScan.invalidMetadataCount,
  );
  await conversationRepository.adoptMetadataConversations(initialEntries);
  conversationRepository.registerHistoricalModelRecoverySources(
    initialModelRecoverySources,
  );
  if (initialMetadataScan.complete) {
    const recoveredModels = await conversationRepository.recoverMissingSelectedModels();
    StartupProfiler.recordCount(
      'recovered-session-model-count',
      recoveredModels.length,
    );
  }
  setLocale(settings.locale as Locale);

  const reconciliation = runtimeSettings.reconcile();
  runtimeSettings.markPendingSessionInvalidations(
    settings,
    reconciliation.sessionInvalidationProviderIds,
  );
  const pendingInvalidatedConversations = conversationRepository.invalidateProviderSessions(
    runtimeSettings.getPendingProviderIds(),
  );
  const completedInvalidationGenerations = initialMetadataScan.complete
    ? new Map(runtimeSettings.getPendingGenerations())
    : new Map<ProviderId, number>();

  providerSettings.projectActiveProviderState(settings);

  if (
    reconciliation.changed
    || didNormalizeModelVariants
    || didNormalizeProviderSelection
    || didNormalizePendingSessionInvalidations
  ) {
    await settingsCoordinator.persistCurrent();
  }

  const conversationsToSave = new Set([
    ...reconciliation.invalidatedConversations,
    ...pendingInvalidatedConversations,
  ]);
  await conversationRepository.persistConversations(Array.from(conversationsToSave));
  await runtimeSettings.completePendingSessionInvalidations(completedInvalidationGenerations);
  sessionMetadata.finishStartup(initialMetadataScan.complete, deferRemainingMetadata);

  return {
    storage,
    settings: settingsCoordinator,
    chatModelSelection,
    conversationRepository,
    conversations,
    nativeSessionArchives,
    runtimeSettings,
    sessionMetadata,
    tabWorkspaceMigration,
  };
}
