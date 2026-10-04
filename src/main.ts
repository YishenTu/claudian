import { SessionSnapshotStore } from './app/conversations/SessionSnapshotStore';
import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import type { TAbstractFile } from 'obsidian';
import { Notice, Plugin, TFolder } from 'obsidian';

import type { ConversationService } from './app/conversations/ConversationService';
import type { NativeSessionArchiveSync } from './app/conversations/NativeSessionArchiveSync';
import type { SessionMetadataLoader } from './app/conversations/SessionMetadataLoader';
import { createDefaultClaudianSettings } from './app/settings/defaultSettings';
import { EnvironmentSettingsService } from './app/settings/EnvironmentSettingsService';
import { ProviderChatOptionsReconciler } from './app/settings/ProviderChatOptionsReconciler';
import { migrateSelectedModelMetadata } from './app/settings/SelectedModelMetadataMigration';
import { startApplication } from './app/startup/ApplicationStartup';
import type { SharedStorageService } from './app/storage/SharedStorageService';
import { AgentSkillResources } from './composition/AgentSkillResources';
import { ClaudianChatFeatureHost, ClaudianFeatureHost } from './composition/ClaudianFeatureHosts';
import { ClaudianProviderHost } from './composition/ClaudianProviderHost';
import { ClaudianViews, isClaudianView } from './composition/ClaudianViews';
import { ProviderExecutionLifecycleRegistry } from './core/execution';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from './core/providers/types';
import type { ClaudianSettings } from './core/types';
import { VIEW_TYPE_CLAUDIAN } from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { registerFileMenu } from './features/chat/fileMenu';
import { InactiveSessionArchiver } from './features/chat/session-manager/InactiveSessionArchiver';
import { ZenModeController } from './features/chat/zen/ZenModeController';
import { createInlineEditCommand } from './features/inline-edit/inlineEditCommand';
import { InlineEditSessionOwner } from './features/inline-edit/InlineEditSessionOwner';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { getBuiltInProviderDefaultConfigs } from './providers/defaultProviderConfigs';

export default class ClaudianPlugin extends Plugin {
  readonly executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  providerHost!: ClaudianProviderHost;
  private featureHost!: ClaudianFeatureHost;
  private chatHost!: ClaudianChatFeatureHost;
  /** Live committed settings, following Obsidian's plugin convention. */
  settings!: Readonly<ClaudianSettings>;
  private storage!: SharedStorageService;
  private conversations!: ConversationService;
  private sessionMetadata!: SessionMetadataLoader;
  private nativeSessionArchives!: NativeSessionArchiveSync;
  private providerChatOptions!: ProviderChatOptionsReconciler;
  private inactiveSessionArchiver!: InactiveSessionArchiver;
  private settingsTab: ClaudianSettingTab | null = null;
  private readonly views = new ClaudianViews(
    this.app.workspace,
    () => this.settings.chatViewPlacement,
  );
  private readonly agentSkills = new AgentSkillResources(() => this.views.getAllViews());
  private readonly sessionSnapshots = new SessionSnapshotStore();
  private readonly inlineEditSessions = new InlineEditSessionOwner();
  private readonly zenMode = new ZenModeController({
    app: this.app,
    isEnabled: () => this.settings.enableZenMode,
  });
  private readonly startupMaintenanceAbort = new AbortController();
  private isUnloading = false;
  private vaultRefreshTimer: number | undefined;
  private applicationShutdownPromise: Promise<void> | null = null;
  private modelMetadataMigration: Promise<void> | null = null;
  private sessionSnapshotCleanup: Promise<void> | null = null;
  private sessionInputCleanup: Promise<void> | null = null;
  private sessionInputCleanupTimer: number | null = null;

