import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import type { Editor, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { ItemView, MarkdownView, Notice, Plugin, TFolder } from 'obsidian';

import { ConversationRepository } from './app/conversations/ConversationRepository';
import { SessionMetadataLoader } from './app/conversations/SessionMetadataLoader';
import { ChatModelSelectionCoordinator } from './app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import { PinnedLinkedContentPathCoordinator } from './app/settings/PinnedLinkedContentPathCoordinator';
import { RuntimeSettingsCoordinator } from './app/settings/RuntimeSettingsCoordinator';
import { migrateSelectedModelMetadata } from './app/settings/SelectedModelMetadataMigration';
import type {
  ConditionalSettingsMutation,
  SettingsCommit,
} from './app/settings/SettingsCoordinator';
import {
  SettingsCoordinator,
  type SettingsMutation,
} from './app/settings/SettingsCoordinator';
import { SharedStorageService } from './app/storage/SharedStorageService';
import { TabWorkspaceMigrationCoordinator } from './app/storage/TabWorkspaceMigrationCoordinator';
import { ClaudianProviderHost } from './composition/ClaudianProviderHost';
import { isClaudianView } from './composition/claudianViews';
import type { SharedAppStorage } from './core/bootstrap/storage';
import {
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionTransitionScope,
} from './core/execution';
import {
  getEnvironmentVariablesForScope as getScopedEnvironmentVariables,
  getRuntimeEnvironmentText,
  setEnvironmentVariablesForScope,
} from './core/providers/providerEnvironment';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type {
  AppTabManagerState,
  ProviderCLIResolutionContext,
  ProviderId,
} from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
} from './core/types';
import {
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import type { ChatViewPlacement, EnvironmentScope } from './core/types/settings';
import { ClaudianView } from './features/chat/ClaudianView';
import type { ChatExecutionPersistence } from './features/chat/execution/ChatExecutionCoordinator';
import {
  DEFAULT_MAX_WARM_AGENT_PROCESSES,
  normalizeWarmExecutionLimit,
  WarmExecutionPool,
} from './features/chat/execution/WarmExecutionPool';
import { registerFileMenu } from './features/chat/fileMenu';
import { InlineEditSessionOwner } from './features/inline-edit/InlineEditSessionOwner';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { deleteLegacyMCPConfig } from './providers/claude/storage/LegacyMCPConfigCleanup';
import { buildCursorContext } from './utils/editor';
import { revealWorkspaceLeaf } from './utils/obsidianCompat';
import { getVaultPath } from './utils/path';

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;
  storage!: SharedAppStorage;
  readonly executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  private settingsTab: ClaudianSettingTab | null = null;
  readonly providerHost = new ClaudianProviderHost(this);
  readonly warmExecutionPool = new WarmExecutionPool(
    () => this.settings?.maxWarmAgentProcesses ?? DEFAULT_MAX_WARM_AGENT_PROCESSES,
  );
  private settingsCoordinator!: SettingsCoordinator<ClaudianSettings>;
  private chatModelSelectionCoordinator!: ChatModelSelectionCoordinator;
  private pinnedLinkedContentPaths!: PinnedLinkedContentPathCoordinator;
  private conversationRepository!: ConversationRepository;
  private runtimeSettings!: RuntimeSettingsCoordinator;
  private environmentUpdateTail: Promise<void> = Promise.resolve();
  private agentSkillResourceGeneration = 0;
  private sessionMetadata!: SessionMetadataLoader;
  private providerChatOptionsChangeTail: Promise<void> = Promise.resolve();
  private readonly inlineEditSessions = new InlineEditSessionOwner();
  private isUnloading = false;
  private applicationShutdownPromise: Promise<void> | null = null;
  private tabWorkspaceMigrationCoordinator!: TabWorkspaceMigrationCoordinator;

  get executionPersistence(): ChatExecutionPersistence {
    return this.conversationRepository;
  }

  get chatModelSelection(): ChatModelSelectionCoordinator {
    return this.chatModelSelectionCoordinator;
  }

  private readonly modelMetadataMigrationAbort = new AbortController();
  private modelMetadataMigration: Promise<void> | null = null;

  async onload() {
    StartupProfiler.startOnload();
    try {
      await StartupProfiler.runAsync(
        'settings-load',
        () => this.loadSettings({ deferNonRestoredSessionMetadata: true }),
      );
      // Provider workspace services are initialized lazily on first use.

      this.registerView(
        VIEW_TYPE_CLAUDIAN,
        (leaf) => new ClaudianView(leaf, this)
      );
      registerFileMenu(this);
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
        for (const view of this.getAllViews()) {
          view.handleLinkedContentCreated(file.path);
        }
        this.notifyConversationViewsChanged();
      }));

      this.addRibbonIcon('bot', 'Open Claudian', () => {
        void this.activateView();
      });

      this.addCommand({
        id: 'open-view',
        name: 'Open chat view',
        callback: () => {
          void this.activateView();
        },
      });


      this.addCommand({
        id: 'inline-edit',
        name: 'Inline edit',
        editorCallback: async (editor: Editor, ctx) => {
          const view = ctx instanceof MarkdownView
            ? ctx
            : this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view) {
            new Notice('Inline edit unavailable: could not access the active Markdown view.');
            return;
          }

          const selectedText = editor.getSelection();
          const notePath = view.file?.path || 'unknown';

          let editContext: InlineEditContext;
          if (selectedText.trim()) {
            editContext = { mode: 'selection', selectedText };
          } else {
            const cursor = editor.getCursor();
            const cursorContext = buildCursorContext(
              (line) => editor.getLine(line),
              editor.lineCount(),
              cursor.line,
              cursor.ch
            );
            editContext = { mode: 'cursor', cursorContext };
          }

          const modal = new InlineEditModal(
            this.app,
            this,
            editor,
            view,
            editContext,
            notePath,
            this.inlineEditSessions,
          );
          const result = await modal.openAndWait();

          if (result.decision === 'accept' && result.editedText !== undefined) {
            new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
          }
        },
      });

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
          const view = this.getView();
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
          const view = this.getView();
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

      this.settingsTab = new ClaudianSettingTab(this.app, this);
      this.addSettingTab(this.settingsTab);
      this.sessionMetadata.scheduleRemainingLoad();
      this.app.workspace.onLayoutReady(() => {
        if (this.isUnloading || this.modelMetadataMigration) return;
        this.modelMetadataMigration = migrateSelectedModelMetadata(
          this.providerHost, this.modelMetadataMigrationAbort.signal,
        );
      });
    } finally {
      StartupProfiler.finishOnload();
    }
  }

  onunload(): void {
    this.isUnloading = true;
    this.modelMetadataMigrationAbort.abort();
    this.inlineEditSessions.dispose();
    StartupProfiler.freeze();
    this.applicationShutdownPromise ??= this.shutdownApplication();
    void this.applicationShutdownPromise.catch(() => undefined);
  }

  private async shutdownApplication(): Promise<void> {
    await Promise.allSettled([
      this.sessionMetadata?.dispose(),
      ...this.getAllViews().map(view => view.prepareForPluginUnload()),
    ]);
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

  async activateView() {
    const { workspace } = this.app;
    const existingLeaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
    const leaf = existingLeaf
      ?? this.getLeafForPlacement(this.settings.chatViewPlacement);
    if (!leaf) return;

    let focusSuperseded = false;
    const focusIntentRef = workspace.on('active-leaf-change', (activeLeaf) => {
      if (activeLeaf && activeLeaf !== leaf) {
        focusSuperseded = true;
      }
    });

    try {
      if (!existingLeaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
      }

      await revealWorkspaceLeaf(workspace, leaf);
      if (!focusSuperseded && isClaudianView(leaf.view)) {
        leaf.view.focusActiveInput();
      }
    } finally {
      workspace.offref(focusIntentRef);
    }
  }

  private getLeafForPlacement(placement: ChatViewPlacement): WorkspaceLeaf | null {
    const { workspace } = this.app;
    switch (placement) {
      case 'main-tab':
        return workspace.getLeaf('tab');
      case 'left-sidebar':
        return workspace.getLeftLeaf(false);
      case 'right-sidebar':
        return workspace.getRightLeaf(false);
    }
  }

  private canCreateNewTab(): boolean {
    const hasClaudianLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length > 0;
    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      return true;
    }

    if (hasClaudianLeaf) {
      return false;
    }

    return true;
  }

  private async ensureViewOpen(): Promise<ClaudianView | null> {
    const existingView = this.getView();
    if (existingView) {
      return existingView;
    }

    await this.activateView();
    return this.getView();
  }

  private async openNewTab(): Promise<void> {
    const existingView = this.getView();
    if (existingView) {
      if (await existingView.handleNewConversationCommand()) {
        return;
      }
      await existingView.createNewTab();
      return;
    }

    const view = await this.ensureViewOpen();
    if (!view) {
      return;
    }

    view.focusActiveInput();
  }

  async loadSettings(options: { deferNonRestoredSessionMetadata?: boolean } = {}) {
    const sharedStorage = new SharedStorageService(this);
    this.storage = sharedStorage;
    this.tabWorkspaceMigrationCoordinator = new TabWorkspaceMigrationCoordinator(
      sharedStorage,
      this.app.workspace,
      isClaudianView,
    );
    try {
      await deleteLegacyMCPConfig(sharedStorage.getAdapter());
    } catch {
      new Notice('Failed to remove obsolete Claude configuration');
    }
    const { claudian } = await sharedStorage.initialize();
    this.settings = {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...claudian,
    };
    const normalizedWarmExecutionLimit = normalizeWarmExecutionLimit(
      this.settings.maxWarmAgentProcesses,
    );
    const didNormalizeWarmExecutionLimit =
      normalizedWarmExecutionLimit !== this.settings.maxWarmAgentProcesses;
    this.settings.maxWarmAgentProcesses = normalizedWarmExecutionLimit;
    this.settingsCoordinator = new SettingsCoordinator(
      this.settings,
      async (settings) => {
        ProviderSettingsCoordinator.normalizeProviderSelection(settings);
        ProviderSettingsCoordinator.persistProjectedProviderState(settings);
        await this.storage.saveClaudianSettings(settings);
      },
    );
    this.chatModelSelectionCoordinator = new ChatModelSelectionCoordinator(
      this.settingsCoordinator,
    );
    this.pinnedLinkedContentPaths = new PinnedLinkedContentPathCoordinator(
      this.settingsCoordinator,
    );
    this.conversationRepository = new ConversationRepository({
      getSettings: () => this.settings,
      getVaultPath: () => getVaultPath(this.app),
      persistence: sharedStorage.conversationPersistence,
      onConversationDeleted: (conversationId) => this.resetDeletedConversationTabs(conversationId),
    });
    this.runtimeSettings = new RuntimeSettingsCoordinator({
      settings: this.settingsCoordinator,
      conversations: this.conversationRepository,
      getSettings: () => this.settings,
      canCompleteInvalidations: () => this.sessionMetadata.hasLoadedAll && !this.isUnloading,
    });
    this.sessionMetadata = new SessionMetadataLoader({
      sessions: sharedStorage.sessions,
      conversations: this.conversationRepository,
      runtimeSettings: this.runtimeSettings,
      isUnloading: () => this.isUnloading,
      whenLayoutReady: (callback) => {
        if (typeof this.app.workspace.onLayoutReady === 'function') {
          this.app.workspace.onLayoutReady(callback);
        } else {
          callback();
        }
      },
      onConversationListChanged: () => this.notifyConversationViewsChanged(),
    });
    const didNormalizePendingSessionInvalidations = this.runtimeSettings.syncPendingSessionInvalidations();

    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    const deferRemainingMetadata = options.deferNonRestoredSessionMetadata === true;
    const initialMetadataScan = deferRemainingMetadata
      ? {
          records: [],
          complete: false,
          invalidMetadataCount: 0,
        }
      : await StartupProfiler.runAsync(
          'session-metadata-load',
          () => this.sessionMetadata.readInitialMetadata(),
        );
    const initialModelRecoverySources = initialMetadataScan.records.map(({ metadata }) => (
      this.sessionMetadata.createShell(metadata)
    ));
    const initialEntries = initialMetadataScan.records.map(({ metadata, needsMigration, source }) => ({
      conversation: this.sessionMetadata.createShell(metadata),
      needsMigration,
      source,
    }));
    StartupProfiler.recordCount('initial-session-metadata-count', initialEntries.length);
    StartupProfiler.recordCount('session-metadata-count', initialEntries.length);
    StartupProfiler.recordCount(
      'invalid-session-metadata-count',
      initialMetadataScan.invalidMetadataCount,
    );
    await this.conversationRepository.adoptMetadataConversations(initialEntries);
    this.conversationRepository.registerHistoricalModelRecoverySources(
      initialModelRecoverySources,
    );
    if (initialMetadataScan.complete) {
      const recoveredModels = await this.conversationRepository
        .recoverMissingSelectedModels();
      StartupProfiler.recordCount(
        'recovered-session-model-count',
        recoveredModels.length,
      );
    }
    setLocale(this.settings.locale as Locale);

    const reconciliation = this.runtimeSettings.reconcile();
    this.runtimeSettings.markPendingSessionInvalidations(
      this.settings,
      reconciliation.sessionInvalidationProviderIds,
    );
    const pendingInvalidatedConversations = this.conversationRepository.invalidateProviderSessions(
      this.runtimeSettings.getPendingProviderIds(),
    );
    const completedInvalidationGenerations = initialMetadataScan.complete
      ? new Map(this.runtimeSettings.getPendingGenerations())
      : new Map<ProviderId, number>();

    ProviderSettingsCoordinator.projectActiveProviderState(
      this.settings,
    );

    if (
      reconciliation.changed
      || didNormalizeModelVariants
      || didNormalizeProviderSelection
      || didNormalizePendingSessionInvalidations
      || didNormalizeWarmExecutionLimit
    ) {
      await this.saveSettings();
    }

    const conversationsToSave = new Set([
      ...reconciliation.invalidatedConversations,
      ...pendingInvalidatedConversations,
    ]);
    await this.conversationRepository.persistConversations(
      Array.from(conversationsToSave),
    );
    await this.runtimeSettings.completePendingSessionInvalidations(completedInvalidationGenerations);
    this.sessionMetadata.finishStartup(initialMetadataScan.complete, deferRemainingMetadata);
  }

  normalizeModelVariantSettings(): boolean {
    return ProviderSettingsCoordinator.normalizeAllModelVariants(
      this.settings,
    );
  }

  async saveSettings() {
    await this.settingsCoordinator.persistCurrent();
  }

  async mutateSettings(
    mutation: SettingsMutation<ClaudianSettings>,
    onCommitted?: SettingsCommit<ClaudianSettings>,
  ): Promise<void> {
    await this.settingsCoordinator.mutate(mutation, onCommitted);
  }

  getAgentSkillResourceGeneration(): number {
    return this.agentSkillResourceGeneration;
  }

  async notifyAgentSkillsChanged(): Promise<void> {
    const providerIds: ProviderId[] = ['codex', 'grok', 'pi', 'opencode'];
    const generation = ++this.agentSkillResourceGeneration;

    for (const view of this.getAllViews()) {
      view.invalidateProviderResources(providerIds, generation);
    }

    await ProviderWorkspaceRegistry.getIfInitialized('codex')?.commandCatalog?.refresh();
  }

  async mutateSettingsConditionally(
    mutation: ConditionalSettingsMutation<ClaudianSettings>,
  ): Promise<void> {
    await this.settingsCoordinator.mutateConditionally(mutation);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    await this.applyEnvironmentVariablesBatch([{ scope, envText }]);
  }

  async applyEnvironmentVariablesBatch(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {
    const queuedUpdates = updates.map(update => ({ ...update }));
    const apply = this.environmentUpdateTail.then(
      () => this.applyEnvironmentVariablesBatchNow(queuedUpdates),
    );
    this.environmentUpdateTail = apply.catch(() => undefined);
    await apply;
  }

  async applyProviderRuntimeSettings(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    const uniqueProviderIds = Array.from(new Set(providerIds));
    await this.runProviderExecutionTransition(uniqueProviderIds, async () => {
      await this.runtimeSettings.commit(
        uniqueProviderIds,
        mutation,
        {
          failureMessage: 'Provider runtime settings change recovery failed.',
          onSettingsCommitted: onApplied,
        },
      );
    });
  }

  private async applyEnvironmentVariablesBatchNow(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {
    const nextEnvironmentByScope = new Map<EnvironmentScope, string>();
    for (const update of updates) {
      nextEnvironmentByScope.set(update.scope, update.envText);
    }

    const changedScopes = [...nextEnvironmentByScope].flatMap(([scope, envText]) => (
      getScopedEnvironmentVariables(
        this.settings as unknown as Record<string, unknown>,
        scope,
      ) === envText
        ? []
        : [scope]
    ));
    const providersToQuiesce = this.getAffectedEnvironmentProviders(changedScopes);
    await this.runProviderExecutionTransition(providersToQuiesce, async () => {
      let affectedProviderIds: ProviderId[] = [];
      await this.runtimeSettings.commit(
        providersToQuiesce,
        (settings) => {
          const settingsBag = settings as unknown as Record<string, unknown>;
          const changedScopes: EnvironmentScope[] = [];
          for (const [scope, envText] of nextEnvironmentByScope) {
            const currentValue = getScopedEnvironmentVariables(settingsBag, scope);
            if (currentValue !== envText) {
              changedScopes.push(scope);
            }
            setEnvironmentVariablesForScope(settingsBag, scope, envText);
          }
          affectedProviderIds = this.getAffectedEnvironmentProviders(changedScopes);
          ProviderSettingsCoordinator.handleEnvironmentChange(settingsBag, affectedProviderIds);
        },
        {
          failureMessage: 'Environment change recovery failed.',
          onInvalidationsPersisted: async (reconciliation) => {
            if (affectedProviderIds.length === 0) {
              return;
            }
            for (const openView of this.getAllViews()) {
              openView.invalidateProviderCommandCaches(affectedProviderIds);
            }
            await Promise.all(
              affectedProviderIds.map(providerId => (
                this.notifyProviderChatOptionsChanged(providerId)
              )),
            );

            const noticeText = reconciliation.sessionInvalidationProviderIds.length > 0
              ? 'Environment variables applied. Sessions will be rebuilt on next message.'
              : 'Environment variables applied.';
            new Notice(noticeText);
          },
        },
      );
    });
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(
    providerId: ProviderId = ProviderRegistry.resolveSettingsProviderId(
      this.settings,
    ),
  ): string {
    return getRuntimeEnvironmentText(
      this.settings,
      providerId,
    );
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return getScopedEnvironmentVariables(
      this.settings,
      scope,
    );
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCLIResolutionContext,
  ): Promise<string | null> {
    if (context?.providerTransitionOwner !== true) {
      await ProviderWorkspaceRegistry.ensureInitialized(
        this.providerHost,
        providerId,
        'cli-resolution',
      );
    }
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
    if (!cliResolver) {
      if (context?.providerTransitionOwner === true) {
        throw new Error(
          `Provider transition owner requires initialized workspace services for "${providerId}".`,
        );
      }
      return null;
    }

    return cliResolver.resolveFromSettings(this.settings, context);
  }

  private getAffectedEnvironmentProviders(scopes: EnvironmentScope[]): ProviderId[] {
    const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
    const affectedProviderIds = new Set<ProviderId>();

    for (const scope of scopes) {
      if (scope === 'shared') {
        for (const providerId of registeredProviderIds) {
          affectedProviderIds.add(providerId);
        }
        continue;
      }

      const providerId = scope.slice('provider:'.length);
      if (registeredProviderIds.has(providerId)) {
        affectedProviderIds.add(providerId);
      }
    }

    return Array.from(affectedProviderIds);
  }

  async createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
  }): Promise<Conversation> {
    const conversation = await this.conversationRepository.create(options);
    this.notifyConversationViewsChanged();
    return conversation;
  }

  async switchConversation(id: string): Promise<Conversation | null> {
    return this.conversationRepository.switchTo(id);
  }

  async assignConversationToCurrentDevice(id: string): Promise<boolean> {
    const assigned = await this.conversationRepository.assignToCurrentDevice(id);
    if (assigned) this.notifyConversationViewsChanged();
    return assigned;
  }

  async deleteConversation(id: string): Promise<void> {
    await this.conversationRepository.delete(id);
    this.notifyConversationViewsChanged();
  }

  runProviderExecutionTransition<T>(
    providerIds: ProviderId[],
    mutation: (scope: ProviderExecutionTransitionScope) => Promise<T>,
    parentScope?: ProviderExecutionTransitionScope,
  ): Promise<T> {
    return this.executionLifecycleRegistry.runTransition(
      providerIds,
      mutation,
      parentScope,
    );
  }

  private async resetDeletedConversationTabs(id: string): Promise<void> {
    const errors: unknown[] = [];
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          try {
            tab.controllers.inputController?.cancelStreaming();
            await tab.controllers.conversationController?.createNew({ force: true });
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  async handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    return this.conversationRepository.handleMissingProviderSession(id, missingProviderSessionId);
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await this.conversationRepository.rename(id, title);
    this.notifyConversationViewsChanged();
  }

  async setConversationPinned(id: string, isPinned: boolean): Promise<void> {
    await this.conversationRepository.setPinned(id, isPinned);
    this.notifyConversationViewsChanged();
  }

  async setLinkedContentPinned(contentPath: string, isPinned: boolean): Promise<void> {
    const changed = await this.pinnedLinkedContentPaths.setPinned(contentPath, isPinned);
    if (changed) {
      this.notifyConversationViewsChanged();
    }
  }

  async setConversationArchived(id: string, isArchived: boolean): Promise<void> {
    await this.conversationRepository.setArchived(id, isArchived);
    this.notifyConversationViewsChanged();
  }

  private async handleLinkedContentRename(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.getAllViews()) {
      view.handleLinkedContentRenamed(oldPath, file.path, includeDescendants);
    }
    await this.rewriteLinkedContentPaths(oldPath, file.path, includeDescendants);
    await this.pinnedLinkedContentPaths.rewritePaths(
      oldPath,
      file.path,
      includeDescendants,
    );
    this.notifyConversationViewsChanged();
  }

  private async handlePinnedLinkedContentDeleted(file: TAbstractFile): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.getAllViews()) {
      view.handleLinkedContentDeleted(file.path, includeDescendants);
    }
    try {
      await this.pinnedLinkedContentPaths.removePaths(
        file.path,
        includeDescendants,
      );
    } finally {
      this.notifyConversationViewsChanged();
    }
  }

  async rewriteLinkedContentPaths(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): Promise<void> {
    await this.conversationRepository.rewriteLinkedContentPaths(oldPath, newPath, {
      includeDescendants,
    });
    this.notifyConversationViewsChanged();
  }

  async updateConversation(id: string, updates: ConversationMutablePatch): Promise<void> {
    await this.conversationRepository.update(id, updates);
    this.notifyConversationViewsChanged();
  }

  private notifyConversationViewsChanged(): void {
    for (const view of this.getAllViews()) {
      try {
        view.notifyConversationListChanged();
      } catch {
        // UI projection failures must not roll back a committed repository mutation.
      }
    }
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): Promise<void> {
    const reconcileAndRefresh = async (): Promise<void> => {
      let didReconcile = false;
      try {
        await this.mutateSettingsConditionally(settings => ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings));
        this.settingsTab?.refreshModelOptions();
        const changedConversations = this.conversationRepository
          ? await this.conversationRepository.reconcileSelectedModels(providerId)
          : [];
        didReconcile = true;
        if (changedConversations.length > 0) {
          this.notifyConversationViewsChanged();
        }
      } catch (error) {
        new Notice(
          error instanceof Error
            ? `Failed to reconcile ${ProviderRegistry.getProviderDisplayName(providerId)} models: ${error.message}`
            : `Failed to reconcile ${ProviderRegistry.getProviderDisplayName(providerId)} models.`,
        );
      }
      if (didReconcile) {
        for (const view of this.getAllViews()) {
          view.refreshModelSelector(providerId);
        }
      }
    };

    this.providerChatOptionsChangeTail = this.providerChatOptionsChangeTail.then(
      reconcileAndRefresh,
      reconcileAndRefresh,
    );
    return this.providerChatOptionsChangeTail;
  }

  async getConversationById(id: string): Promise<Conversation | null> {
    return this.conversationRepository.getById(id);
  }

  getCachedConversation(id: string): Conversation | null {
    return this.conversationRepository.getCachedConversation(id);
  }

  getConversationSync(id: string): Conversation | null {
    return this.conversationRepository.getSync(id);
  }

  getConversationList(): ConversationMeta[] {
    return this.conversationRepository.list();
  }

  async ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void> {
    await this.sessionMetadata.ensureLoaded(conversationIds);
  }

  registerTabWorkspaceStateDelivery(
    view: ClaudianView,
    hasViewScopedState: boolean,
  ) {
    return this.tabWorkspaceMigrationCoordinator.registerStateDelivery(
      view,
      hasViewScopedState,
    );
  }

  async claimLegacyTabManagerState(): Promise<AppTabManagerState | null> {
    return this.tabWorkspaceMigrationCoordinator.claimLegacyState();
  }

  async completeLegacyTabManagerStateMigration(): Promise<void> {
    await this.tabWorkspaceMigrationCoordinator.completeMigration();
  }

  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    const activeView = this.app.workspace.getActiveViewOfType(ItemView);
    if (isClaudianView(activeView) && leaves.some(leaf => leaf.view === activeView)) {
      return activeView;
    }
    return leaves.map(leaf => leaf.view).find(isClaudianView) ?? null;
  }

  getAllViews(): ClaudianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).filter(isClaudianView);
  }

  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

}
