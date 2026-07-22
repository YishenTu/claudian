import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import type { Editor, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin } from 'obsidian';

import { ConversationRepository } from './app/conversations/ConversationRepository';
import { ClaudianProviderHost } from './app/providers/ClaudianProviderHost';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import type {
  ConditionalSettingsMutation,
  SettingsCommit,
} from './app/settings/SettingsCoordinator';
import {
  SettingsCoordinator,
  type SettingsMutation,
  SettingsPostCommitError,
} from './app/settings/SettingsCoordinator';
import { SharedStorageService } from './app/storage/SharedStorageService';
import type { SharedAppStorage } from './core/bootstrap/storage';
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
import type { AppTabManagerState } from './core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID } from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  SessionMetadata,
} from './core/types';
import {
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import type { ChatViewPlacement, EnvironmentScope } from './core/types/settings';
import { ClaudianView } from './features/chat/ClaudianView';
import { registerFileMenu } from './features/chat/fileMenu';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { OPENCODE_PLAN_MODE_ID, OPENCODE_SAFE_MODE_ID } from './providers/opencode/modes';
import { buildCursorContext } from './utils/editor';
import { revealWorkspaceLeaf } from './utils/obsidianCompat';
import { getVaultPath } from './utils/path';

function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

function readPendingProviderSessionInvalidations(
  settings: Record<string, unknown>,
): Map<ProviderId, number> {
  const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
  const value = settings.pendingProviderSessionInvalidations;
  const pending = new Map<ProviderId, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return pending;
  }

  for (const [providerId, generation] of Object.entries(value)) {
    if (
      registeredProviderIds.has(providerId)
      && typeof generation === 'number'
      && Number.isSafeInteger(generation)
      && generation > 0
    ) {
      pending.set(providerId, generation);
    }
  }
  return pending;
}

