import { StartupProfiler } from './core/performance/StartupProfiler';
// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

StartupProfiler.finishModuleEvaluation();

import { isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';
import type { Editor, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, normalizePath, Notice, Plugin, TFile, TFolder } from 'obsidian';

import type {
  LocalAgentRuntimeHttpServer,
  LocalAgentRuntimeHttpServerEndpoint,
} from './app/agent-runtime';
import type {
  ClaudianCollabService,
  CollabFeatureService,
} from './app/collab';
import type {
  GitRuntimeResolution,
  GitRuntimeResolver,
} from './app/collab/git/GitRuntimeResolver';
import { CollabComposerReferenceService } from './app/CollabComposerReferenceService';
import { ConversationRepository } from './app/conversations/ConversationRepository';
import { ClaudianProviderHost } from './app/providers/ClaudianProviderHost';
import { ChatModelSelectionCoordinator } from './app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import { PinnedLinkedContentPathCoordinator } from './app/settings/PinnedLinkedContentPathCoordinator';
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
import { TabWorkspaceMigrationCoordinator } from './app/storage/TabWorkspaceMigrationCoordinator';
import type { SessionMetadataReadResult } from './core/bootstrap/SessionStorage';
import type { SharedAppStorage } from './core/bootstrap/storage';
import {
  type CollabCoordinationSnapshot,
  type CollabPublicationReview,
  type CollabRequestReview,
  parseCollabProjectsFolder,
} from './core/collab';
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
  AppTabManagerState,
  ProviderCliResolutionContext,
  ProviderId,
} from './core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID } from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
  SessionMetadata,
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
import {
  COLLAB_DETAIL_VIEW_TYPE,
  CollabDetailView,
  CollabDetailViewCoordinator,
  type CollabDetailViewPort,
} from './features/collab/detail/CollabDetailView';
import { preloadCollabDiffRenderer } from './features/collab/detail/review/CollabDiffRenderer';
import { CollabPreparedReviewCache } from './features/collab/handoff/CollabPreparedReviewCache';
import { CollabTransientSurfaceRegistry } from './features/collab/modals/CollabTransientSurfaceRegistry';
import {
  ResponsiveCollabRouter,
  type ResponsiveCollabTarget,
} from './features/collab/navigation/ResponsiveCollabRouter';
import { DeferredCollabSurfaceController } from './features/collab/sidebar/DeferredCollabSurfaceController';
import type { GitSetupResolution } from './features/collab/sidebar/GitSetupPanel';
import type { CollabSidebarSurfaceFactory } from './features/FeatureHost';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale, t } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { deleteLegacyMcpConfig } from './providers/claude/storage/LegacyMcpConfigCleanup';
import { buildCursorContext } from './utils/editor';
import { getInstallationKey } from './utils/env';
import { revealWorkspaceLeaf } from './utils/obsidianCompat';
import { getVaultPath } from './utils/path';

function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

