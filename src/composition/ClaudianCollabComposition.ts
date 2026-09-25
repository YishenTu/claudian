import { isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { normalizePath, Notice, TFile } from 'obsidian';

import type {
  LocalAgentRuntimeHTTPServer,
  LocalAgentRuntimeHTTPServerEndpoint,
} from '@/app/agent-runtime';
import type {
  ClaudianCollabService,
  CollabFeatureService,
} from '@/app/collab';
import type {
  GitRuntimeResolution,
  GitRuntimeResolver,
} from '@/app/collab/git/GitRuntimeResolver';
import { CollabComposerReferenceService } from '@/app/CollabComposerReferenceService';
import type { SettingsMutation } from '@/app/settings/SettingsCoordinator';
import {
  type CollabCoordinationSnapshot,
  type CollabPublicationReview,
  type CollabRequestReview,
  parseCollabProjectsFolder,
} from '@/core/collab';
import type { ClaudianSettings } from '@/core/types';
import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ClaudianView } from '@/features/chat/ClaudianView';
import {
  COLLAB_DETAIL_VIEW_TYPE,
  CollabDetailView,
  CollabDetailViewCoordinator,
  type CollabDetailViewPort,
} from '@/features/collab/detail/CollabDetailView';
import { preloadCollabDiffRenderer } from '@/features/collab/detail/review/CollabDiffRenderer';
import { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';
import { CollabTransientSurfaceRegistry } from '@/features/collab/modals/CollabTransientSurfaceRegistry';
import {
  ResponsiveCollabRouter,
  type ResponsiveCollabTarget,
} from '@/features/collab/navigation/ResponsiveCollabRouter';
import { DeferredCollabSurfaceController } from '@/features/collab/sidebar/DeferredCollabSurfaceController';
import type { GitSetupResolution } from '@/features/collab/sidebar/GitSetupPanel';
import type { CollabSidebarSurfaceFactory } from '@/features/FeatureHost';
import { t } from '@/i18n/i18n';
import { getInstallationKey } from '@/utils/env';
import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';
import { getVaultPath } from '@/utils/path';

import { isClaudianView } from './claudianViews';

/** Plugin capabilities the Collab composition needs from the composition root. */
export interface ClaudianCollabCompositionHost {
  readonly app: App;
  getSettings(): ClaudianSettings;
  isUnloading(): boolean;
  mutateSettings(mutation: SettingsMutation<ClaudianSettings>): Promise<void>;
  getAllViews(): readonly ClaudianView[];
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

/**
 * Owns Collab enablement, lazy construction, Host restoration, the Agent Runtime and
 * Collab navigation for the plugin. `main.ts` constructs it once and publishes its
 * surfaces; the Collab application layer stays behind dynamic imports.
 */
export class ClaudianCollabComposition {
  readonly surfaceFactory: CollabSidebarSurfaceFactory = {
    create: (hostEl, leaf) => this.createCollabSurface(hostEl, leaf),
  };
  readonly composerReferences = new CollabComposerReferenceService(
    () => this.getCollabFeatureService(),
    () => this.isCollabEnabled(),
  );
  private collabFoundation: ClaudianCollabService | null = null;
  private collabSettingsGitResolver: GitRuntimeResolver | null = null;
  private collabFeatureService: CollabFeatureService | null = null;
  private collabFeatureServicePromise: Promise<CollabFeatureService | null> | null = null;
  private agentRuntime: LocalAgentRuntimeHTTPServer | null = null;
  private agentRuntimeStartPromise:
    Promise<LocalAgentRuntimeHTTPServerEndpoint | null> | null = null;
  private collabHostRestore: Promise<void> | null = null;
  private collabHostRestoreTimer: number | null = null;
  private collabHostRestoreRetryDelayMs = 1_000;
  private collabLayoutReady = false;
  private collabLifecycleGeneration = 0;
  private collabLifecycleTail: Promise<void> = Promise.resolve();
  private readonly collabPreparedReviews = new CollabPreparedReviewCache();
  private readonly collabTransientSurfaces = new CollabTransientSurfaceRegistry();
  private collabDetailViewCoordinator: CollabDetailViewCoordinator | null = null;

  constructor(private readonly host: ClaudianCollabCompositionHost) {}

  private get app(): App {
    return this.host.app;
  }

  private get settings(): ClaudianSettings {
    return this.host.getSettings();
  }

  registerDetailView(plugin: Plugin): void {
    plugin.registerView(
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
  }

  registerCommands(plugin: Plugin): void {
    plugin.addCommand({
      id: 'open-collab',
      name: t('collab.commands.open'),
      checkCallback: checking => {
        if (!this.isCollabEnabled()) return false;
        if (!checking) void this.activateCollabSurface();
        return true;
      },
    });

    plugin.addCommand({
      id: 'create-collab-project',
      name: t('collab.commands.createProject'),
      checkCallback: checking => {
        if (!this.isCollabEnabled()) return false;
        if (!checking) void this.openCreateCollabProject();
        return true;
      },
    });

    plugin.addCommand({
      id: 'join-collab-project',
      name: t('collab.commands.joinProject'),
      checkCallback: checking => {
        if (!this.isCollabEnabled()) return false;
        if (!checking) void this.openJoinCollabProject();
        return true;
      },
    });

    plugin.addCommand({
      id: 'resume-collab-project-setup',
      name: t('collab.commands.resumeSetup'),
      checkCallback: checking => {
        if (!this.isCollabEnabled()) return false;
        if (!checking) void this.resumeFirstCollabProjectSetup();
        return true;
      },
    });
  }

  /** Called from onload after the rest of the plugin is registered. */
  start(): void {
    this.initializeCollabLayoutLifecycle();
    if (this.isCollabEnabled()) void this.startAgentRuntime();
  }

  /** Synchronous part of plugin unload: closes transient UI and cancels a pending restore. */
  beginUnload(): void {
    this.collabTransientSurfaces.closeAll();
    if (this.collabHostRestoreTimer !== null) {
      window.clearTimeout(this.collabHostRestoreTimer);
      this.collabHostRestoreTimer = null;
    }
  }

  /**
   * Starts closing detail views, the feature service and the Agent Runtime immediately.
   * The returned function settles the remaining Collab owners once chat views and
   * provider resources have drained.
   */
  beginShutdown(): () => Promise<void> {
    const detailClose = this.getCollabDetailViewCoordinator().close();
    const featureConstruction = this.collabFeatureServicePromise;
    const featureClose = this.collabFeatureService?.close();
    const agentRuntimeClose = this.agentRuntime?.close().catch(() => undefined);
    return async () => {
      await detailClose?.catch(() => undefined);
      await agentRuntimeClose;
      try {
        await this.agentRuntime?.waitForWriteInvocations();
      } catch {
        // Continue cleanup if write-settlement tracking fails unexpectedly.
      }
      try {
        this.composerReferences.dispose();
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
    };
  }

  isCollabEnabled(): boolean {
    return !this.host.isUnloading() && this.host.getSettings()?.collabEnabled === true;
  }

  async getMainAgentDynamicSystemPromptSections(): Promise<readonly string[]> {
    if (!this.isCollabEnabled()) return [];
    const endpoint = await this.startAgentRuntime();
    if (!endpoint || !this.isCollabEnabled()) return [];
    const runtime = await import('../app/agent-runtime');
    if (!this.isCollabEnabled()) return [];
    return [runtime.buildCollabModeSystemPrompt(endpoint)];
  }

  async checkCollabGitInstallation(
    rescan = false,
  ): Promise<'available' | 'unavailable'> {
    if (!this.collabSettingsGitResolver) {
      const { GitRuntimeResolver } = await import(
        '../app/collab/git/GitRuntimeResolver'
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
      await this.host.mutateSettings(settings => {
        settings.collabProjectsFolder = parsed.value;
      });
    }
    return { ok: true, value: parsed.value };
  }

  async handleCollabFolderRename(oldPath: string, newPath: string): Promise<void> {
    if (!this.collabLayoutReady || !this.isCollabEnabled()) return;
    const generation = this.collabLifecycleGeneration;
    try {
      const feature = await this.getCollabFeatureService();
      if (!feature || !this.isCollabEnabled() || generation !== this.collabLifecycleGeneration) return;
      const result = await feature.reconcileWorkingCopyLocations({ oldPath, newPath });
      if (result.status !== 'success') throw new Error('Collab folder reconciliation failed');
    } catch {
      if (this.isCollabEnabled() && generation === this.collabLifecycleGeneration) {
        new Notice(t('collab.panel.projectFolderRenameFailed'));
      }
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
          import('../features/collab/sidebar/CollabPanel'),
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
    const collab = await import('../app/collab');
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
      getProjectsFolder: () => this.settings.collabProjectsFolder,
      projectSetup,
      vaultRoot,
    });
    if (!this.isCollabEnabled() || generation !== this.collabLifecycleGeneration) {
      await feature.close();
      await foundation.close();
      return null;
    }
    this.collabFoundation = foundation;
    this.collabFeatureService = feature;
    return feature;
  }

  private startAgentRuntime(): Promise<LocalAgentRuntimeHTTPServerEndpoint | null> {
    if (!this.isCollabEnabled()) return Promise.resolve(null);
    if (this.agentRuntimeStartPromise) return this.agentRuntimeStartPromise;
    const pending = (async (): Promise<LocalAgentRuntimeHTTPServerEndpoint | null> => {
      try {
        let runtime = this.agentRuntime;
        if (!runtime) {
          const vaultRoot = getVaultPath(this.app);
          if (vaultRoot === null) return null;
          const agentRuntime = await import('../app/agent-runtime');
          if (!this.isCollabEnabled()) return null;
          runtime = new agentRuntime.LocalAgentRuntimeHTTPServer(
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
    await this.host.mutateSettings(settings => {
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
      '../features/collab/modals/project/CreateProjectModal'
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
      '../features/collab/modals/project/JoinProjectModal'
    );
    if (!this.isCurrentCollabLifecycle(generation)) return;
    this.collabTransientSurfaces.open(onClosed => (
      new JoinProjectModal(this.app, feature, { onClosed })
    ));
  }

  private isCurrentCollabLifecycle(generation: number): boolean {
    return !this.host.isUnloading()
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
      isDetailAdmissionOpen: () => this.collabLayoutReady && this.isCollabEnabled(),
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
      confirmUpdate: async (...args) => (
        (await this.requireCollabFeatureService()).confirmUpdate(...args)
      ),
      confirmPublish: async (...args) => (
        (await this.requireCollabFeatureService()).confirmPublish(...args)
      ),
      createTicket: async (...args) => (
        (await this.requireCollabFeatureService()).createTicket(...args)
      ),
      resolveTicketNumber: async (...args) => (
        (await this.requireCollabFeatureService()).resolveTicketNumber(...args)
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
      observeProject: (projectId, listener) => {
        if (!this.isCollabEnabled()) return { dispose: () => undefined };
        let disposed = false;
        let subscription: { dispose(): void } | null = null;
        void this.requireCollabFeatureService().then(feature => {
          if (disposed) return;
          subscription = feature.observeProject(projectId, listener);
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
    const generation = this.collabLifecycleGeneration;
    try {
      const feature = await this.requireCollabFeatureService();
      if (!this.isCurrentCollabLifecycle(generation)) return;
      const project = feature.state.projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('Collab Project is unavailable');
      const vaultPath = normalizePath(`${project.workspacePath}/${filePath}`);
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) throw new Error('Collab Project file is unavailable');
      await this.app.workspace.getLeaf('tab').openFile(file);
    } catch {
      if (!this.isCurrentCollabLifecycle(generation)) return;
      new Notice(t('collab.review.fileLoadFailed'));
    }
  }

  private async openCollabConflict(
    projectId: string,
    operationId: string,
    location: 'my-changes' | 'request' | 'update',
    requestId?: string,
  ): Promise<void> {
    const generation = this.collabLifecycleGeneration;
    try {
      const feature = await this.requireCollabFeatureService();
      if (!this.isCurrentCollabLifecycle(generation)) return;
      const result = await feature.readConflict(operationId);
      if (!this.isCurrentCollabLifecycle(generation)) return;
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
      if (!this.isCurrentCollabLifecycle(generation)) return;
      new Notice(t('collab.notices.conflictUnavailable'));
    }
  }

  private async openPreparedCollabReview(
    projectId: string,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot,
    selectedPath?: string,
  ): Promise<void> {
    if (!this.isCollabEnabled()) return;
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
    if (!this.isCollabEnabled()) return;
    if (review.projectId !== projectId) {
      new Notice(t('collab.notices.reviewUnavailable'));
      return;
    }
    try {
      const selected = review.files.find(file => file.path === selectedPath) ?? review.files[0];
      this.collabPreparedReviews.storePublication(review);
      await this.getCollabDetailViewCoordinator().open({
        ...(review.intent ? { intent: review.intent } : {}),
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
    if (!this.collabDetailViewCoordinator) {
      const generation = this.collabLifecycleGeneration;
      this.collabDetailViewCoordinator = new CollabDetailViewCoordinator(
        this.app.workspace,
        this.collabPreparedReviews,
        () => this.isCurrentCollabLifecycle(generation),
      );
    }
    return this.collabDetailViewCoordinator;
  }

  private async applyCollabEnabled(enabled: boolean): Promise<void> {
    if (this.host.isUnloading() || this.settings.collabEnabled === enabled) return;
    await this.host.mutateSettings(settings => {
      settings.collabEnabled = enabled;
    });
    this.collabLifecycleGeneration += 1;
    if (this.host.isUnloading()) return;
    if (!enabled) this.collabTransientSurfaces.closeAll();
    this.composerReferences.refreshAvailability();
    for (const view of this.host.getAllViews()) view.refreshCollabAvailability();
    if (enabled) {
      void this.startAgentRuntime();
      this.scheduleCollabHostRestore();
      return;
    }
    this.app.workspace.detachLeavesOfType(COLLAB_DETAIL_VIEW_TYPE);
    await this.closeCollabOwners();
  }

  private async closeCollabOwners(): Promise<void> {
    const detailClose = this.collabDetailViewCoordinator?.close();
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
    await detailClose?.catch(() => undefined);
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
      if (this.host.isUnloading()) return;
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
      if (retry && this.isCollabEnabled() && !this.host.isUnloading()) {
        const delay = this.collabHostRestoreRetryDelayMs;
        this.collabHostRestoreRetryDelayMs = Math.min(delay * 2, 30_000);
        this.scheduleCollabHostRestore(delay);
      } else if (!retry) {
        this.collabHostRestoreRetryDelayMs = 1_000;
      }
    });
    this.collabHostRestore = restore;
  }
}