  async onload() {
    StartupProfiler.startOnload();
    try {
      await StartupProfiler.runAsync('settings-load', () => this.loadApplication());
      this.zenMode.start();
      // Provider workspace services are initialized lazily on first use.

      this.registerView(
        VIEW_TYPE_CLAUDIAN,
        (leaf) => new ClaudianView(leaf, this.chatHost)
      );
      registerFileMenu({
        app: this.app,
        activateView: () => this.views.activateView(),
        getView: () => this.views.getView(),
        registerEvent: eventRef => this.registerEvent(eventRef),
      });
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        void this.handleLinkedContentRename(file, oldPath).catch(() => {
          new Notice('Failed to update linked content paths');
        });
      }));
      this.registerEvent(this.app.vault.on('delete', (file) => {
        void this.handlePinnedLinkedContentDeleted(file).catch(() => {
          new Notice('Failed to update pinned linked content');
        });
      }));
      this.registerEvent(this.app.vault.on('create', (file) => {
        for (const view of this.views.getAllViews()) {
          view.handleLinkedContentCreated(file.path);
        }
        this.scheduleVaultRefresh();
      }));

      this.addRibbonIcon('bot', 'Open Claudian', () => {
        void this.views.activateView();
      });

      this.addCommand({
        id: 'open-view',
        name: 'Open chat view',
        callback: () => {
          void this.views.activateView();
        },
      });

      this.addCommand(createInlineEditCommand({
        host: this.featureHost,
        component: this,
        sessions: this.inlineEditSessions,
      }));

      this.addCommand({
        id: 'new-tab',
        name: 'New',
        checkCallback: (checking: boolean) => {
          if (!this.canCreateNewTab()) return false;

          if (!checking) {
            void this.openNewTab();
          }
          return true;
        },
      });

      this.addCommand({
        id: 'new-session',
        name: 'Replace current conversation',
        checkCallback: (checking: boolean) => {
          const view = this.views.getView();
          if (!view) return false;
          if (view.isDualPaneMode()) return false;

          const tabManager = view.getTabManager();
          if (!tabManager) return false;

          const activeTab = tabManager.getActiveTab();
          if (!activeTab) return false;

          if (activeTab.state.isStreaming) return false;

          if (!checking) {
            void tabManager.createNewConversation();
          }
          return true;
        },
      });

      this.addCommand({
        id: 'close-current-tab',
        name: 'Close current tab',
        checkCallback: (checking: boolean) => {
          const view = this.views.getView();
          if (!view) return false;
          if (view.isDualPaneMode()) return false;

          const tabManager = view.getTabManager();
          if (!tabManager) return false;

          if (!checking) {
            const activeTabId = tabManager.getActiveTabId();
            if (activeTabId) {
              void tabManager.closeTab(activeTabId);
            }
          }
          return true;
        },
      });

      this.addCommand({
        id: 'copy-startup-diagnostics',
        name: 'Copy startup diagnostics',
        callback: async () => {
          const copied = await StartupProfiler.copyToClipboard();
          new Notice(copied ? 'Startup diagnostics copied to clipboard.' : 'Failed to copy startup diagnostics.');
        },
      });

      this.settingsTab = new ClaudianSettingTab(this.app, this, this.featureHost);
      this.addSettingTab(this.settingsTab);
      this.sessionMetadata.scheduleRemainingLoad();
      this.app.workspace.onLayoutReady(() => {
        if (this.isUnloading || this.sessionInputCleanup || this.sessionInputCleanupTimer !== null) return;
        this.sessionInputCleanupTimer = window.setTimeout(() => {
          this.sessionInputCleanupTimer = null;
          if (this.isUnloading) return;
          this.sessionSnapshotCleanup = this.sessionSnapshots.sweep(this.startupMaintenanceAbort.signal);
          this.sessionInputCleanup = this.storage.cleanupObsoleteSessionInputs(this.startupMaintenanceAbort.signal);
        }, 0);
      });
      this.app.workspace.onLayoutReady(() => {
        if (this.isUnloading || this.modelMetadataMigration) return;
        this.modelMetadataMigration = migrateSelectedModelMetadata(
          this.providerHost, this.startupMaintenanceAbort.signal,
        );
      });
    } finally {
      StartupProfiler.finishOnload();
    }
  }

  onunload(): void {
    this.isUnloading = true;
    // Return any zen presentation to its view before asynchronous shutdown.
    this.zenMode.dispose();
    window.clearTimeout(this.vaultRefreshTimer);
    this.vaultRefreshTimer = undefined;
    this.startupMaintenanceAbort.abort();
    if (this.sessionInputCleanupTimer !== null) {
      window.clearTimeout(this.sessionInputCleanupTimer);
      this.sessionInputCleanupTimer = null;
    }
    this.inlineEditSessions.dispose();
    StartupProfiler.freeze();
    this.applicationShutdownPromise ??= this.shutdownApplication();
    void this.applicationShutdownPromise.catch(() => undefined);
  }

  /** Loads the application domains, then assembles the provider, feature, and chat hosts from them. */
  private async loadApplication(): Promise<void> {
    const domains = await startApplication({
      plugin: this,
      defaultSettings: createDefaultClaudianSettings(getBuiltInProviderDefaultConfigs()),
      providers: ProviderRegistry,
      providerSettings: ProviderSettingsCoordinator,
      deferNonRestoredSessionMetadata: true,
      isChatView: isClaudianView,
      isUnloading: () => this.isUnloading,
      publishCommittedSettings: (settings, previous) => this.publishCommittedSettings(settings, previous),
      onConversationDeleted: conversationId => this.resetDeletedConversationTabs(conversationId),
      onConversationListChanged: () => this.notifyConversationViewsChanged(),
      onAllMetadataLoaded: () => this.archiveInactiveSessions(),
      ensureProviderWorkspace: providerId => (
        ProviderWorkspaceRegistry.ensureInitialized(this.providerHost, providerId, 'history')
      ),
      getSessionArchive: providerId => this.providerHost.getSessionArchive(providerId),
    });
    const settings = domains.settings;
    this.settings = settings.getCommittedSettings();
    this.storage = domains.storage;
    this.conversations = domains.conversations;
    this.sessionMetadata = domains.sessionMetadata;
    this.nativeSessionArchives = domains.nativeSessionArchives;

    this.providerChatOptions = new ProviderChatOptionsReconciler({
      settings,
      providers: ProviderRegistry,
      providerSettings: ProviderSettingsCoordinator,
      reconcileConversationModels: providerId => domains.conversationRepository.reconcileSelectedModels(providerId),
      onSettingsReconciled: () => this.settingsTab?.refreshModelOptions(),
      onConversationsChanged: () => this.notifyConversationViewsChanged(),
      onReconciled: (providerId) => {
        for (const view of this.views.getAllViews()) {
          view.refreshModelSelector(providerId);
        }
      },
    });
    const notifyProviderChatOptionsChanged = (providerId: ProviderId): Promise<void> => (
      this.providerChatOptions.notifyChanged(providerId)
    );
    const environment = new EnvironmentSettingsService({
      getSettings: () => settings.getCommittedSettings(),
      runtimeSettings: domains.runtimeSettings,
      executionLifecycle: this.executionLifecycleRegistry,
      providers: ProviderRegistry,
      providerSettings: ProviderSettingsCoordinator,
      onEnvironmentApplied: async (providerIds) => {
        for (const view of this.views.getAllViews()) {
          view.invalidateProviderCommandCaches(providerIds);
        }
        await Promise.all(providerIds.map(notifyProviderChatOptionsChanged));
      },
    });
    this.providerHost = new ClaudianProviderHost({
      app: this.app,
      manifest: this.manifest,
      executionLifecycleRegistry: this.executionLifecycleRegistry,
      storage: domains.storage,
      settings,
      environment,
      notifyProviderChatOptionsChanged,
    });
    const featureDomains = {
      app: this.app,
      providerHost: this.providerHost,
      storage: domains.storage,
      settings,
      environment,
      agentSkills: this.agentSkills,
      conversations: domains.conversations,
      views: this.views,
      notifyProviderChatOptionsChanged,
    };
    this.featureHost = new ClaudianFeatureHost(featureDomains);
    this.chatHost = new ClaudianChatFeatureHost({
      ...featureDomains,
      executionPersistence: domains.conversationRepository,
      chatModelSelection: domains.chatModelSelection,
      sessionSnapshots: this.sessionSnapshots,
      tabWorkspaceMigration: domains.tabWorkspaceMigration,
      zenMode: this.zenMode,
    });
    this.inactiveSessionArchiver = new InactiveSessionArchiver(this.chatHost);
  }

  private async shutdownApplication(): Promise<void> {
    await Promise.allSettled([
      this.sessionMetadata?.dispose(),
      this.sessionInputCleanup,
      this.sessionSnapshotCleanup,
      ...this.views.getAllViews().map(view => view.prepareForPluginUnload()),
    ]);
    // Admitted native archive work needs provider services that are disposed below.
    await this.nativeSessionArchives?.dispose();
    try {
      await this.executionLifecycleRegistry.dispose();
    } catch {
      // Continue releasing provider workspaces even if execution cleanup fails.
    }
    try {
      await ProviderWorkspaceRegistry.disposeInitialized();
    } catch {
      // Obsidian teardown has no error channel; workspace cleanup is best effort.
    }
    await this.modelMetadataMigration;
  }

  private canCreateNewTab(): boolean {
    const hasClaudianLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length > 0;
    const view = this.views.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      return true;
    }

    if (hasClaudianLeaf) {
      return false;
    }

    return true;
  }

  private async openNewTab(): Promise<void> {
    const existingView = this.views.getView();
    if (existingView) {
      if (await existingView.handleNewConversationCommand()) {
        return;
      }
      await existingView.createNewTab();
      return;
    }

    await this.views.activateView();
    this.views.getView()?.focusActiveInput();
  }

  private async publishCommittedSettings(settings: Readonly<ClaudianSettings>, previous: Readonly<ClaudianSettings>): Promise<void> {
    const errors: unknown[] = [];
    const publish = (refresh: () => void): void => {
      try { refresh(); } catch (error) { errors.push(error); }
    };
    const timestampsChanged = settings.showMessageTimestamps !== previous.showMessageTimestamps;
    const layoutChanged = settings.enableDualPane !== previous.enableDualPane || settings.dualPaneSide !== previous.dualPaneSide;
    const commandsChanged = JSON.stringify(settings.hiddenCommands) !== JSON.stringify(previous.hiddenCommands);
    const contextChanged = JSON.stringify(settings.customContextLimits) !== JSON.stringify(previous.customContextLimits);
    if (timestampsChanged || layoutChanged || commandsChanged || contextChanged) {
      for (const view of this.views.getAllViews()) {
        if (timestampsChanged) publish(() => view.refreshMessageTimestamps());
        if (layoutChanged) publish(() => view.refreshDualPaneLayout());
        if (commandsChanged) publish(() => view.updateHiddenCommands());
        if (contextChanged) publish(() => view.refreshModelSelector());
      }
    }
    if (settings.enableZenMode !== previous.enableZenMode) publish(() => this.zenMode.reconcile());
    if (
      settings.sessionAutoArchiveAfter !== previous.sessionAutoArchiveAfter
      && this.sessionMetadata.hasLoadedAll
    ) {
      this.archiveInactiveSessions();
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Settings view publication failed.');
  }

  private async resetDeletedConversationTabs(id: string): Promise<void> {
    const errors: unknown[] = [];
    for (const view of this.views.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      try {
        await tabManager.resetConversationTabs(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  private archiveInactiveSessions(): void {
    if (this.isUnloading) return;
    void this.inactiveSessionArchiver.run().catch(() => {
      new Notice('Failed to auto-archive inactive sessions');
    });
  }

  private async handleLinkedContentRename(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.views.getAllViews()) {
      view.handleLinkedContentRenamed(oldPath, file.path, includeDescendants);
    }
    try {
      await this.conversations.applyVaultRename(oldPath, file.path, includeDescendants);
    } finally {
      this.scheduleVaultRefresh();
    }
  }

  private async handlePinnedLinkedContentDeleted(file: TAbstractFile): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.views.getAllViews()) {
      view.handleLinkedContentDeleted(file.path, includeDescendants);
    }
    try {
      await this.conversations.applyVaultDeletion(file.path, includeDescendants);
    } finally {
      this.scheduleVaultRefresh();
    }
  }

  private scheduleVaultRefresh(): void {
    if (this.isUnloading || this.vaultRefreshTimer !== undefined) return;
    this.vaultRefreshTimer = window.setTimeout(() => {
      this.vaultRefreshTimer = undefined;
      if (!this.isUnloading) this.notifyConversationViewsChanged();
    }, 50);
  }

  private notifyConversationViewsChanged(): void {
    for (const view of this.views.getAllViews()) {
      try {
        view.notifyConversationListChanged();
      } catch {
        // UI projection failures must not roll back a committed repository mutation.
      }
    }
  }
}