function toGitSetupResolution(resolution: GitRuntimeResolution): GitSetupResolution {
  if (resolution.status === 'available') {
    return { status: 'available', version: resolution.runtime.version.raw };
  }
  if (resolution.status === 'incompatible') {
    return {
      missingCapabilities: resolution.missingCapabilities,
      status: 'incompatible',
    };
  }
  return { status: 'missing' };
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
  readonly executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  readonly providerHost = new ClaudianProviderHost(this);
  readonly warmExecutionPool = new WarmExecutionPool(
    () => this.settings?.maxWarmAgentProcesses ?? DEFAULT_MAX_WARM_AGENT_PROCESSES,
  );
  readonly collabSurfaceFactory: CollabSidebarSurfaceFactory = {
    create: (hostEl, leaf) => this.createCollabSurface(hostEl, leaf),
  };
  readonly collabComposerReferences = new CollabComposerReferenceService(
    () => this.getCollabFeatureService(),
    () => this.isCollabEnabled(),
  );
  private collabFoundation: ClaudianCollabService | null = null;
  private collabSettingsGitResolver: GitRuntimeResolver | null = null;
  private collabFeatureService: CollabFeatureService | null = null;
  private collabFeatureServicePromise: Promise<CollabFeatureService | null> | null = null;
  private agentRuntime: LocalAgentRuntimeHttpServer | null = null;
  private agentRuntimeStartPromise:
    Promise<LocalAgentRuntimeHttpServerEndpoint | null> | null = null;
  private collabHostRestore: Promise<void> | null = null;
  private collabHostRestoreTimer: number | null = null;
  private collabHostRestoreRetryDelayMs = 1_000;
  private collabLayoutReady = false;
  private collabLifecycleGeneration = 0;
  private collabLifecycleTail: Promise<void> = Promise.resolve();
  private readonly collabPreparedReviews = new CollabPreparedReviewCache();
  private readonly collabTransientSurfaces = new CollabTransientSurfaceRegistry();
  private collabDetailViewCoordinator: CollabDetailViewCoordinator | null = null;
  private settingsCoordinator!: SettingsCoordinator<ClaudianSettings>;
  private chatModelSelectionCoordinator!: ChatModelSelectionCoordinator;
  private pinnedLinkedContentPaths!: PinnedLinkedContentPathCoordinator;
  private conversationRepository!: ConversationRepository;
  private pendingSessionMetadataScan = false;
  private pendingEnvironmentInvalidationGenerations = new Map<ProviderId, number>();
  private blockedEnvironmentInvalidationGenerations = new Map<ProviderId, number>();
  private environmentUpdateTail: Promise<void> = Promise.resolve();
  private agentSkillResourceGeneration = 0;
  private isLoadingRemainingSessionMetadata = false;
  private hasLoadedAllSessionMetadata = false;
  private sessionMetadataLoadTimer: number | null = null;
  private remainingSessionMetadataLoad: Promise<void> | null = null;
  private providerChatOptionsChangeTail: Promise<void> = Promise.resolve();
  private isUnloading = false;
  private applicationShutdownPromise: Promise<void> | null = null;
  private tabWorkspaceMigrationCoordinator!: TabWorkspaceMigrationCoordinator;

  get executionPersistence(): ChatExecutionPersistence {
    return this.conversationRepository;
  }

  get chatModelSelection(): ChatModelSelectionCoordinator {
    return this.chatModelSelectionCoordinator;
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
      this.registerView(
        COLLAB_DETAIL_VIEW_TYPE,
        leaf => new CollabDetailView(leaf, this.createCollabDetailViewPort(), {
          openProjectFile: (projectId, filePath) => (
            this.openCollabProjectFile(projectId, filePath)
          ),
          openTicketInNewTab: (projectId, ticketId) => (
            this.getCollabDetailViewCoordinator().openInNewTab({
              kind: 'ticket',
              projectId,
              ticketId,
            })
          ),
          preparedReviews: this.collabPreparedReviews,
        }),
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
        id: 'open-collab',
        name: t('collab.commands.open'),
        checkCallback: checking => {
          if (!this.isCollabEnabled()) return false;
          if (!checking) void this.activateCollabSurface();
          return true;
        },
      });

      this.addCommand({
        id: 'create-collab-project',
        name: t('collab.commands.createProject'),
        checkCallback: checking => {
          if (!this.isCollabEnabled()) return false;
          if (!checking) void this.openCreateCollabProject();
          return true;
        },
      });

      this.addCommand({
        id: 'join-collab-project',
        name: t('collab.commands.joinProject'),
        checkCallback: checking => {
          if (!this.isCollabEnabled()) return false;
          if (!checking) void this.openJoinCollabProject();
          return true;
        },
      });

      this.addCommand({
        id: 'resume-collab-project-setup',
        name: t('collab.commands.resumeSetup'),
        checkCallback: checking => {
          if (!this.isCollabEnabled()) return false;
          if (!checking) void this.resumeFirstCollabProjectSetup();
          return true;
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
      this.initializeCollabLayoutLifecycle();
      if (this.isCollabEnabled()) void this.startAgentRuntime();
      this.scheduleRemainingSessionMetadataLoad();
    } finally {
      StartupProfiler.finishOnload();
    }
  }

  onunload(): void {
    this.isUnloading = true;
    this.collabTransientSurfaces.closeAll();
    if (this.sessionMetadataLoadTimer !== null) {
      window.clearTimeout(this.sessionMetadataLoadTimer);
      this.sessionMetadataLoadTimer = null;
    }
    if (this.collabHostRestoreTimer !== null) {
      window.clearTimeout(this.collabHostRestoreTimer);
      this.collabHostRestoreTimer = null;
    }
    StartupProfiler.freeze();
    this.applicationShutdownPromise ??= this.shutdownApplication();
    void this.applicationShutdownPromise.catch(() => undefined);
  }

  private async shutdownApplication(): Promise<void> {
    const featureConstruction = this.collabFeatureServicePromise;
    const featureClose = this.collabFeatureService?.close();
    const agentRuntimeClose = this.agentRuntime?.close().catch(() => undefined);
    await Promise.allSettled(
      this.getAllViews().map(view => view.prepareForPluginUnload()),
    );
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
    await agentRuntimeClose;
    try {
      await this.agentRuntime?.waitForWriteInvocations();
    } catch {
      // Continue cleanup if write-settlement tracking fails unexpectedly.
    }
    try {
      this.collabComposerReferences.dispose();
    } catch {
      // Continue closing the Collab foundation if feature cleanup fails.
    }
    const constructedFeature = await featureConstruction?.catch(() => null);
    await constructedFeature?.close().catch(() => undefined);
    await featureClose?.catch(() => undefined);
    await this.collabHostRestore?.catch(() => undefined);
    this.collabPreparedReviews.clear();
    try {
      await this.collabFoundation?.close();
    } catch {
      // Obsidian teardown has no error channel; Collab cleanup is best effort.
    }
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

  private async activateCollabSurface(): Promise<boolean> {
    if (!this.isCollabEnabled()) return false;
    const router = new ResponsiveCollabRouter({
      createMainTabTarget: async () => {
        const leaf = this.app.workspace.getLeaf('tab');
        if (!leaf) return null;
        await leaf.setViewState({ active: true, type: VIEW_TYPE_CLAUDIAN });
        const view = leaf.view;
        if (!isClaudianView(view)) return null;
        return {
          prepare: async () => {
            view.refreshDualPaneLayout();
          },
          reveal: () => revealWorkspaceLeaf(this.app.workspace, leaf),
          select: () => view.selectCollabSurface(),
        } satisfies ResponsiveCollabTarget;
      },
      listExistingTargets: () => this.app.workspace
        .getLeavesOfType(VIEW_TYPE_CLAUDIAN)
        .flatMap(leaf => {
          const view = leaf.view;
          return isClaudianView(view) ? [{
            reveal: () => revealWorkspaceLeaf(this.app.workspace, leaf),
            select: () => view.selectCollabSurface(),
          } satisfies ResponsiveCollabTarget] : [];
        }),
    });
    return router.open();
  }

  private createCollabSurface(
    hostEl: HTMLElement,
    leaf: WorkspaceLeaf,
  ) {
    return new DeferredCollabSurfaceController(hostEl, {
      create: async () => {
        if (!this.isCollabEnabled()) {
          throw new Error('Collab is disabled in this Vault.');
        }
        const initialGitResolution = this.resolveCollabGit(false);
        void initialGitResolution.catch(() => undefined);
        const [feature, panelModule] = await Promise.all([
          this.getCollabFeatureService(),
          import('./features/collab/sidebar/CollabPanel'),
        ]);
        if (!this.isCollabEnabled()) {
          throw new Error('Collab was disabled while loading.');
        }
        if (!feature) {
          const unavailable = hostEl.createDiv({ cls: 'claudian-collab-panel-status' });
          unavailable.setText(t('collab.notices.desktopRequired'));
          return {
            destroy: () => unavailable.remove(),
            setActive: () => undefined,
          };
        }
        return new panelModule.CollabPanel(hostEl, leaf, {
          app: this.app,
          configuredGitPath: () => this.settings.collabGitPath ?? '',
          copyText: text => navigator.clipboard.writeText(text),
          initialGitResolution,
          onOpenConflict: (project, operationId, location, requestId) => {
            void this.openCollabConflict(project.id, operationId, location, requestId);
          },
          onCreateTicket: project => {
            void this.getCollabDetailViewCoordinator().open({
              kind: 'ticket',
              projectId: project.id,
            });
          },
          onOpenRequest: (project, review, coordination, selectedPath) => {
            void this.openPreparedCollabReview(
              project.id,
              review,
              coordination,
              selectedPath,
            );
          },
          onReviewIntent: () => {
            void preloadCollabDiffRenderer().catch(() => undefined);
          },
          onOpenPublicationReview: (project, review, selectedPath) => {
            void this.openPreparedCollabPublicationReview(
              project.id,
              review,
              selectedPath,
            );
          },
          onOpenTicket: (project, ticketId) => {
            return this.getCollabDetailViewCoordinator().open({
              kind: 'ticket',
              projectId: project.id,
              ticketId,
            });
          },
          onOpenWorkingTreeReview: (project, review, selectedPath) => {
            void this.getCollabDetailViewCoordinator().open({
              baseOid: review.baseOid,
              headOid: review.headOid,
              kind: 'working-tree',
              projectId: project.id,
              selectedPath,
              snapshotId: review.snapshotId,
            });
          },
          onSaveConfiguredGitPath: path => this.saveCollabGitPath(path),
          port: feature,
          preparedReviews: this.collabPreparedReviews,
          projectSetup: feature,
          resolveGit: rescan => this.resolveCollabGit(rescan),
          ticketFocus: {
            read: () => this.readCollabTicketFocus(),
            subscribe: listener => {
              const layoutChange = this.app.workspace.on('layout-change', listener);
              const activeLeafChange = this.app.workspace.on(
                'active-leaf-change',
                listener,
              );
              return {
                dispose: () => {
                  this.app.workspace.offref(layoutChange);
                  this.app.workspace.offref(activeLeafChange);
                },
              };
            },
          },
          transientSurfaces: this.collabTransientSurfaces,
        });
      },
      errorText: t('collab.panel.loadFailed'),
      loadingText: t('collab.panel.loading'),
    });
  }

  private readCollabTicketFocus(): {
    readonly projectId: string;
    readonly ticketId: string;
  } | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const viewState = leaf?.getViewState();
    if (viewState?.type !== COLLAB_DETAIL_VIEW_TYPE) return null;
    const state = viewState.state;
    if (
      state?.kind !== 'ticket'
      || !isCollabProjectId(state.projectId)
      || !isCollabOpaqueId(state.ticketId)
    ) return null;
    return {
      projectId: state.projectId,
      ticketId: state.ticketId,
    };
  }

  private getCollabFeatureService(): Promise<CollabFeatureService | null> {
    if (!this.isCollabEnabled()) return Promise.resolve(null);
    if (this.collabFeatureService) {
      return Promise.resolve(this.collabFeatureService);
    }
    const pending = this.collabFeatureServicePromise ?? this.createCollabFeatureService();
    if (!this.collabFeatureServicePromise) {
      this.collabFeatureServicePromise = pending;
      const clearPending = () => {
        if (this.collabFeatureServicePromise === pending) {
          this.collabFeatureServicePromise = null;
        }
      };
      void pending.then(clearPending, clearPending);
    }
    return pending;
  }

  private async createCollabFeatureService(): Promise<CollabFeatureService | null> {
    const generation = this.collabLifecycleGeneration;
    const vaultRoot = getVaultPath(this.app);
    if (vaultRoot === null) return null;
    const collab = await import('./app/collab');
    if (!this.isCollabEnabled() || generation !== this.collabLifecycleGeneration) return null;
    const installationKey = getInstallationKey();
    const foundation = new collab.ClaudianCollabService({
      getConfiguredGitPath: () => this.settings.collabGitPath ?? '',
      getProjectsFolder: () => this.settings.collabProjectsFolder,
      installationKey,
      obsidianConfigDirectory: this.app.vault.configDir,
      vaultRoot,
    });
    const projectSetup = new collab.CollabProjectSetupService(foundation, {
      getProjectsFolder: () => this.settings.collabProjectsFolder,
      installationKey,
      vaultRoot,
    });
    const { feature } = collab.createCollabFeatureSubcomposition({
      foundation,
      projectSetup,
      vaultRoot,
    });
    try {
      await feature.prepareCloudBootstrapLocalRecovery();
    } catch (error) {
      await Promise.allSettled([feature.close(), foundation.close()]);
      throw error;
    }
    if (!this.isCollabEnabled() || generation !== this.collabLifecycleGeneration) {
      await feature.close();
      await foundation.close();
      return null;
    }
    this.collabFoundation = foundation;
    this.collabFeatureService = feature;
    void feature.recoverPendingCloudBootstraps().catch(() => undefined);
    return feature;
  }

  async getMainAgentDynamicSystemPromptSections(): Promise<readonly string[]> {
    if (!this.isCollabEnabled()) return [];
    const endpoint = await this.startAgentRuntime();
    if (!endpoint || !this.isCollabEnabled()) return [];
    const runtime = await import('./app/agent-runtime');
    if (!this.isCollabEnabled()) return [];
    return [runtime.buildCollabModeSystemPrompt(endpoint)];
  }

  private startAgentRuntime(): Promise<LocalAgentRuntimeHttpServerEndpoint | null> {
    if (!this.isCollabEnabled()) return Promise.resolve(null);
    if (this.agentRuntimeStartPromise) return this.agentRuntimeStartPromise;
    const pending = (async (): Promise<LocalAgentRuntimeHttpServerEndpoint | null> => {
      try {
        let runtime = this.agentRuntime;
        if (!runtime) {
          const vaultRoot = getVaultPath(this.app);
          if (vaultRoot === null) return null;
          const agentRuntime = await import('./app/agent-runtime');
          if (!this.isCollabEnabled()) return null;
          runtime = new agentRuntime.LocalAgentRuntimeHttpServer(
            new agentRuntime.AgentRuntimeGateway(
              () => this.getCollabFeatureService(),
            ),
            {
              portCandidates: agentRuntime.deriveAgentRuntimePortCandidates(vaultRoot),
            },
          );
          this.agentRuntime = runtime;
        }
        const endpoint = await runtime.start();
        if (this.isCollabEnabled()) return endpoint;
        await runtime.close();
        return null;
      } catch {
        return null;
      }
    })();
    this.agentRuntimeStartPromise = pending;
    void pending.then(endpoint => {
      if (
        endpoint === null
        && this.isCollabEnabled()
        && this.agentRuntimeStartPromise === pending
      ) {
        this.agentRuntimeStartPromise = null;
      }
    });
    return pending;
  }

  private async resolveCollabGit(rescan: boolean): Promise<GitSetupResolution> {
    const feature = await this.getCollabFeatureService();
    if (!feature || !this.collabFoundation) return { status: 'missing' };
    return toGitSetupResolution(await this.collabFoundation.resolveGitRuntime(rescan));
  }

  private async saveCollabGitPath(path: string): Promise<GitSetupResolution> {
    await this.mutateSettings(settings => {
      settings.collabGitPath = path;
    });
    return this.resolveCollabGit(true);
  }

  private async openCreateCollabProject(): Promise<void> {
    const generation = this.collabLifecycleGeneration;
    const feature = await this.getCollabFeatureService();
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (!feature) {
      new Notice(t('collab.notices.desktopRequired'));
      return;
    }
    const resolution = await this.resolveCollabGit(false);
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (resolution.status !== 'available') {
      await this.activateCollabSurface();
      if (!this.isCurrentCollabLifecycle(generation)) return;
      new Notice(t('collab.notices.createRequiresGit'));
      return;
    }
    const initialized = await feature.initialize();
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (initialized.status !== 'success') {
      new Notice(t('collab.notices.initializationFailed'));
      return;
    }
    const { CreateProjectModal } = await import(
      './features/collab/modals/project/CreateProjectModal'
    );
    if (!this.isCurrentCollabLifecycle(generation)) return;
    this.collabTransientSurfaces.open(onClosed => (
      new CreateProjectModal(this.app, feature, { onClosed })
    ));
  }

  private async openJoinCollabProject(): Promise<void> {
    const generation = this.collabLifecycleGeneration;
    const feature = await this.getCollabFeatureService();
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (!feature) {
      new Notice(t('collab.notices.desktopRequired'));
      return;
    }
    const resolution = await this.resolveCollabGit(false);
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (resolution.status !== 'available') {
      await this.activateCollabSurface();
      if (!this.isCurrentCollabLifecycle(generation)) return;
      new Notice(t('collab.notices.joinRequiresGit'));
      return;
    }
    const initialized = await feature.initialize();
    if (!this.isCurrentCollabLifecycle(generation)) return;
    if (initialized.status !== 'success') {
      new Notice(t('collab.notices.initializationFailed'));
      return;
    }
    const { JoinProjectModal } = await import(
      './features/collab/modals/project/JoinProjectModal'
    );
    if (!this.isCurrentCollabLifecycle(generation)) return;
    this.collabTransientSurfaces.open(onClosed => (
      new JoinProjectModal(this.app, feature, { onClosed })
    ));
  }

  private isCurrentCollabLifecycle(generation: number): boolean {
    return !this.isUnloading
      && this.isCollabEnabled()
      && generation === this.collabLifecycleGeneration;
  }

  private async resumeFirstCollabProjectSetup(): Promise<void> {
    const feature = await this.getCollabFeatureService();
    if (!feature) return;
    const initialized = await feature.initialize();
    if (initialized.status !== 'success') {
      await this.activateCollabSurface();
      return;
    }
    const operationIds = await feature.listPendingSetupOperationIds();
    for (const operationId of operationIds) {
      const result = await feature.resumeSetup({ operationId });
      new Notice(result.status === 'success'
        ? t('collab.notices.setupReady', { name: result.value.name })
        : t('collab.notices.setupNeedsAttention'));
      return;
    }
    new Notice(t('collab.notices.noInterruptedSetup'));
  }

  private createCollabDetailViewPort(): CollabDetailViewPort {
    return {
      isDetailAdmissionOpen: () => this.collabLayoutReady,
      acceptRequest: async (...args) => (
        (await this.requireCollabFeatureService()).acceptRequest(...args)
      ),
      addComment: async (...args) => (
        (await this.requireCollabFeatureService()).addComment(...args)
      ),
      addTicketComment: async (...args) => (
        (await this.requireCollabFeatureService()).addTicketComment(...args)
      ),
      closeTicket: async (...args) => (
        (await this.requireCollabFeatureService()).closeTicket(...args)
      ),
      confirmPublish: async (...args) => (
        (await this.requireCollabFeatureService()).confirmPublish(...args)
      ),
      createTicket: async (...args) => (
        (await this.requireCollabFeatureService()).createTicket(...args)
      ),
      listTickets: async (...args) => (
        (await this.requireCollabFeatureService()).listTickets(...args)
      ),
      prepareReview: async (...args) => (
        (await this.requireCollabFeatureService()).prepareReview(...args)
      ),
      preparePublicationReview: async (...args) => (
        (await this.requireCollabFeatureService()).preparePublicationReview(...args)
      ),
      prepareWorkingTreeReview: async (...args) => (
        (await this.requireCollabFeatureService()).prepareWorkingTreeReview(...args)
      ),
      publish: async (...args) => (
        (await this.requireCollabFeatureService()).publish(...args)
      ),
      readConflict: async (...args) => (
        (await this.requireCollabFeatureService()).readConflict(...args)
      ),
      readConflictFile: async (...args) => (
        (await this.requireCollabFeatureService()).readConflictFile(...args)
      ),
      readReviewFile: async (...args) => (
        (await this.requireCollabFeatureService()).readReviewFile(...args)
      ),
      readPublicationReviewFile: async (...args) => (
        (await this.requireCollabFeatureService()).readPublicationReviewFile(...args)
      ),
      readWorkingTreeReviewFile: async (...args) => (
        (await this.requireCollabFeatureService()).readWorkingTreeReviewFile(...args)
      ),
      readSnapshot: async (...args) => (
        (await this.requireCollabFeatureService()).readSnapshot(...args)
      ),
      readPublishDescription: async (...args) => (
        (await this.requireCollabFeatureService()).readPublishDescription(...args)
      ),
      readTicket: async (...args) => (
        (await this.requireCollabFeatureService()).readTicket(...args)
      ),
      reopenTicket: async (...args) => (
        (await this.requireCollabFeatureService()).reopenTicket(...args)
      ),
      subscribe: listener => {
        if (!this.isCollabEnabled()) return { dispose: () => undefined };
        let disposed = false;
        let subscription: { dispose(): void } | null = null;
        void this.requireCollabFeatureService().then(feature => {
          if (disposed) return;
          subscription = feature.subscribe(listener);
        }).catch(() => undefined);
        return {
          dispose: () => {
            disposed = true;
            subscription?.dispose();
          },
        };
      },
      updateRequestMetadata: async (...args) => (
        (await this.requireCollabFeatureService()).updateRequestMetadata(...args)
      ),
      updateTicketContent: async (...args) => (
        (await this.requireCollabFeatureService()).updateTicketContent(...args)
      ),
    };
  }

  private async openCollabProjectFile(projectId: string, filePath: string): Promise<void> {
    try {
      const feature = await this.requireCollabFeatureService();
      const project = feature.state.projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('Collab Project is unavailable');
      const vaultPath = normalizePath(`${project.workspacePath}/${filePath}`);
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) throw new Error('Collab Project file is unavailable');
      await this.app.workspace.getLeaf('tab').openFile(file);
    } catch {
      new Notice(t('collab.review.fileLoadFailed'));
    }
  }

  private async openCollabConflict(
    projectId: string,
    operationId: string,
    location: 'my-changes' | 'request',
    requestId?: string,
  ): Promise<void> {
    try {
      const feature = await this.requireCollabFeatureService();
      const result = await feature.readConflict(operationId);
      if (
        result.status !== 'success'
        || result.value.descriptor.projectId !== projectId
      ) {
        new Notice(t('collab.notices.conflictUnavailable'));
        return;
      }
      await this.getCollabDetailViewCoordinator().open({
        kind: 'conflict',
        location,
        operationId,
        projectId,
        ...(location === 'request' && requestId ? { requestId } : {}),
      });
    } catch {
      new Notice(t('collab.notices.conflictUnavailable'));
    }
  }

  private async openCollabRequest(projectId: string, requestId: string): Promise<void> {
    try {
      const feature = await this.requireCollabFeatureService();
      const [reviewResult, snapshotResult] = await Promise.all([
        feature.prepareReview(projectId, requestId),
        feature.readSnapshot(projectId),
      ]);
      if (reviewResult.status !== 'success' || snapshotResult.status !== 'success') {
        new Notice(t('collab.notices.reviewUnavailable'));
        return;
      }
      const review = reviewResult.value;
      await this.openPreparedCollabReview(
        projectId,
        review,
        snapshotResult.value,
        review.files[0]?.path,
      );
    } catch {
      new Notice(t('collab.notices.reviewUnavailable'));
    }
  }

  private async openPreparedCollabReview(
    projectId: string,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot,
    selectedPath?: string,
  ): Promise<void> {
    if (review.projectId !== projectId) {
      new Notice(t('collab.notices.reviewUnavailable'));
      return;
    }
    try {
      const state = {
        comparisonBaseOid: review.comparisonBaseOid,
        comparisonTargetOid: review.comparisonTargetOid,
        kind: 'request' as const,
        projectId,
        requestId: review.detail.request.id,
        reviewedHeadOid: review.detail.reviewedHeadOid,
        reviewedMainOid: review.detail.currentMainOid,
        ...(selectedPath ? { selectedPath } : {}),
      };
      await this.getCollabDetailViewCoordinator().open(
        state,
        { coordination, review },
      );
    } catch {
      new Notice(t('collab.notices.reviewUnavailable'));
    }
  }

  private async openPreparedCollabPublicationReview(
    projectId: string,
    review: CollabPublicationReview,
    selectedPath?: string,
  ): Promise<void> {
    if (review.projectId !== projectId) {
      new Notice(t('collab.notices.reviewUnavailable'));
      return;
    }
    try {
      const selected = review.files.find(file => file.path === selectedPath) ?? review.files[0];
      this.collabPreparedReviews.storePublication(review);
      await this.getCollabDetailViewCoordinator().open({
        candidateOid: review.candidateOid,
        comparisonBaseOid: review.comparisonBaseOid,
        comparisonTargetOid: review.comparisonTargetOid,
        currentMainOid: review.currentMainOid,
        kind: 'publication',
        operationId: review.operationId,
        projectId,
        ...(selected ? { selectedPath: selected.path } : {}),
      });
    } catch {
      new Notice(t('collab.notices.reviewUnavailable'));
    }
  }

  private async requireCollabFeatureService(): Promise<CollabFeatureService> {
    const feature = await this.getCollabFeatureService();
    if (!feature) throw new Error(t('collab.notices.desktopRequired'));
    return feature;
  }

  private getCollabDetailViewCoordinator(): CollabDetailViewCoordinator {
    this.collabDetailViewCoordinator ??= new CollabDetailViewCoordinator(
      this.app.workspace,
      this.collabPreparedReviews,
    );
    return this.collabDetailViewCoordinator;
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
    this.tabWorkspaceMigrationCoordinator = new TabWorkspaceMigrationCoordinator(
      sharedStorage,
      this.app.workspace,
      isClaudianView,
    );
    try {
      await deleteLegacyMcpConfig(sharedStorage.getAdapter());
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
    const didNormalizePendingSessionInvalidations = this.syncPendingSessionInvalidations();
    this.conversationRepository = new ConversationRepository({
      getSettings: () => this.settings,
      getVaultPath: () => getVaultPath(this.app),
      persistence: sharedStorage.conversationPersistence,
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
          () => this.loadSessionMetadataWithSources(),
        );
    const initialModelRecoverySources = initialMetadataScan.records.map(({ metadata }) => (
      this.createConversationMetadataShell(metadata)
    ));
    const initialEntries = initialMetadataScan.records.map(({ metadata, needsMigration, source }) => ({
      conversation: this.createConversationMetadataShell(metadata),
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
    await this.completePendingSessionInvalidations(completedInvalidationGenerations);
    this.hasLoadedAllSessionMetadata = initialMetadataScan.complete;
    this.pendingSessionMetadataScan = deferRemainingMetadata;
  }

  private async loadSessionMetadataWithSources(): Promise<{
    records: SessionMetadataReadResult[];
    complete: boolean;
    invalidMetadataCount: number;
  }> {
    const scan = await this.storage.sessions.scanMetadata();
    return {
      records: await this.resolveMetadataSources(scan.metadata),
      complete: scan.complete,
      invalidMetadataCount: scan.invalidMetadataCount,
    };
  }

  private async resolveMetadataSources(
    metadata: SessionMetadata[],
  ): Promise<SessionMetadataReadResult[]> {
    const records = await Promise.all(
      metadata.map(({ id }) => this.storage.sessions.load(id)),
    );
    return records.filter(
      (record): record is SessionMetadataReadResult => record !== null,
    );
  }

  private async applyCollabEnabled(enabled: boolean): Promise<void> {
    if (this.isUnloading) return;
    this.collabLifecycleGeneration += 1;
    if (!enabled) this.collabTransientSurfaces.closeAll();
    if (this.settings.collabEnabled !== enabled) {
      await this.mutateSettings(settings => {
        settings.collabEnabled = enabled;
      });
    }
    this.collabComposerReferences.refreshAvailability();
    for (const view of this.getAllViews()) view.refreshCollabAvailability();
    if (enabled) {
      void this.startAgentRuntime();
      this.scheduleCollabHostRestore();
      return;
    }
    this.app.workspace.detachLeavesOfType(COLLAB_DETAIL_VIEW_TYPE);
    await this.closeCollabOwners();
  }

  private async closeCollabOwners(): Promise<void> {
    if (this.collabHostRestoreTimer !== null) {
      window.clearTimeout(this.collabHostRestoreTimer);
      this.collabHostRestoreTimer = null;
    }
    const feature = this.collabFeatureService;
    const featureConstruction = this.collabFeatureServicePromise;
    const hostRestore = this.collabHostRestore;
    const featureClose = feature?.close();
    const runtimeStart = this.agentRuntimeStartPromise;
    await runtimeStart?.catch(() => null);
    const runtime = this.agentRuntime;
    await runtime?.close().catch(() => undefined);
    await runtime?.waitForWriteInvocations().catch(() => undefined);
    await hostRestore?.catch(() => undefined);
    const constructed = await featureConstruction?.catch(() => null);
    await constructed?.close().catch(() => undefined);
    await featureClose?.catch(() => undefined);
    await this.collabDetailViewCoordinator?.close().catch(() => undefined);
    this.collabDetailViewCoordinator = null;
    this.collabPreparedReviews.clear();
    await this.collabFoundation?.close().catch(() => undefined);
    this.agentRuntime = null;
    this.agentRuntimeStartPromise = null;
    this.collabFeatureService = null;
    this.collabFeatureServicePromise = null;
    this.collabFoundation = null;
    this.collabHostRestore = null;
    this.collabHostRestoreRetryDelayMs = 1_000;
  }

  private initializeCollabLayoutLifecycle(): void {
    const afterLayoutReady = (): void => {
      if (this.isUnloading) return;
      this.collabLayoutReady = true;
      this.app.workspace.detachLeavesOfType(COLLAB_DETAIL_VIEW_TYPE);
      if (this.isCollabEnabled()) this.scheduleCollabHostRestore();
    };

    if (typeof this.app.workspace.onLayoutReady === 'function') {
      this.app.workspace.onLayoutReady(afterLayoutReady);
    } else {
      afterLayoutReady();
    }
  }

  private scheduleCollabHostRestore(delayMs = 0): void {
    if (
      !this.collabLayoutReady
      || !this.isCollabEnabled()
      || this.collabHostRestore
      || this.collabHostRestoreTimer !== null
    ) return;
    this.collabHostRestoreTimer = window.setTimeout(() => {
      this.collabHostRestoreTimer = null;
      this.startCollabHostRestore();
    }, delayMs);
  }

  private startCollabHostRestore(): void {
    if (!this.isCollabEnabled() || this.collabHostRestore) return;
    let retry = false;
    const restore = (async () => {
      const feature = await this.getCollabFeatureService();
      if (!feature || !this.isCollabEnabled()) return;
      await feature.restoreLifecycle().catch(() => {
        retry = true;
      });
      if (!this.isCollabEnabled()) return;
      await feature.restoreHosts().catch(() => {
        retry = true;
      });
    })().catch(() => {
      retry = true;
    }).finally(() => {
      if (this.collabHostRestore === restore) this.collabHostRestore = null;
      if (retry && this.isCollabEnabled() && !this.isUnloading) {
        const delay = this.collabHostRestoreRetryDelayMs;
        this.collabHostRestoreRetryDelayMs = Math.min(delay * 2, 30_000);
        this.scheduleCollabHostRestore(delay);
      } else if (!retry) {
        this.collabHostRestoreRetryDelayMs = 1_000;
      }
    });
    this.collabHostRestore = restore;
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
      let didChangeConversationList = false;
      const publishBatch = (records: SessionMetadataReadResult[]): void => {
        if (this.isUnloading || records.length === 0) return;

        const recoverySources = records.map(({ metadata }) => (
          this.createConversationMetadataShell(metadata)
        ));
        const publishable = records
          .map(record => ({
            conversation: this.createConversationMetadataShell(record.metadata),
            source: record.source,
          }))
          .filter(({ conversation }) => (
            this.conversationRepository.isSelectedModelPublicationSafe(conversation)
          ));
        const shells = publishable.map(({ conversation }) => conversation);
        const publishedIds = new Set(shells.map(({ id }) => id));
        const invalidatedShells = ProviderSettingsCoordinator
          .invalidateConversationSessions(
            shells,
            Array.from(this.pendingEnvironmentInvalidationGenerations.keys()),
          );
        const invalidatedIds = new Set(
          invalidatedShells.map(({ id }) => id),
        );
        const added = publishable.flatMap(({ conversation, source }) => (
          this.conversationRepository.mergeMetadataConversations(
            [conversation],
            source === 'legacy' ? 'unscoped' : source,
          )
        ));
        this.conversationRepository.registerHistoricalModelRecoverySources(
          recoverySources.filter(({ id }) => publishedIds.has(id)),
        );
        if (added.length === 0) return;

        addedConversations.push(...added);
        invalidatedConversations.push(
          ...added.filter(({ id }) => invalidatedIds.has(id)),
        );
        didChangeConversationList = true;
      };
      const scan = await this.storage.sessions.scan({
        onBatch: publishBatch,
      });
      if (this.isUnloading) {
        return;
      }

      StartupProfiler.recordCount('session-metadata-count', scan.records.length);
      StartupProfiler.recordCount(
        'invalid-session-metadata-count',
        scan.invalidMetadataCount,
      );
      const scannedShells = scan.records
        .map(({ metadata }) => this.conversationRepository.getCachedConversation(metadata.id))
        .filter((shell): shell is Conversation => shell !== null);
      const records = await this.resolveMetadataSources(
        scan.records.map(({ metadata }) => metadata),
      );
      const resolvedIds = new Set(records.map(({ metadata }) => metadata.id));
      const unresolvedShells = scannedShells.filter(
        ({ id }) => !resolvedIds.has(id),
      );
      this.conversationRepository.discardUnresolvedMetadataShells(
        unresolvedShells,
      );
      if (unresolvedShells.length > 0) {
        didChangeConversationList = true;
      }
      publishBatch(records);
      const entries = records.map(({ metadata, needsMigration, source }) => ({
        conversation: this.createConversationMetadataShell(metadata),
        needsMigration,
        source,
      }));
      const shells = entries.map(({ conversation }) => conversation);
      const invalidatedEntries = ProviderSettingsCoordinator
        .invalidateConversationSessions(
          shells,
          Array.from(this.pendingEnvironmentInvalidationGenerations.keys()),
        );
      const invalidatedIds = new Set(
        invalidatedEntries.map(({ id }) => id),
      );
      const existingIds = new Set(
        this.conversationRepository.getAll().map(({ id }) => id),
      );
      await this.conversationRepository.adoptMetadataConversations(entries);
      this.conversationRepository.registerHistoricalModelRecoverySources(
        shells,
      );
      const adoptedConversations = shells.filter((conversation) => (
        !existingIds.has(conversation.id)
        && this.conversationRepository.getCachedConversation(conversation.id)
          === conversation
      ));
      if (adoptedConversations.length > 0) {
        addedConversations.push(...adoptedConversations);
        invalidatedConversations.push(
          ...adoptedConversations.filter(({ id }) => invalidatedIds.has(id)),
        );
        didChangeConversationList = true;
      }
      const currentAddedConversations = addedConversations.filter((conversation) => (
        this.conversationRepository.getCachedConversation(conversation.id)
          === conversation
      ));
      const currentInvalidatedConversations = invalidatedConversations.filter(
        (conversation) => (
          this.conversationRepository.getCachedConversation(conversation.id)
            === conversation
        ),
      );
      const uniqueCurrentInvalidatedConversations = currentInvalidatedConversations.filter(
        ({ id }, index, conversations) => (
          conversations.findIndex(conversation => conversation.id === id) === index
        ),
      );
      StartupProfiler.recordCount('background-session-metadata-count', currentAddedConversations.length);
      let recoveredModels: Conversation[] = [];
      if (!this.isUnloading) {
        recoveredModels = await this.conversationRepository
          .recoverMissingSelectedModels();
        StartupProfiler.recordCount(
          'recovered-session-model-count',
          recoveredModels.length,
        );
      }
      await this.conversationRepository.persistConversations(
        uniqueCurrentInvalidatedConversations,
      );
      if (
        !this.isUnloading
        && (didChangeConversationList || recoveredModels.length > 0)
      ) {
        this.notifyConversationViewsChanged();
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
      lastActivityAt: meta.lastActivityAt,
      sessionId: meta.sessionId !== undefined ? meta.sessionId : meta.id,
      selectedModel: meta.selectedModel,
      providerState: meta.providerState,
      modelRecoverySource: meta.modelRecoverySource,
      messages: [],
      linkedContentPath: meta.linkedContentPath,
      isPinned: meta.isPinned,
      isArchived: meta.isArchived,
      externalContextPaths: meta.externalContextPaths,
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

  isCollabEnabled(): boolean {
    return !this.isUnloading && this.settings?.collabEnabled === true;
  }

  async checkCollabGitInstallation(
    rescan = false,
  ): Promise<'available' | 'unavailable'> {
    if (!this.collabSettingsGitResolver) {
      const { GitRuntimeResolver } = await import(
        './app/collab/git/GitRuntimeResolver'
      );
      this.collabSettingsGitResolver = new GitRuntimeResolver();
    }
    const input = {
      configuredPath: this.settings.collabGitPath ?? '',
      pathEnvironment: process.env.PATH,
    };
    const resolution = rescan
      ? await this.collabSettingsGitResolver.rescan(input)
      : await this.collabSettingsGitResolver.resolve(input);
    return resolution.status === 'available' ? 'available' : 'unavailable';
  }

  setCollabEnabled(enabled: boolean): Promise<void> {
    const transition = this.collabLifecycleTail.then(
      () => this.applyCollabEnabled(enabled),
      () => this.applyCollabEnabled(enabled),
    );
    this.collabLifecycleTail = transition.catch(() => undefined);
    return transition;
  }

  async setCollabProjectsFolder(raw: string): Promise<
    { readonly ok: true; readonly value: string }
    | { readonly message: string; readonly ok: false }
  > {
    const parsed = parseCollabProjectsFolder(raw, {
      obsidianConfigDirectory: this.app.vault.configDir,
    });
    if (!parsed.ok) return { message: parsed.message, ok: false };
    if (this.settings.collabProjectsFolder !== parsed.value) {
      await this.mutateSettings(settings => {
        settings.collabProjectsFolder = parsed.value;
      });
    }
    return { ok: true, value: parsed.value };
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
      await this.commitProviderRuntimeSettings(
        uniqueProviderIds,
        mutation,
        {
          failureMessage: 'Provider runtime settings change recovery failed.',
          onSettingsCommitted: onApplied,
        },
      );
    });
  }

  private async commitProviderRuntimeSettings(
    providerIds: ProviderId[],
    mutation: SettingsMutation<ClaudianSettings>,
    options: {
      failureMessage: string;
      onInvalidationsPersisted?: (
        reconciliation: SettingsReconciliationResult,
      ) => void | Promise<void>;
      onSettingsCommitted?: (
        reconciliation: SettingsReconciliationResult,
      ) => void | Promise<void>;
    },
  ): Promise<SettingsReconciliationResult> {
    let reconciliation: SettingsReconciliationResult = {
      changed: false,
      environmentChangedProviderIds: [],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    };
    let invalidationGenerations = new Map<ProviderId, number>();
    let invalidationPublished = false;
    let settingsCommitted = false;
    const errors: unknown[] = [];

    try {
      await this.mutateSettings(async (settings) => {
        await mutation(settings);
        reconciliation = this.reconcileModelWithEnvironment(providerIds, false);
        invalidationGenerations = this.stagePendingSessionInvalidations(
          settings,
          reconciliation.sessionInvalidationProviderIds,
        );
      }, () => {
        this.commitPendingSessionInvalidations(invalidationGenerations);
        this.blockEnvironmentInvalidationCompletion(invalidationGenerations);
        ProviderSettingsCoordinator.invalidateConversationSessions(
          this.conversationRepository.getAll(),
          reconciliation.sessionInvalidationProviderIds,
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

    if (settingsCommitted) {
      try {
        await options.onSettingsCommitted?.(reconciliation);
      } catch (error) {
        errors.push(error);
      }
    }

    if (invalidationPublished && invalidationGenerations.size > 0) {
      let invalidationMetadataPersisted = false;
      try {
        const invalidatedProviderIds = new Set(invalidationGenerations.keys());
        const conversationsToPersist = this.conversationRepository.getAll().filter(
          conversation => invalidatedProviderIds.has(conversation.providerId),
        );
        await this.conversationRepository.persistConversations(
          conversationsToPersist.filter(
            (conversation) =>
              this.conversationRepository.getCachedConversation(conversation.id)
              === conversation,
          ),
        );
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

    if (settingsCommitted) {
      try {
        await options.onInvalidationsPersisted?.(reconciliation);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, options.failureMessage);
    }
    return reconciliation;
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
      await this.commitProviderRuntimeSettings(
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

  findEmptyConversation(): Conversation | null {
    return this.conversationRepository.findEmpty();
  }

  getConversationList(): ConversationMeta[] {
    return this.conversationRepository.list();
  }

  async ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void> {
    const missingIds = Array.from(new Set(conversationIds)).filter(
      id => !this.conversationRepository.getCachedConversation(id),
    );
    if (missingIds.length === 0) return;

    const records = (await Promise.all(
      missingIds.map(id => this.storage.sessions.load(id)),
    )).filter((record): record is SessionMetadataReadResult => record !== null);
    if (records.length === 0) return;

    const entries = records.map(({ metadata, needsMigration, source }) => ({
      conversation: this.createConversationMetadataShell(metadata),
      needsMigration,
      source,
    }));
    const shells = entries.map(({ conversation }) => conversation);
    const invalidatedIds = new Set(
      ProviderSettingsCoordinator.invalidateConversationSessions(
        shells,
        Array.from(this.pendingEnvironmentInvalidationGenerations.keys()),
      ).map(({ id }) => id),
    );
    await this.conversationRepository.adoptMetadataConversations(entries);
    this.conversationRepository.registerHistoricalModelRecoverySources(shells);
    await this.conversationRepository.persistConversations(
      Array.from(invalidatedIds)
        .map(id => this.conversationRepository.getCachedConversation(id))
        .filter((conversation): conversation is Conversation => conversation !== null),
    );
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
