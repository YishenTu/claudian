import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import { Notice, Plugin } from 'obsidian';

import type { NativeSessionArchiveSync } from './app/conversations/NativeSessionArchiveSync';
import type { SessionMetadataLoader } from './app/conversations/SessionMetadataLoader';
import { createDefaultClaudianSettings } from './app/settings/defaultSettings';
import { EnvironmentSettingsService } from './app/settings/EnvironmentSettingsService';
import { ProviderChatOptionsReconciler } from './app/settings/ProviderChatOptionsReconciler';
import { migrateSelectedModelMetadata } from './app/settings/SelectedModelMetadataMigration';
import type { SettingsCoordinator } from './app/settings/SettingsCoordinator';
import { startApplication } from './app/startup/ApplicationStartup';
import type { SharedStorageService } from './app/storage/SharedStorageService';
import { AgentSkillResources } from './composition/AgentSkillResources';
import { ClaudianChatFeatureHost, ClaudianFeatureHost } from './composition/ClaudianFeatureHosts';
import { ClaudianProviderHost } from './composition/ClaudianProviderHost';
import { ClaudianViews } from './composition/ClaudianViews';
import { ProviderExecutionLifecycleRegistry } from './core/execution';
import { resolveLoginShellPath } from './core/process/loginShellPath';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from './core/providers/types';
import { LoopbackSessionToolServer } from './core/session-tools/LoopbackSessionToolServer';
import type { ClaudianSettings } from './core/types';
import { VIEW_TYPE_CLAUDIAN } from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { ConversationLifecycle } from './features/chat/conversation/ConversationLifecycle';
import { InactiveSessionArchiver } from './features/chat/conversation/InactiveSessionArchiver';
import { SessionMessagingService } from './features/chat/session-messaging/SessionMessagingService';
import { createChatSessionRuntime } from './features/chat/sessions/createChatSessionRuntime';
import { SessionRuntimePool } from './features/chat/sessions/SessionRuntimePool';
import { createChatFocusCommand } from './features/chat/workspace/ChatFocusCommand';
import { createChatTabCommands } from './features/chat/workspace/ChatTabCommands';
import { ChatViewPublisher } from './features/chat/workspace/ChatViewPublisher';
import { registerFileMenu } from './features/chat/workspace/fileMenu';
import { VaultContentEvents } from './features/chat/workspace/VaultContentEvents';
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
  private sessionRuntimes!: SessionRuntimePool;
  private sessionMessaging!: SessionMessagingService;
  /** Live committed settings, following Obsidian's plugin convention. */
  settings!: Readonly<ClaudianSettings>;
  private settingsCoordinator!: SettingsCoordinator<ClaudianSettings>;
  private storage!: SharedStorageService;
  private sessionMetadata!: SessionMetadataLoader;
  private nativeSessionArchives!: NativeSessionArchiveSync;
  private providerChatOptions!: ProviderChatOptionsReconciler;
  private inactiveSessionArchiver!: InactiveSessionArchiver;
  private conversationLifecycle!: ConversationLifecycle;
  private vaultContentEvents!: VaultContentEvents;
  private settingsTab: ClaudianSettingTab | null = null;
  private readonly views = new ClaudianViews(
    this.app.workspace,
    () => this.settings.chatViewPlacement,
  );
  private readonly agentSkills = new AgentSkillResources(() => this.views.getAllViews());
  private readonly sessionToolEndpoint = new LoopbackSessionToolServer();
  private readonly inlineEditSessions = new InlineEditSessionOwner();
  private readonly zenMode = new ZenModeController({
    app: this.app,
    isEnabled: () => this.settings.enableZenMode,
    getPosition: () => this.settings.zenModePosition,
    savePosition: (position) => {
      // A failed write restores the committed position; the panel stays where it was dropped.
      void this.settingsCoordinator.mutate((draft) => { draft.zenModePosition = position; }).catch(() => undefined);
    },
    toggleEnabled: () => this.settingsCoordinator.mutate((draft) => { draft.enableZenMode = !draft.enableZenMode; }),
  });
  private readonly chatViews = new ChatViewPublisher({
    views: this.views,
    zenMode: this.zenMode,
    inactiveSessions: { request: () => this.inactiveSessionArchiver.request() },
    hasLoadedAllSessionMetadata: () => this.sessionMetadata.hasLoadedAll,
  });
  private readonly startupMaintenanceAbort = new AbortController();
  private isUnloading = false;
  private applicationShutdownPromise: Promise<void> | null = null;
  private modelMetadataMigration: Promise<void> | null = null;
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
      this.vaultContentEvents.register(eventRef => this.registerEvent(eventRef));

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

      for (const command of createChatTabCommands({ workspace: this.app.workspace, views: this.views })) {
        this.addCommand(command);
      }
      this.addCommand(createChatFocusCommand(
        () => this.views.getInputFocusView(this.zenMode.getActiveLeaf())?.getActiveTab()?.composer ?? null,
      ));
      this.addCommand(this.zenMode.createToggleCommand());
      this.addCommand(this.zenMode.createToggleHistoryCommand());

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
          this.sessionInputCleanup = this.storage.cleanupObsoleteSessionInputs(this.startupMaintenanceAbort.signal);
        }, 0);
      });
      // Started early so the first provider launch rarely waits for the shell.
      this.app.workspace.onLayoutReady(() => { void resolveLoginShellPath(); });
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
    this.sessionMessaging?.beginShutdown();
    this.sessionRuntimes?.beginShutdown();
    // Return any zen presentation to its view before asynchronous shutdown.
    this.zenMode.dispose();
    this.vaultContentEvents?.dispose();
    this.inactiveSessionArchiver?.dispose();
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
      executionLifecycle: this.executionLifecycleRegistry,
      deferNonRestoredSessionMetadata: true,
      isUnloading: () => this.isUnloading,
      publishCommittedSettings: async (settings, previous) => this.chatViews.publishSettings(settings, previous),
      // No chat view can hold tabs before loading completes and assigns the lifecycle.
      onConversationDeleted: conversationId => this.conversationLifecycle.resetDeletedConversationTabs(conversationId),
      onConversationListChanged: () => this.chatViews.notifyConversationListChanged(),
      onAllMetadataLoaded: () => this.inactiveSessionArchiver.request(),
      ensureProviderWorkspace: providerId => (
        ProviderWorkspaceRegistry.ensureInitialized(this.providerHost, providerId, 'history')
      ),
      getSessionArchive: providerId => this.providerHost.getSessionArchive(providerId),
    });
    const settings = domains.settings;
    this.settings = settings.getCommittedSettings();
    this.settingsCoordinator = settings;
    this.storage = domains.storage;
    this.sessionMetadata = domains.sessionMetadata;
    this.nativeSessionArchives = domains.nativeSessionArchives;

    this.providerChatOptions = new ProviderChatOptionsReconciler({
      settings,
      providers: ProviderRegistry,
      providerSettings: ProviderSettingsCoordinator,
      reconcileConversationModels: providerId => domains.conversationRepository.reconcileSelectedModels(providerId),
      onSettingsReconciled: () => this.settingsTab?.refreshModelOptions(),
      onConversationsChanged: () => this.chatViews.notifyConversationListChanged(),
      onReconciled: providerId => this.chatViews.refreshModelSelector(providerId),
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
        this.chatViews.invalidateProviderCommandCaches(providerIds);
        await Promise.all(providerIds.map(notifyProviderChatOptionsChanged));
      },
    });
    this.providerHost = new ClaudianProviderHost({
      app: this.app,
      manifest: this.manifest,
      executionLifecycleRegistry: this.executionLifecycleRegistry,
      sessionToolEndpoint: this.sessionToolEndpoint,
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
    this.sessionRuntimes = new SessionRuntimePool({
      createRuntime: identity => createChatSessionRuntime(this.chatHost, identity),
      releaseHistory: (id, canRelease) => domains.conversationRepository.releaseHistory(id, canRelease),
      onChanged: () => this.chatViews.notifyConversationListChanged(),
      onError: () => { new Notice('Session state could not be saved. It remains in memory.'); },
    });
    this.sessionMessaging = new SessionMessagingService({
      getHost: () => this.chatHost,
      getActiveConversationId: () => this.views.getInputFocusView(this.zenMode.getActiveLeaf())?.getActiveTab()?.conversationId ?? null,
      refreshModelControls: providerId => this.chatViews.refreshModelSelector(providerId),
      commitSelection: (...args) => domains.conversations.updateSelectedModelIf(...args),
    });
    this.conversationLifecycle = new ConversationLifecycle({
      conversations: domains.conversations,
      views: this.views,
      sessions: this.sessionRuntimes,
    });
    this.vaultContentEvents = new VaultContentEvents({
      sessions: this.sessionRuntimes,
      vault: this.app.vault,
      conversations: domains.conversations,
      notifyConversationListChanged: () => this.chatViews.notifyConversationListChanged(),
    });
    this.chatHost = new ClaudianChatFeatureHost({
      ...featureDomains,
      sessionRuntimes: this.sessionRuntimes,
      sessionMessaging: this.sessionMessaging,
      conversationLifecycle: this.conversationLifecycle,
      executionPersistence: domains.conversationRepository,
      chatModelSelection: domains.chatModelSelection,
      zenMode: this.zenMode,
    });
    this.inactiveSessionArchiver = new InactiveSessionArchiver(this.chatHost);
  }

  private async shutdownApplication(): Promise<void> {
    try {
      await Promise.allSettled([
        this.sessionMetadata?.dispose(),
        this.sessionInputCleanup,
        ...this.views.getAllViews().map(view => view.prepareForPluginUnload()),
      ]);
      // Admitted native archive work needs provider services that are disposed below.
      await this.sessionMessaging?.dispose();
      await this.sessionRuntimes?.dispose().catch(() => undefined);
      await this.nativeSessionArchives?.dispose();
    } finally {
      try {
        await this.executionLifecycleRegistry.dispose();
      } catch {
        // Continue releasing provider workspaces even if execution cleanup fails.
      }
      try {
        await ProviderWorkspaceRegistry.disposeInitialized();
      } catch {
        // Obsidian teardown has no error channel; workspace cleanup is best effort.
      } finally {
        await this.sessionToolEndpoint.close();
      }
    }
    await this.modelMetadataMigration;
  }
}