function serializePendingProviderSessionInvalidations(
  pending: ReadonlyMap<ProviderId, number>,
): Partial<Record<string, number>> {
  return Object.fromEntries(
    Array.from(pending.entries()).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function hasSamePendingProviderSessionInvalidations(
  value: unknown,
  pending: ReadonlyMap<ProviderId, number>,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length === pending.size
    && entries.every(([providerId, generation]) => pending.get(providerId) === generation);
}

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;
  storage!: SharedAppStorage;
  readonly providerHost = new ClaudianProviderHost(this);
  private settingsCoordinator!: SettingsCoordinator<ClaudianSettings>;
  private conversationRepository!: ConversationRepository;
  private lastKnownTabManagerState: AppTabManagerState | null = null;
  private pendingSessionMetadataScan = false;
  private pendingEnvironmentInvalidationGenerations = new Map<ProviderId, number>();
  private blockedEnvironmentInvalidationGenerations = new Map<ProviderId, number>();
  private environmentUpdateTail: Promise<void> = Promise.resolve();
  private agentSkillResourceGeneration = 0;
  private isLoadingRemainingSessionMetadata = false;
  private hasLoadedAllSessionMetadata = false;
  private sessionMetadataLoadTimer: number | null = null;
  private remainingSessionMetadataLoad: Promise<void> | null = null;
  private isUnloading = false;

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
        name: 'New tab',
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
        name: 'New session (in current tab)',
        checkCallback: (checking: boolean) => {
          const view = this.getView();
          if (!view) return false;

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
    void this.persistOpenTabStates().catch(() => undefined);
    void ProviderWorkspaceRegistry.disposeInitialized();
  }

  private async persistOpenTabStates(): Promise<void> {
    for (const view of this.getAllViews()) {
      const state = view.getPersistedTabState();
      if (state) {
        await this.persistTabManagerState(state);
      }
    }
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
      return tabManager.canCreateTab();
    }

    if (hasClaudianLeaf) {
      return false;
    }

    return this.getLastKnownOpenTabCount() < this.getMaxTabsLimit();
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
      await existingView.createNewTab();
      return;
    }

    const restoredTabCount = this.getLastKnownOpenTabCount();
    const view = await this.ensureViewOpen();
    if (!view) {
      return;
    }

    // A cold-open view creates its initial tab during restore. Avoid stacking
    // an extra blank tab on top when there was no prior layout to restore.
    if (restoredTabCount === 0) {
      return;
    }

    await view.createNewTab();
  }

  async loadSettings(options: { deferNonRestoredSessionMetadata?: boolean } = {}) {
    this.hasLoadedAllSessionMetadata = false;
    this.storage = new SharedStorageService(this);
    const { claudian } = await this.storage.initialize();
    this.lastKnownTabManagerState = await this.storage.getTabManagerState();

    this.settings = {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...claudian,
    };
    this.settingsCoordinator = new SettingsCoordinator(
      this.settings,
      async (settings) => {
        ProviderSettingsCoordinator.normalizeProviderSelection(settings);
        ProviderSettingsCoordinator.persistProjectedProviderState(settings);
        await this.storage.saveClaudianSettings(settings);
      },
    );
    const didNormalizePendingSessionInvalidations = this.syncPendingSessionInvalidations();
    this.conversationRepository = new ConversationRepository({
      getSettings: () => this.settings,
      getVaultPath: () => getVaultPath(this.app),
      sessions: this.storage.sessions,
      onConversationDeleted: (conversationId) => this.resetDeletedConversationTabs(conversationId),
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
    const opencodeConfig = this.settings.providerConfigs?.opencode;
    if (
      opencodeConfig
      && typeof opencodeConfig === 'object'
      && !Array.isArray(opencodeConfig)
      && opencodeConfig.selectedMode === OPENCODE_PLAN_MODE_ID
    ) {
      opencodeConfig.selectedMode = OPENCODE_SAFE_MODE_ID;
    }

    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    const deferRemainingMetadata = options.deferNonRestoredSessionMetadata === true;
    const initialMetadataScan = await StartupProfiler.runAsync(
      deferRemainingMetadata ? 'restored-session-metadata-load' : 'session-metadata-load',
      async () => deferRemainingMetadata
        ? {
          metadata: await this.loadRestoredSessionMetadata(),
          complete: false,
          invalidMetadataCount: 0,
        }
        : this.storage.sessions.scanMetadata(),
    );
    const initialMetadata = initialMetadataScan.metadata;
    StartupProfiler.recordCount('restored-session-metadata-count', initialMetadata.length);
    StartupProfiler.recordCount('session-metadata-count', initialMetadata.length);
    StartupProfiler.recordCount(
      'invalid-session-metadata-count',
      initialMetadataScan.invalidMetadataCount,
    );
    this.conversationRepository.replaceAll(initialMetadata.map(meta => (
      this.createConversationMetadataShell(meta)
    )).sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    ));
    setLocale(this.settings.locale as Locale);

    const backfilledConversations = this.conversationRepository.backfillResponseTimestamps();

    const reconciliation = this.reconcileModelWithEnvironment();
    this.markPendingSessionInvalidations(
      this.settings,
      reconciliation.sessionInvalidationProviderIds,
    );
    const pendingInvalidatedConversations = ProviderSettingsCoordinator
      .invalidateConversationSessions(
        this.conversationRepository.getAll(),
        Array.from(this.pendingEnvironmentInvalidationGenerations.keys()),
      );
    const completedInvalidationGenerations = initialMetadataScan.complete
      ? new Map(this.pendingEnvironmentInvalidationGenerations)
      : new Map<ProviderId, number>();

    ProviderSettingsCoordinator.projectActiveProviderState(
      this.settings,
    );

    if (
      reconciliation.changed
      || didNormalizeModelVariants
      || didNormalizeProviderSelection
      || didNormalizePendingSessionInvalidations
    ) {
      await this.saveSettings();
    }

    const conversationsToSave = new Set([
      ...backfilledConversations,
      ...reconciliation.invalidatedConversations,
      ...pendingInvalidatedConversations,
    ]);
    for (const conv of conversationsToSave) {
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conv)
      );
    }
    await this.completePendingSessionInvalidations(completedInvalidationGenerations);
    this.hasLoadedAllSessionMetadata = initialMetadataScan.complete;
    this.pendingSessionMetadataScan = deferRemainingMetadata;
  }

  private async loadRestoredSessionMetadata(): Promise<SessionMetadata[]> {
    const restoredConversationIds = Array.from(new Set(
      (this.lastKnownTabManagerState?.openTabs ?? [])
        .map(({ conversationId }) => conversationId)
        .filter((conversationId): conversationId is string => conversationId !== null),
    ));
    const metadata = await Promise.all(
      restoredConversationIds.map(id => this.storage.sessions.loadMetadata(id)),
    );
    return metadata.filter((item): item is SessionMetadata => item !== null);
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
    this.isLoadingRemainingSessionMetadata = true;
    try {
      const addedConversations: Conversation[] = [];
      const invalidatedConversations: Conversation[] = [];
      const publishBatch = (metadata: SessionMetadata[]): void => {
        if (this.isUnloading || metadata.length === 0) return;

        const shells = metadata.map(meta => this.createConversationMetadataShell(meta));
        const invalidatedShells = ProviderSettingsCoordinator.invalidateConversationSessions(
          shells,
          Array.from(this.pendingEnvironmentInvalidationGenerations.keys()),
        );
        const invalidatedIds = new Set(invalidatedShells.map(({ id }) => id));
        const added = this.conversationRepository.mergeMetadataConversations(shells);
        if (added.length === 0) return;

        addedConversations.push(...added);
        invalidatedConversations.push(
          ...added.filter(conversation => invalidatedIds.has(conversation.id)),
        );
        for (const view of this.getAllViews()) {
          view.notifyConversationListChanged();
        }
      };
      const scan = await this.storage.sessions.scanMetadata({ onBatch: publishBatch });
      if (this.isUnloading) {
        return;
      }

      const allMetadata = scan.metadata;
      StartupProfiler.recordCount('session-metadata-count', allMetadata.length);
      StartupProfiler.recordCount(
        'invalid-session-metadata-count',
        scan.invalidMetadataCount,
      );
      // Custom storage implementations may not support incremental publication yet.
      publishBatch(allMetadata);
      const currentAddedConversations = addedConversations.filter((conversation) => (
        this.conversationRepository.getCachedConversation(conversation.id) === conversation
      ));
      StartupProfiler.recordCount('background-session-metadata-count', currentAddedConversations.length);
      for (const conversation of invalidatedConversations) {
        if (this.conversationRepository.getCachedConversation(conversation.id) !== conversation) {
          continue;
        }
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conversation),
        );
      }
      if (scan.complete) {
        this.hasLoadedAllSessionMetadata = true;
        if (!this.isUnloading) {
          await this.completePendingSessionInvalidations(
            this.getCompletablePendingSessionInvalidations(),
          );
        }
      }
    } finally {
      this.isLoadingRemainingSessionMetadata = false;
    }
  }

  private syncPendingSessionInvalidations(): boolean {
    const pending = readPendingProviderSessionInvalidations(this.settings);
    const changed = !hasSamePendingProviderSessionInvalidations(
      this.settings.pendingProviderSessionInvalidations,
      pending,
    );
    this.settings.pendingProviderSessionInvalidations =
      serializePendingProviderSessionInvalidations(pending);
    this.pendingEnvironmentInvalidationGenerations = pending;
    return changed;
  }

  private markPendingSessionInvalidations(
    settings: ClaudianSettings,
    providerIds: ProviderId[],
  ): Map<ProviderId, number> {
    const marked = this.stagePendingSessionInvalidations(settings, providerIds);
    this.commitPendingSessionInvalidations(marked);
    return marked;
  }

  private stagePendingSessionInvalidations(
    settings: ClaudianSettings,
    providerIds: ProviderId[],
  ): Map<ProviderId, number> {
    const pending = readPendingProviderSessionInvalidations(settings);
    const marked = new Map<ProviderId, number>();
    for (const providerId of new Set(providerIds)) {
      const previousGeneration = Math.max(
        pending.get(providerId) ?? 0,
        this.pendingEnvironmentInvalidationGenerations.get(providerId) ?? 0,
      );
      const generation = Math.max(Date.now(), previousGeneration + 1);
      pending.set(providerId, generation);
      marked.set(providerId, generation);
    }
    settings.pendingProviderSessionInvalidations =
      serializePendingProviderSessionInvalidations(pending);
    return marked;
  }

  private commitPendingSessionInvalidations(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      this.pendingEnvironmentInvalidationGenerations.set(providerId, generation);
    }
  }

  private blockEnvironmentInvalidationCompletion(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      this.blockedEnvironmentInvalidationGenerations.set(providerId, generation);
    }
  }

  private releaseEnvironmentInvalidationCompletion(
    generations: ReadonlyMap<ProviderId, number>,
  ): void {
    for (const [providerId, generation] of generations) {
      if (this.blockedEnvironmentInvalidationGenerations.get(providerId) === generation) {
        this.blockedEnvironmentInvalidationGenerations.delete(providerId);
      }
    }
  }

  private getCompletablePendingSessionInvalidations(): Map<ProviderId, number> {
    return new Map(Array.from(
      this.pendingEnvironmentInvalidationGenerations,
      ([providerId, generation]) => [providerId, generation] as const,
    ).filter(([providerId, generation]) => (
      this.blockedEnvironmentInvalidationGenerations.get(providerId) !== generation
    )));
  }

  private async completePendingSessionInvalidations(
    completedGenerations: ReadonlyMap<ProviderId, number>,
  ): Promise<void> {
    if (completedGenerations.size === 0) {
      return;
    }

    const removed = new Map<ProviderId, number>();
    try {
      await this.mutateSettingsConditionally((settings) => {
        const pending = readPendingProviderSessionInvalidations(settings);
        for (const [providerId, generation] of completedGenerations) {
          if (pending.get(providerId) === generation) {
            pending.delete(providerId);
            removed.set(providerId, generation);
          }
        }
        if (removed.size === 0) {
          return false;
        }
        settings.pendingProviderSessionInvalidations =
          serializePendingProviderSessionInvalidations(pending);
        return true;
      });
    } catch (error) {
      const pending = readPendingProviderSessionInvalidations(this.settings);
      for (const [providerId, generation] of removed) {
        if (this.pendingEnvironmentInvalidationGenerations.get(providerId) === generation) {
          pending.set(providerId, generation);
        }
      }
      this.settings.pendingProviderSessionInvalidations =
        serializePendingProviderSessionInvalidations(pending);
      throw error;
    }

    for (const [providerId, generation] of removed) {
      if (this.pendingEnvironmentInvalidationGenerations.get(providerId) === generation) {
        this.pendingEnvironmentInvalidationGenerations.delete(providerId);
      }
    }
  }

  private createConversationMetadataShell(meta: SessionMetadata): Conversation {
    return {
      id: meta.id,
      providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastResponseAt: meta.lastResponseAt,
      sessionId: meta.sessionId !== undefined ? meta.sessionId : meta.id,
      selectedModel: meta.selectedModel,
      providerState: meta.providerState,
      messages: [],
      currentNote: meta.currentNote,
      externalContextPaths: meta.externalContextPaths,
      enabledMcpServers: meta.enabledMcpServers,
      usage: meta.usage,
      titleGenerationStatus: meta.titleGenerationStatus,
      resumeAtMessageId: meta.resumeAtMessageId,
    };
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

  async mutateProviderSettingsAndRecycleRuntimes(
    providerId: ProviderId,
    mutation: SettingsMutation<ClaudianSettings>,
  ): Promise<void> {
    const transition = await ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange([providerId]);
    const errors: unknown[] = [];
    try {
      await this.quiesceEnvironmentAffectedRuntimes([providerId]);
      await this.mutateSettings(mutation, () => {
        ProviderWorkspaceRegistry.getCliResolver(providerId)?.reset();
      });
      for (const view of this.getAllViews()) {
        await view.getTabManager()?.recycleProviderRuntimes(providerId);
        view.invalidateProviderCommandCaches?.([providerId]);
        view.refreshModelSelector?.();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await transition.release();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to update ${providerId} runtime settings.`);
    }
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
    let auxiliaryTransition: Awaited<ReturnType<
      typeof ProviderWorkspaceRegistry.beginAuxiliaryServicesEnvironmentChange
    >> | null = null;
    let affectedProviderIds: ProviderId[] = [];
    let sessionInvalidationProviderIds: ProviderId[] = [];
    let invalidationGenerations = new Map<ProviderId, number>();
    let invalidationPublished = false;
    let settingsCommitted = false;
    const errors: unknown[] = [];
    try {
      if (providersToQuiesce.length > 0) {
        auxiliaryTransition = await ProviderWorkspaceRegistry
          .beginAuxiliaryServicesEnvironmentChange(providersToQuiesce);
        await this.quiesceEnvironmentAffectedRuntimes(providersToQuiesce);
      }
      await this.mutateSettings((settings) => {
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
        const reconciliation = this.reconcileModelWithEnvironment(
          affectedProviderIds,
          false,
        );
        sessionInvalidationProviderIds = reconciliation.sessionInvalidationProviderIds;
        invalidationGenerations = this.stagePendingSessionInvalidations(
          settings,
          sessionInvalidationProviderIds,
        );
      }, () => {
        this.commitPendingSessionInvalidations(invalidationGenerations);
        this.blockEnvironmentInvalidationCompletion(invalidationGenerations);
        ProviderSettingsCoordinator.invalidateConversationSessions(
          this.conversationRepository.getAll(),
          sessionInvalidationProviderIds,
        );
        invalidationPublished = true;
      });
      settingsCommitted = true;
    } catch (error) {
      if (error instanceof SettingsPostCommitError) {
        settingsCommitted = true;
        errors.push(error.cause);
      } else {
        errors.push(error);
      }
    }

    const modelCatalogDiagnostics: string[] = [];
    if (settingsCommitted && affectedProviderIds.length > 0) {
      try {
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
      } catch (error) {
        errors.push(error);
      }

      if (invalidationPublished && invalidationGenerations.size > 0) {
        let invalidationMetadataPersisted = false;
        try {
          const invalidatedProviderIds = new Set(invalidationGenerations.keys());
          const conversationsToPersist = this.conversationRepository.getAll().filter(
            conversation => invalidatedProviderIds.has(conversation.providerId),
          );
          for (const conv of conversationsToPersist) {
            if (this.conversationRepository.getCachedConversation(conv.id) !== conv) {
              continue;
            }
            await this.storage.sessions.saveMetadata(
              this.storage.sessions.toSessionMetadata(conv)
            );
          }
          invalidationMetadataPersisted = true;
        } catch (error) {
          errors.push(error);
        }
        if (invalidationMetadataPersisted) {
          this.releaseEnvironmentInvalidationCompletion(invalidationGenerations);
          if (this.hasLoadedAllSessionMetadata && !this.isUnloading) {
            try {
              await this.completePendingSessionInvalidations(invalidationGenerations);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }

      try {
        const openViews = this.getAllViews();
        let failedTabs = 0;
        for (const openView of openViews) {
          failedTabs += await this.restartEnvironmentAffectedRuntimes(
            openView,
            affectedProviderIds,
            sessionInvalidationProviderIds,
          );
          openView.invalidateProviderCommandCaches(affectedProviderIds);
          openView.refreshModelSelector();
        }
        if (failedTabs > 0) {
          new Notice(`Environment changes applied, but ${failedTabs} affected tab(s) failed to restart.`);
        }
      } catch (error) {
        errors.push(error);
      }

      const noticeText = sessionInvalidationProviderIds.length > 0
        ? 'Environment variables applied. Sessions will be rebuilt on next message.'
        : 'Environment variables applied.';
      new Notice(noticeText);
      if (modelCatalogDiagnostics.length > 0) {
        new Notice(`Model catalog refresh failed:\n${modelCatalogDiagnostics.join('\n')}`);
      }
    }

    try {
      await auxiliaryTransition?.release();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Environment change recovery failed.');
    }
  }

  private async restartEnvironmentAffectedRuntimes(
    view: ClaudianView,
    affectedProviderIds: ProviderId[],
    sessionInvalidationProviderIds: ProviderId[],
  ): Promise<number> {
    const tabManager = view.getTabManager();
    if (!tabManager) return 0;

    const affectedTabs = tabManager.getAllTabs().filter((tab) => (
      affectedProviderIds.includes(tab.providerId ?? DEFAULT_CHAT_PROVIDER_ID)
    ));
    const syncTabRuntimeState = (tab: (typeof affectedTabs)[number]): void => {
      if (!tab.service || !tab.serviceInitialized) return;

      const conversation = tab.conversationId
        ? this.getConversationSync(tab.conversationId)
        : null;
      const hasConversationContext = (conversation?.messages.length ?? 0) > 0;
      const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
        ?? (hasConversationContext
          ? conversation?.externalContextPaths ?? []
          : this.settings.persistentExternalContextPaths ?? []);

      tab.service.syncConversationState(conversation, externalContextPaths);
    };

    let failedTabs = 0;
    for (const tab of affectedTabs) {
      if (!tab.service || !tab.serviceInitialized) continue;
      try {
        syncTabRuntimeState(tab);
        const providerId = tab.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
        if (sessionInvalidationProviderIds.includes(providerId)) {
          tab.service.resetSession();
          await tab.service.ensureReady({ providerTransitionOwner: true });
        } else {
          await tab.service.ensureReady({
            allowSessionCreation: false,
            force: true,
            providerTransitionOwner: true,
          });
        }
      } catch {
        failedTabs++;
      }
    }
    return failedTabs;
  }

  private async quiesceEnvironmentAffectedRuntimes(
    affectedProviderIds: ProviderId[],
  ): Promise<void> {
    const activeTurnFinalizations: Promise<void>[] = [];
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;
      for (const tab of tabManager.getAllTabs()) {
        const providerId = tab.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
        if (!affectedProviderIds.includes(providerId)) continue;
        const inputController = tab.controllers?.inputController;
        if (inputController) {
          activeTurnFinalizations.push(inputController.cancelStreamingAndWait());
        }
      }
    }
    await Promise.all(activeTurnFinalizations);
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
  }): Promise<Conversation> {
    return this.conversationRepository.create(options);
  }

  async switchConversation(id: string): Promise<Conversation | null> {
    return this.conversationRepository.switchTo(id);
  }

  async deleteConversation(
    id: string,
    options: { deleteProviderSession?: boolean } = {},
  ): Promise<void> {
    await this.conversationRepository.delete(id, options);
  }

  private async resetDeletedConversationTabs(id: string): Promise<void> {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
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
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    await this.conversationRepository.update(id, updates);
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

  async persistTabManagerState(state: AppTabManagerState): Promise<void> {
    this.lastKnownTabManagerState = state;
    await this.storage.setTabManagerState(state);
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

  private getLastKnownOpenTabCount(): number {
    return this.lastKnownTabManagerState?.openTabs.length ?? 0;
  }

  private getMaxTabsLimit(): number {
    const maxTabs = this.settings.maxTabs ?? 3;
    return Math.max(3, Math.min(10, maxTabs));
  }

}
