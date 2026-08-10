import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import type { Editor, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin, TFolder } from 'obsidian';

import { ConversationRepository } from './app/conversations/ConversationRepository';
import {
  type ProviderSessionInvalidationStatus,
  SessionInvalidationCoordinator,
} from './app/conversations/SessionInvalidationCoordinator';
import {
  createConversationMetadataShell,
  SessionMetadataCoordinator,
} from './app/conversations/SessionMetadataCoordinator';
import { ClaudianProviderHost } from './app/providers/ClaudianProviderHost';
import { ChatModelSelectionCoordinator } from './app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import { PinnedLinkedNotePathCoordinator } from './app/settings/PinnedLinkedNotePathCoordinator';
import { ProviderRuntimeSettingsCoordinator } from './app/settings/ProviderRuntimeSettingsCoordinator';
import type {
  ConditionalSettingsMutation,
  SettingsCommit,
} from './app/settings/SettingsCoordinator';
import {
  SettingsCoordinator,
  type SettingsMutation,
} from './app/settings/SettingsCoordinator';
import { SharedStorageService } from './app/storage/SharedStorageService';
import type { SessionMetadataReadResult } from './core/bootstrap/SessionStorage';
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
import {
  ProviderSettingsCoordinator,
  type SettingsReconciliationResult,
} from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolutionContext,
  ProviderId,
} from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
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
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { buildCursorContext } from './utils/editor';
import { revealWorkspaceLeaf } from './utils/obsidianCompat';
import { getVaultPath } from './utils/path';

function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;
  storage!: SharedAppStorage;
  readonly executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  readonly providerHost = new ClaudianProviderHost(this);
  readonly warmExecutionPool = new WarmExecutionPool(
    () => this.settings?.maxWarmAgentProcesses ?? DEFAULT_MAX_WARM_AGENT_PROCESSES,
  );
  private settingsCoordinator!: SettingsCoordinator<ClaudianSettings>;
  private chatModelSelectionCoordinator!: ChatModelSelectionCoordinator;
  private pinnedLinkedNotePaths!: PinnedLinkedNotePathCoordinator;
  private conversationRepository!: ConversationRepository;
  private sessionMetadataCoordinator!: SessionMetadataCoordinator;
  private sessionInvalidationCoordinator!: SessionInvalidationCoordinator;
  private providerRuntimeSettingsCoordinator!: ProviderRuntimeSettingsCoordinator;
  private pendingSessionMetadataScan = false;
  private environmentUpdateTail: Promise<void> = Promise.resolve();
  private agentSkillResourceGeneration = 0;
  private hasLoadedAllSessionMetadata = false;
  private sessionMetadataLoadTimer: number | null = null;
  private remainingSessionMetadataLoad: Promise<void> | null = null;
  private providerChatOptionsChangeTail: Promise<void> = Promise.resolve();
  private isUnloading = false;

  get executionPersistence(): ChatExecutionPersistence {
    return this.conversationRepository;
  }

  get chatModelSelection(): ChatModelSelectionCoordinator {
    return this.chatModelSelectionCoordinator;
  }

  getProviderSessionInvalidationStatus(
    providerId: ProviderId,
  ): ProviderSessionInvalidationStatus {
    return this.sessionInvalidationCoordinator.getStatus(providerId);
  }

  isSessionMetadataLoaded(): boolean {
    return this.hasLoadedAllSessionMetadata;
  }

  /** Re-scans deferred session metadata and publishes the resulting shells. */
  async refreshSessionMetadata(): Promise<void> {
    await this.loadRemainingSessionMetadata();
  }

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
        void this.handleLinkedNoteRename(file, oldPath).catch(() => {
          new Notice('Failed to update linked session note paths');
        });
      }));
      this.registerEvent(this.app.vault.on('delete', (file) => {
        void this.handlePinnedLinkedNoteDeleted(file).catch(() => {
          new Notice('Failed to update pinned linked notes');
        });
      }));

      this.addRibbonIcon('bot', 'Open Oh My Claudian', () => {
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
            () => this.getView()?.getActiveTab()?.ui.externalContextSelector?.getExternalContexts() ?? []
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

      this.addSettingTab(new ClaudianSettingTab(this.app, this));
      this.scheduleRemainingSessionMetadataLoad();
    } finally {
      StartupProfiler.finishOnload();
    }
  }

  onunload(): void {
    this.isUnloading = true;
    if (this.sessionMetadataLoadTimer !== null) {
      window.clearTimeout(this.sessionMetadataLoadTimer);
      this.sessionMetadataLoadTimer = null;
    }
    StartupProfiler.freeze();
    void Promise.all(
      this.getAllViews().map(view => view.flushCurrentTabState()),
    ).catch(() => undefined);
    void this.executionLifecycleRegistry.dispose();
    void ProviderWorkspaceRegistry.disposeInitialized();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.getLeafForPlacement(this.settings.chatViewPlacement);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      await revealWorkspaceLeaf(workspace, leaf);
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
    this.hasLoadedAllSessionMetadata = false;
    const sharedStorage = new SharedStorageService(this);
    this.storage = sharedStorage;
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
    this.pinnedLinkedNotePaths = new PinnedLinkedNotePathCoordinator(
      this.settingsCoordinator,
    );
    this.sessionInvalidationCoordinator = new SessionInvalidationCoordinator({
      getSettings: () => this.settings,
      mutateSettingsConditionally: (mutation) => this.mutateSettingsConditionally(mutation),
    });
    const didNormalizePendingSessionInvalidations = this.sessionInvalidationCoordinator
      .sync(this.settings);
    this.conversationRepository = new ConversationRepository({
      getSettings: () => this.settings,
      getVaultPath: () => getVaultPath(this.app),
      persistence: sharedStorage.conversationPersistence,
      onConversationDeleted: (conversationId) => this.resetDeletedConversationTabs(conversationId),
    });
    this.providerRuntimeSettingsCoordinator = new ProviderRuntimeSettingsCoordinator({
      repository: this.conversationRepository,
      sessionInvalidation: this.sessionInvalidationCoordinator,
      mutateSettings: (mutation, onCommitted) => this.mutateSettings(mutation, onCommitted),
      reconcileModelWithEnvironment: (providerIds, invalidateConversations) => (
        this.reconcileModelWithEnvironment(providerIds, invalidateConversations)
      ),
      isSessionMetadataLoaded: () => this.hasLoadedAllSessionMetadata,
      isUnloading: () => this.isUnloading,
    });
    this.sessionMetadataCoordinator = new SessionMetadataCoordinator({
      sessions: this.storage.sessions,
      repository: this.conversationRepository,
      getPendingInvalidationProviderIds: () => this.sessionInvalidationCoordinator
        .getPendingProviderIds(),
      isUnloading: () => this.isUnloading,
      recoverMissingConversationModels: () => this.recoverMissingConversationModels(),
      completePendingSessionInvalidations: () => this.sessionInvalidationCoordinator.complete(
        this.sessionInvalidationCoordinator.getCompletable(),
      ),
      notifyConversationViewsChanged: () => this.notifyConversationViewsChanged(),
    });

    // Plan mode is ephemeral — normalize back to normal on load so the app
    // doesn't start stuck in plan mode after a restart (prePlanPermissionMode is lost)
    if (this.settings.permissionMode === 'plan') {
      this.settings.permissionMode = 'normal';
    }
    if (
      this.settings.savedProviderPermissionMode
      && typeof this.settings.savedProviderPermissionMode === 'object'
      && !Array.isArray(this.settings.savedProviderPermissionMode)
    ) {
      for (const [providerId, mode] of Object.entries(this.settings.savedProviderPermissionMode)) {
        if (mode === 'plan') {
          this.settings.savedProviderPermissionMode[providerId] = 'normal';
        }
      }
    }
    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    const deferRemainingMetadata = options.deferNonRestoredSessionMetadata === true;
    const initialMetadataScan = await StartupProfiler.runAsync(
      deferRemainingMetadata ? 'deferred-session-metadata-load' : 'session-metadata-load',
      async () => deferRemainingMetadata
        ? {
            records: await this.loadCurrentTabSessionMetadata(),
            complete: false,
            invalidMetadataCount: 0,
          }
        : this.sessionMetadataCoordinator.loadSessionMetadataWithSources(),
    );
    const initialModelRecoverySources = initialMetadataScan.records.map(({ metadata }) => (
      createConversationMetadataShell(metadata)
    ));
    const initialEntries = initialMetadataScan.records.map(({ metadata, needsMigration, source }) => ({
      conversation: createConversationMetadataShell(metadata),
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
      const recoveredModels = await this.recoverMissingConversationModels();
      StartupProfiler.recordCount(
        'recovered-session-model-count',
        recoveredModels.length,
      );
    }
    setLocale(this.settings.locale as Locale);

    const reconciliation = this.reconcileModelWithEnvironment();
    const initialInvalidationGenerations = this.sessionInvalidationCoordinator.stage(
      this.settings,
      reconciliation.sessionInvalidationProviderIds,
    );
    this.sessionInvalidationCoordinator.commit(initialInvalidationGenerations);
    const pendingInvalidatedConversations = ProviderSettingsCoordinator
      .invalidateConversationSessions(
        this.conversationRepository.getAll(),
        this.sessionInvalidationCoordinator.getPendingProviderIds(),
      );
    const completedInvalidationGenerations = initialMetadataScan.complete
      ? this.sessionInvalidationCoordinator.getPendingGenerations()
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
    await this.sessionInvalidationCoordinator.complete(completedInvalidationGenerations);
    this.hasLoadedAllSessionMetadata = initialMetadataScan.complete;
    this.pendingSessionMetadataScan = deferRemainingMetadata;
  }

  private async loadCurrentTabSessionMetadata(): Promise<SessionMetadataReadResult[]> {
    const state = await this.storage.getTabManagerState();
    const currentTab = state?.openTabs.find(tab => tab.tabId === state.activeTabId);
    if (!currentTab?.conversationId) return [];

    const record = await this.storage.sessions.load(currentTab.conversationId);
    return record ? [record] : [];
  }

  private scheduleRemainingSessionMetadataLoad(): void {
    if (!this.pendingSessionMetadataScan || this.isUnloading) {
      return;
    }

    const schedule = (): void => {
      if (!this.pendingSessionMetadataScan || this.isUnloading) {
        return;
      }
      this.sessionMetadataLoadTimer = window.setTimeout(() => {
        this.sessionMetadataLoadTimer = null;
        this.startRemainingSessionMetadataLoad();
      }, 0);
    };

    if (typeof this.app.workspace.onLayoutReady === 'function') {
      this.app.workspace.onLayoutReady(schedule);
    } else {
      schedule();
    }
  }

  private startRemainingSessionMetadataLoad(): void {
    if (
      !this.pendingSessionMetadataScan
      || this.isUnloading
      || this.remainingSessionMetadataLoad
    ) {
      return;
    }

    this.pendingSessionMetadataScan = false;
    const load = StartupProfiler.runAsync(
      'session-metadata-background-load',
      () => this.loadRemainingSessionMetadata(),
    ).catch(() => {
      StartupProfiler.increment('session-metadata-background-failures');
    }).finally(() => {
      if (this.remainingSessionMetadataLoad === load) {
        this.remainingSessionMetadataLoad = null;
      }
    });
    this.remainingSessionMetadataLoad = load;
  }

  private async loadRemainingSessionMetadata(): Promise<void> {
    this.hasLoadedAllSessionMetadata = await this.sessionMetadataCoordinator
      .loadRemainingSessionMetadata();
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
      await this.providerRuntimeSettingsCoordinator.commit(
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
      const modelCatalogDiagnostics: string[] = [];
      await this.providerRuntimeSettingsCoordinator.commit(
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
          onSettingsCommitted: async () => {
            if (affectedProviderIds.length === 0) {
              return;
            }
            for (const providerId of affectedProviderIds) {
              if (ProviderRegistry.isEnabled(providerId, this.settings)) {
                const transitionOwner = { providerTransitionOwner: true } as const;
                const result = await ProviderWorkspaceRegistry.refreshModelCatalog(
                  providerId,
                  transitionOwner,
                );
                if (result.diagnostics) {
                  modelCatalogDiagnostics.push(
                    `${ProviderRegistry.getProviderDisplayName(providerId)}: ${result.diagnostics}`,
                  );
                }
                await ProviderWorkspaceRegistry.refreshAgentMentions(
                  providerId,
                  transitionOwner,
                );
              }
            }
          },
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
            if (modelCatalogDiagnostics.length > 0) {
              new Notice(`Model catalog refresh failed:\n${modelCatalogDiagnostics.join('\n')}`);
            }
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
    context?: ProviderCliResolutionContext,
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

  private reconcileModelWithEnvironment(
    providerIds: ProviderId[] = ProviderRegistry.getRegisteredProviderIds(),
    invalidateConversations = true,
  ): SettingsReconciliationResult {
    return ProviderSettingsCoordinator.reconcileProviders(
      this.settings,
      this.conversationRepository.getAll(),
      providerIds,
      { invalidateConversations },
    );
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
    currentNote?: string;
  }): Promise<Conversation> {
    const conversation = await this.conversationRepository.create(options);
    this.notifyConversationViewsChanged();
    return conversation;
  }

  async switchConversation(id: string): Promise<Conversation | null> {
    return this.conversationRepository.switchTo(id);
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

  async setLinkedNotePinned(notePath: string, isPinned: boolean): Promise<void> {
    const changed = await this.pinnedLinkedNotePaths.setPinned(notePath, isPinned);
    if (changed) {
      this.notifyConversationViewsChanged();
    }
  }

  async setConversationArchived(id: string, isArchived: boolean): Promise<void> {
    await this.conversationRepository.setArchived(id, isArchived);
    this.notifyConversationViewsChanged();
  }

  private async handleLinkedNoteRename(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    await this.conversationRepository.rewriteCurrentNotePaths(oldPath, file.path, {
      includeDescendants: file instanceof TFolder,
    });
    await this.pinnedLinkedNotePaths.rewritePaths(
      oldPath,
      file.path,
      file instanceof TFolder,
    );
    this.notifyConversationViewsChanged();
  }

  private async handlePinnedLinkedNoteDeleted(file: TAbstractFile): Promise<void> {
    const removed = await this.pinnedLinkedNotePaths.removePaths(
      file.path,
      file instanceof TFolder,
    );
    if (removed) {
      this.notifyConversationViewsChanged();
    }
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    await this.conversationRepository.update(id, updates);
    this.notifyConversationViewsChanged();
  }

  async reconcileConversationModels(providerId: ProviderId): Promise<Conversation[]> {
    return this.conversationRepository
      ? this.conversationRepository.reconcileSelectedModels(providerId)
      : [];
  }

  async recoverMissingConversationModels(): Promise<Conversation[]> {
    return this.conversationRepository
      ? this.conversationRepository.recoverMissingSelectedModels()
      : [];
  }

  private notifyConversationViewsChanged(): void {
    for (const view of this.getAllViews()) {
      view.notifyConversationListChanged();
    }
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): Promise<void> {
    const reconcileAndRefresh = async (): Promise<void> => {
      let didReconcile = false;
      try {
        const changedConversations = await this.reconcileConversationModels(providerId);
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

  findEmptyConversation(): Conversation | null {
    return this.conversationRepository.findEmpty();
  }

  getConversationList(): ConversationMeta[] {
    return this.conversationRepository.list();
  }

  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
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
