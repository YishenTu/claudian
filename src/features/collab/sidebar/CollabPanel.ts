import { type CollabOperationId } from '@claudian-collab/protocol';
import {
  type App,
  type EventRef,
  Menu,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { type CollabCoordinationSnapshot, type CollabFeaturePort, type CollabFeatureState, type CollabLocalCleanupChoice, type CollabLocalProjectSummary, type CollabPublicationReview, type CollabRequestReview, type CollabWorkingTreeReview, resolveEffectiveCollabProjectId } from '@/core/collab';
import type { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';
import type {
  CollabTransientSurfaceFactory,
  CollabTransientSurfaceRegistry,
} from '@/features/collab/modals/CollabTransientSurfaceRegistry';
import { CreateProjectModal } from '@/features/collab/modals/project/CreateProjectModal';
import { JoinProjectModal } from '@/features/collab/modals/project/JoinProjectModal';
import { ProjectManagementModal } from '@/features/collab/modals/project/ProjectManagementModal';
import { ReconnectProjectModal } from '@/features/collab/modals/project/ReconnectProjectModal';
import { PersonalChangesPanel } from '@/features/collab/sidebar/changes/PersonalChangesPanel';
import { TeamChangesPanel } from '@/features/collab/sidebar/changes/TeamChangesPanel';
import {
  GitSetupPanel,
  type GitSetupResolution,
} from '@/features/collab/sidebar/GitSetupPanel';
import {
  type TicketFocusPort,
  TicketListPanel,
} from '@/features/collab/sidebar/tickets/TicketListPanel';
import type { CollabSidebarSurfaceController } from '@/features/FeatureHost';
import { t } from '@/i18n/i18n';

export interface CollabPanelProjectSetupPort {
  getPendingSetupOperationId(projectId: string): Promise<CollabOperationId | null>;
}

export interface CollabPanelPort extends CollabFeaturePort {
  readonly state: CollabFeatureState;
}

export interface CollabPanelOptions {
  readonly app: App;
  readonly configuredGitPath: () => string;
  readonly copyText?: (text: string) => Promise<void>;
  readonly initialGitResolution?: Promise<GitSetupResolution>;
  readonly onOpenConflict?: (
    project: CollabLocalProjectSummary,
    operationId: CollabOperationId,
    location: 'my-changes' | 'request',
    requestId?: string,
  ) => void;
  readonly onOpenRequest?: (
    project: CollabLocalProjectSummary,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot,
    selectedPath?: string,
  ) => void;
  readonly onReviewIntent?: () => void;
  readonly onOpenPublicationReview?: (
    project: CollabLocalProjectSummary,
    review: CollabPublicationReview,
    selectedPath?: string,
  ) => void;
  readonly onCreateTicket?: (project: CollabLocalProjectSummary) => void;
  readonly onOpenTicket?: (
    project: CollabLocalProjectSummary,
    ticketId: string,
  ) => Promise<void> | void;
  readonly onOpenWorkingTreeReview?: (
    project: CollabLocalProjectSummary,
    review: CollabWorkingTreeReview,
    selectedPath?: string,
  ) => void;
  readonly onSaveConfiguredGitPath: (
    path: string,
  ) => Promise<GitSetupResolution | void>;
  readonly port: CollabPanelPort;
  readonly preparedReviews?: CollabPreparedReviewCache;
  readonly projectSetup: CollabPanelProjectSetupPort;
  readonly resolveGit: (rescan: boolean) => Promise<GitSetupResolution>;
  readonly ticketFocus?: TicketFocusPort;
  readonly transientSurfaces?: Pick<CollabTransientSurfaceRegistry, 'open'>;
}

interface CollabPanelViewState {
  readonly focus: {
    readonly attribute: 'data-action' | 'data-field' | 'data-path' | 'data-request-id';
    readonly value: string;
  } | null;
  readonly scrollTop: number;
}

interface PendingRecoveryAction {
  readonly recoveryEl: HTMLDivElement;
  operationId: CollabOperationId | null;
}

interface RetiredActionState {
  readonly projectId: string;
  failed: boolean;
  pending: boolean;
}

interface FallbackProjectSelectionState {
  failed: boolean;
  pending: boolean;
  readonly projectId: string;
}

export class CollabPanel implements CollabSidebarSurfaceController {
  private active = false;
  private destroyed = false;
  private gitResolution: GitSetupResolution | null = null;
  private fallbackProjectSelection: FallbackProjectSelectionState | null = null;
  private initialGitResolution: Promise<GitSetupResolution> | null;
  private initializationPromise: Promise<void> | null = null;
  private personalPanel: PersonalChangesPanel | null = null;
  private pendingRecoveryAction: PendingRecoveryAction | null = null;
  private retiredAction: RetiredActionState | null = null;
  private readonly rootEl: HTMLDivElement;
  private shellStateSignature: string | null = null;
  private readonly subscription: { dispose(): void };
  private teamPanel: TeamChangesPanel | null = null;
  private ticketPanel: TicketListPanel | null = null;
  private readonly vaultEventRefs: EventRef[];

  constructor(
    containerEl: HTMLElement,
    readonly leaf: WorkspaceLeaf,
    private readonly options: CollabPanelOptions,
  ) {
    this.initialGitResolution = options.initialGitResolution ?? null;
    this.rootEl = containerEl.createDiv({ cls: 'claudian-collab-panel' });
    this.subscription = options.port.subscribe(state => {
      if (this.active && this.shellSignature(state) !== this.shellStateSignature) {
        this.render();
      }
    });
    this.vaultEventRefs = [
      options.app.vault.on('modify', file => this.handleVaultPathChange(file.path)),
      options.app.vault.on('create', file => this.handleVaultPathChange(file.path)),
      options.app.vault.on('delete', file => this.handleVaultPathChange(file.path)),
      options.app.vault.on('rename', (file, oldPath) => {
        this.handleVaultPathChange(oldPath);
        this.handleVaultPathChange(file.path);
      }),
    ];
  }

  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    this.rootEl.classList.toggle('claudian-collab-panel--inactive', !active);
    if (!active) {
      this.personalPanel?.setActive(false);
      this.teamPanel?.setActive(false);
      this.ticketPanel?.setActive(false);
      return;
    }
    if (!this.gitResolution) {
      if (!this.initializationPromise) this.startInitialization();
      else this.renderLoading();
      return;
    }
    const state = this.readState();
    if (this.shellSignature(state) === this.shellStateSignature) {
      this.renderPendingRecoveryAction();
      const personalRefreshScheduled = this.personalPanel?.setActive(true) ?? false;
      this.teamPanel?.setActive(true, !personalRefreshScheduled);
      this.ticketPanel?.setActive(true);
      return;
    }
    this.render();
  }

  preload(): void {
    if (
      this.destroyed
      || this.gitResolution
      || this.initializationPromise
    ) return;
    this.startInitialization();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.destroyPersonalPanel();
    this.destroyTeamPanel();
    this.destroyTicketPanel();
    this.fallbackProjectSelection = null;
    this.retiredAction = null;
    this.subscription.dispose();
    for (const ref of this.vaultEventRefs) this.options.app.vault.offref(ref);
    this.rootEl.remove();
  }

  openCreateProject(): void {
    if (this.destroyed) return;
    this.openTransientSurface(onClosed => (
      new CreateProjectModal(this.options.app, this.options.port, { onClosed })
    ));
  }

  openJoinProject(): void {
    if (this.destroyed) return;
    this.openTransientSurface(onClosed => new JoinProjectModal(
      this.options.app,
      this.options.port,
      {
        onClosed,
        onJoined: () => {
          if (this.active) this.render();
        },
      },
    ));
  }

  openReconnectProject(project: CollabLocalProjectSummary): void {
    if (this.destroyed) return;
    this.openTransientSurface(onClosed => new ReconnectProjectModal(
      this.options.app,
      this.options.port,
      {
        onClosed,
        onReconnected: () => {
          if (this.active) this.render();
        },
        project,
      },
    ));
  }

  private startInitialization(): void {
    if (this.destroyed || this.gitResolution || this.initializationPromise) return;
    const pending = this.initialize();
    this.initializationPromise = pending;
    void pending.finally(() => {
      if (this.initializationPromise === pending) this.initializationPromise = null;
      if (this.active && !this.destroyed && !this.gitResolution) {
        this.startInitialization();
      }
    });
  }

  private async initialize(): Promise<void> {
    this.renderLoading();
    try {
      const initialGitResolution = this.initialGitResolution;
      this.initialGitResolution = null;
      const resolution = await (
        initialGitResolution ?? this.options.resolveGit(false)
      );
      if (this.destroyed) return;
      this.gitResolution = resolution;
      await this.options.port.initialize();
      if (
        !this.destroyed
        && this.active
        && this.shellSignature(this.readState()) !== this.shellStateSignature
      ) this.render();
    } catch {
      if (this.destroyed) return;
      this.gitResolution = { status: 'missing' };
      if (this.active) this.render();
    }
  }

  private render(): void {
    if (!this.active || this.destroyed) return;
    const viewState = this.captureViewState();
    try {
      this.clearRoot();
      if (!this.gitResolution) {
        this.renderLoading();
        return;
      }
      const state = this.readState();
      const selectedProject = state.projects.find(
        project => project.id === state.selectedProjectId,
      );
      if (
        this.gitResolution.status !== 'available'
        && selectedProject?.lifecycle !== 'retired'
      ) {
        this.renderGitSetup(this.gitResolution);
        return;
      }

      this.shellStateSignature = this.shellSignature(state);
      if (state.lifecycle === 'initializing' || state.lifecycle === 'uninitialized') {
        this.renderLoading();
        return;
      }
      if (state.lifecycle === 'failed') {
        this.renderFailure();
        return;
      }
      this.renderProjects(state);
    } finally {
      this.restoreViewState(viewState);
    }
  }

  private renderGitSetup(resolution: GitSetupResolution): void {
    const host = this.rootEl.createDiv({ cls: 'claudian-collab-panel-git' });
    new GitSetupPanel(host, {
      configuredPath: this.options.configuredGitPath(),
      ...(this.options.copyText ? { copyText: this.options.copyText } : {}),
      onRescan: () => this.refreshGit(true),
      onSaveConfiguredPath: path => this.saveGitPath(path),
      resolution,
    }).render();
  }

  private async refreshGit(rescan: boolean): Promise<GitSetupResolution> {
    const resolution = await this.options.resolveGit(rescan);
    this.gitResolution = resolution;
    if (resolution.status === 'available') await this.options.port.initialize();
    if (this.active) this.render();
    return resolution;
  }

  private async saveGitPath(path: string): Promise<GitSetupResolution | void> {
    const saved = await this.options.onSaveConfiguredGitPath(path);
    if (saved) {
      this.gitResolution = saved;
      if (saved.status === 'available') await this.options.port.initialize();
      if (this.active) this.render();
    }
    return saved;
  }

  private renderProjects(state: CollabFeatureState): void {
    if (state.projects.length === 0) {
      this.renderEmptyProjectHeader();
      this.renderEmptyState();
      return;
    }

    const effectiveProjectId = resolveEffectiveCollabProjectId(
      state.projects,
      state.selectedProjectId,
    );
    if (state.selectedProjectId !== effectiveProjectId) {
      this.renderFallbackProjectSelection(effectiveProjectId!);
      return;
    }
    this.fallbackProjectSelection = null;
    const selected = state.projects.find(project => project.id === effectiveProjectId)!;
    const projectToolbar = this.rootEl.createDiv({
      attr: { title: selected.workspacePath },
      cls: 'claudian-collab-project-toolbar',
    });
    const picker = projectToolbar.createEl('button', {
      attr: {
        'aria-label': t('collab.panel.projectPicker'),
        'aria-haspopup': 'menu',
        'data-field': 'project-picker',
        type: 'button',
      },
      cls: 'claudian-collab-project-picker',
    });
    picker.createSpan({
      cls: 'claudian-collab-project-picker-label',
      text: selected.name,
    });
    picker.addEventListener('click', () => {
      this.showProjectMenu(picker, state.projects, selected.id);
    });
    const projectActions = projectToolbar.createDiv({
      cls: 'claudian-collab-project-header-actions',
    });
    const addButton = projectActions.createEl('button', {
      attr: {
        'aria-label': t('collab.panel.addProject'),
        'aria-haspopup': 'menu',
        'data-action': 'add-project',
        title: t('collab.panel.addProject'),
        type: 'button',
      },
      cls: 'clickable-icon claudian-collab-panel-header-action',
    });
    setIcon(addButton, 'plus');
    addButton.addEventListener('click', () => this.showAddProjectMenu(addButton));
    this.renderProjectHome(selected, projectActions);
  }

  private renderFallbackProjectSelection(projectId: string): void {
    const current = this.fallbackProjectSelection;
    if (current?.projectId === projectId && current.failed) {
      this.rootEl.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-panel-status claudian-collab-panel-status--warning',
        text: t('collab.panel.loadFailed'),
      });
      const retry = this.rootEl.createEl('button', {
        attr: { 'data-action': 'retry-project-selection', type: 'button' },
        text: t('collab.panel.retry'),
      });
      retry.addEventListener('click', () => {
        if (this.destroyed) return;
        this.fallbackProjectSelection = null;
        if (this.active) this.render();
      });
      return;
    }

    this.rootEl.createDiv({
      attr: { 'aria-live': 'polite', role: 'status' },
      cls: 'claudian-collab-panel-status',
      text: t('collab.panel.loading'),
    });
    if (current?.projectId === projectId && current.pending) return;

    const selection: FallbackProjectSelectionState = {
      failed: false,
      pending: true,
      projectId,
    };
    this.fallbackProjectSelection = selection;
    void this.options.port.selectProject(projectId).then(result => {
      if (this.destroyed || this.fallbackProjectSelection !== selection) return;
      selection.pending = false;
      selection.failed = result.status !== 'success'
        || this.readState().selectedProjectId !== projectId;
      if (selection.failed) this.shellStateSignature = null;
      if (this.active) this.render();
    }).catch(() => {
      if (this.destroyed || this.fallbackProjectSelection !== selection) return;
      selection.pending = false;
      selection.failed = true;
      this.shellStateSignature = null;
      if (this.active) this.render();
    });
  }

  private showAddProjectMenu(anchor: HTMLButtonElement): void {
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem(item => item
      .setTitle(t('collab.panel.createProject'))
      .setIcon('plus')
      .onClick(() => this.openCreateProject()));
    menu.addItem(item => item
      .setTitle(t('collab.panel.joinProject'))
      .setIcon('log-in')
      .onClick(() => this.openJoinProject()));
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  private showProjectMenu(
    anchor: HTMLButtonElement,
    projects: readonly CollabLocalProjectSummary[],
    selectedProjectId: string,
  ): void {
    const menu = new Menu().setUseNativeMenu(false);
    for (const project of projects) {
      menu.addItem(item => item
        .setTitle(project.name)
        .setChecked(project.id === selectedProjectId)
        .onClick(() => {
          if (this.destroyed || project.id === selectedProjectId) return;
          void this.options.port.selectProject(project.id).then(() => {
            if (this.active) this.render();
          });
        }));
    }
    const selected = projects.find(project => project.id === selectedProjectId);
    if (selected?.hostStatus === 'not-host') {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle(t('collab.panel.reconnectProject'))
        .setIcon('refresh-cw')
        .onClick(() => this.openReconnectProject(selected)));
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
  }

  private renderEmptyProjectHeader(): void {
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-panel-header' });
    header.createEl('h3', { text: t('collab.panel.title') });
  }

  private renderEmptyState(): void {
    const empty = this.rootEl.createDiv({ cls: 'claudian-collab-empty' });
    empty.createDiv({ text: t('collab.panel.emptyDescription') });
    const actions = empty.createDiv({ cls: 'claudian-collab-empty-actions' });
    const create = actions.createEl('button', {
      attr: { 'data-action': 'empty-create', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.panel.createProject'),
    });
    create.addEventListener('click', () => this.openCreateProject());
    const join = actions.createEl('button', {
      attr: { 'data-action': 'join-project', type: 'button' },
      cls: 'claudian-collab-empty-join',
      text: t('collab.panel.joinProject'),
    });
    join.addEventListener('click', () => this.openJoinProject());
  }

  private renderProjectHome(
    project: CollabLocalProjectSummary,
    projectHeaderActions: HTMLDivElement,
  ): void {
    const home = this.rootEl.createDiv({ cls: 'claudian-collab-project-home' });

    if (project.lifecycle === 'retired') {
      this.renderRetiredProject(home, project);
    } else if (project.health === 'needs-attention') {
      const recovery = home.createDiv({ cls: 'claudian-collab-project-recovery' });
      recovery.createDiv({ text: t('collab.panel.setupIncomplete') });
      const pendingRecoveryAction: PendingRecoveryAction = {
        operationId: null,
        recoveryEl: recovery,
      };
      this.pendingRecoveryAction = pendingRecoveryAction;
      void this.options.projectSetup.getPendingSetupOperationId(project.id)
        .then(operationId => {
          if (
            this.pendingRecoveryAction !== pendingRecoveryAction
            || !recovery.isConnected
          ) return;
          pendingRecoveryAction.operationId = operationId;
          if (this.active) this.renderPendingRecoveryAction();
        })
        .catch(() => undefined);
    } else if (project.health === 'missing') {
      home.createDiv({
        cls: 'claudian-collab-project-recovery',
        text: t('collab.panel.workingCopyMissing'),
      });
    } else {
      const personal = home.createDiv({ cls: 'claudian-collab-personal-home' });
      this.personalPanel = new PersonalChangesPanel(personal, {
        onInspection: result => {
          if (result.status === 'success' && result.value.coordination) {
            const coordination = result.value.coordination;
            const operationId = result.value.personalChanges?.action === 'resolve-changes'
              ? result.value.personalChanges.conflictOperationId
              : undefined;
            const publicationReview = result.value.personalChanges?.action
              === 'review-and-publish'
              ? result.value.personalChanges.review
              : undefined;
            const ownRequest = coordination.snapshot.openRequests.find(
              request => request.memberId === coordination.snapshot.currentMember.id,
            );
            this.teamPanel?.adoptSnapshot(
              coordination,
              operationId && ownRequest
                ? { operationId, requestId: ownRequest.id }
                : publicationReview && ownRequest
                  ? { requestId: ownRequest.id, review: publicationReview }
                : null,
            );
          } else {
            void this.teamPanel?.refresh();
          }
        },
        onOpenConflict: operationId => (
          this.options.onOpenConflict?.(project, operationId, 'my-changes')
        ),
        onOpenPublicationReview: (review, selectedPath) => (
          this.options.onOpenPublicationReview?.(project, review, selectedPath)
        ),
        onOpenWorkingTreeReview: (review, selectedPath) => (
          this.options.onOpenWorkingTreeReview?.(project, review, selectedPath)
        ),
        port: this.options.port,
        project,
      });
      const team = home.createDiv({ cls: 'claudian-collab-team-home' });
      this.teamPanel = new TeamChangesPanel(team, {
        deferInitialRefresh: true,
        onOpenConflict: (operationId, requestId) => (
          this.options.onOpenConflict?.(project, operationId, 'request', requestId)
        ),
        onOpenFile: (review, coordination, selectedPath) => {
          this.options.onOpenRequest?.(project, review, coordination, selectedPath);
        },
        onOpenPublicationReview: (review, selectedPath) => {
          this.options.onOpenPublicationReview?.(project, review, selectedPath);
        },
        onReviewIntent: this.options.onReviewIntent,
        port: this.options.port,
        preparedReviews: this.options.preparedReviews,
        project,
      });
      const tickets = home.createDiv({ cls: 'claudian-collab-ticket-home' });
      this.ticketPanel = new TicketListPanel(tickets, {
        ...(this.options.ticketFocus ? { focus: this.options.ticketFocus } : {}),
        onCreate: () => this.options.onCreateTicket?.(project),
        onOpen: ticket => this.options.onOpenTicket?.(project, ticket.id),
        port: this.options.port,
        project,
      });
      this.ticketPanel.setActive(this.active);
    }

    if (project.lifecycle !== 'retired') {
      this.renderProjectManagementControl(
        project,
        projectHeaderActions,
      );
    }
  }

  private renderRetiredProject(
    home: HTMLDivElement,
    project: CollabLocalProjectSummary,
  ): void {
    const retired = home.createDiv({
      attr: { 'data-state': 'retired' },
      cls: 'claudian-collab-retired-panel',
    });
    retired.createEl('h3', { text: t('collab.retired.title') });
    retired.createDiv({
      text: t('collab.retired.ended', {
        date: project.retiredAt
          ? new Date(project.retiredAt).toLocaleString()
          : t('collab.retired.unknownDate'),
      }),
    });
    retired.createDiv({
      cls: 'claudian-collab-project-path',
      text: project.workspacePath,
    });
    const action = this.retiredAction?.projectId === project.id
      ? this.retiredAction
      : null;
    if (project.cleanupStatus === 'failed') {
      retired.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-panel-status--warning',
        text: t('collab.retired.cleanupFailed'),
      });
      const retry = retired.createEl('button', {
        attr: { 'data-action': 'retry-retired-cleanup', type: 'button' },
        text: t('collab.retired.retryCleanup'),
      });
      retry.disabled = action?.pending === true;
      retry.addEventListener('click', () => {
        void this.runRetiredAction(project.id, () => (
          this.options.port.retryProjectCleanup(project.id)
        ));
      });
    } else if (
      project.cleanupStatus === 'pending'
      || project.cleanupStatus === 'running'
    ) {
      retired.createDiv({
        attr: { 'aria-live': 'polite', role: 'status' },
        text: t('collab.retired.finishingCleanup'),
      });
    } else {
      const actions = retired.createDiv({ cls: 'claudian-collab-retired-actions' });
      this.createRetiredFinalizationButton(actions, project, 'keep-files');
      this.createRetiredFinalizationButton(actions, project, 'delete-files');
    }
    if (action?.failed) {
      retired.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-panel-status--warning',
        text: t('collab.access.actionFailed'),
      });
    }
  }

  private createRetiredFinalizationButton(
    container: HTMLElement,
    project: CollabLocalProjectSummary,
    cleanupChoice: CollabLocalCleanupChoice,
  ): void {
    const button = container.createEl('button', {
      attr: {
        'data-action': cleanupChoice === 'keep-files'
          ? 'keep-retired-files'
          : 'delete-retired-files',
        type: 'button',
      },
      cls: cleanupChoice === 'delete-files' ? 'mod-warning' : undefined,
      text: cleanupChoice === 'keep-files'
        ? t('collab.retired.keepFiles')
        : t('collab.retired.deleteFiles'),
    });
    button.disabled = this.retiredAction?.projectId === project.id
      && this.retiredAction.pending;
    button.addEventListener('click', () => {
      void this.runRetiredAction(project.id, () => (
        this.options.port.finalizeRetiredProject({ cleanupChoice, projectId: project.id })
      ));
    });
  }

  private async runRetiredAction(
    projectId: string,
    operation: () => Promise<{ readonly status: string }>,
  ): Promise<void> {
    if (this.retiredAction?.pending) return;
    const action: RetiredActionState = { failed: false, pending: true, projectId };
    this.retiredAction = action;
    if (this.active) this.render();
    let succeeded: boolean;
    try {
      succeeded = (await operation()).status === 'success';
    } catch {
      succeeded = false;
    }
    if (this.destroyed || this.retiredAction !== action) return;
    if (succeeded) {
      this.retiredAction = null;
    } else {
      action.failed = true;
      action.pending = false;
    }
    if (
      this.active
      && resolveEffectiveCollabProjectId(
        this.readState().projects,
        this.readState().selectedProjectId,
      ) === projectId
    ) this.render();
  }

  private renderProjectManagementControl(
    project: CollabLocalProjectSummary,
    projectHeaderActions: HTMLDivElement,
  ): void {
    const management = projectHeaderActions.createEl('button', {
      attr: {
        'aria-label': t('collab.projectManagement.title'),
        'data-action': 'manage-project',
        title: t('collab.projectManagement.title'),
        type: 'button',
      },
      cls: 'clickable-icon claudian-collab-project-management',
    });
    const icon = management.createSpan({ cls: 'claudian-collab-project-management-icon' });
    setIcon(icon, 'settings');
    management.addEventListener('click', () => {
      this.openTransientSurface(onClosed => new ProjectManagementModal(
        this.options.app,
        this.options.port,
        {
          ...(this.options.copyText ? { copyText: this.options.copyText } : {}),
          onChanged: () => {
            void this.options.port.inspectProject(project.id);
          },
          onClosed,
          project,
        },
      ));
    });
  }

  private openTransientSurface(factory: CollabTransientSurfaceFactory): void {
    if (this.options.transientSurfaces) {
      this.options.transientSurfaces.open(factory);
      return;
    }
    factory(() => undefined).open();
  }

  private async resumeSetup(
    operationId: CollabOperationId,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    const result = await this.options.port.resumeSetup({ operationId });
    if (result.status !== 'success') button.disabled = false;
    if (this.active) this.render();
  }

  private renderPendingRecoveryAction(): void {
    const pending = this.pendingRecoveryAction;
    const operationId = pending?.operationId;
    if (
      !pending
      || !operationId
      || !pending.recoveryEl.isConnected
      || pending.recoveryEl.querySelector('[data-action="resume-setup"]')
    ) return;
    const resume = pending.recoveryEl.createEl('button', {
      attr: { 'data-action': 'resume-setup', type: 'button' },
      text: t('collab.createProject.resume'),
    });
    resume.addEventListener('click', () => {
      void this.resumeSetup(operationId, resume);
    });
  }

  private renderLoading(): void {
    if (!this.active || this.destroyed) return;
    this.clearRoot();
    this.rootEl.createDiv({
      attr: { 'aria-live': 'polite', role: 'status' },
      cls: 'claudian-collab-panel-status',
      text: t('collab.panel.loading'),
    });
  }

  private renderFailure(): void {
    this.rootEl.createDiv({
      attr: { role: 'alert' },
      cls: 'claudian-collab-panel-status claudian-collab-panel-status--warning',
      text: t('collab.panel.loadFailed'),
    });
    const retry = this.rootEl.createEl('button', {
      attr: { 'data-action': 'retry', type: 'button' },
      text: t('collab.panel.retry'),
    });
    retry.addEventListener('click', () => {
      void this.options.port.initialize().then(() => this.render());
    });
  }

  private readState(): CollabFeatureState {
    return this.options.port.state;
  }

  private handleVaultPathChange(path: string): void {
    if (this.destroyed || !this.personalPanel) return;
    const state = this.readState();
    const projectId = resolveEffectiveCollabProjectId(
      state.projects,
      state.selectedProjectId,
    );
    const project = state.projects.find(item => item.id === projectId);
    if (!project || project.lifecycle === 'retired') return;
    const workspacePath = project.workspacePath.replace(/\/+$/, '');
    if (path !== workspacePath && !path.startsWith(`${workspacePath}/`)) return;
    this.personalPanel.invalidateWorkingTree();
  }

  private captureViewState(): CollabPanelViewState {
    const activeElement = this.rootEl.ownerDocument.activeElement;
    let focus: CollabPanelViewState['focus'] = null;
    if (activeElement instanceof HTMLElement && this.rootEl.contains(activeElement)) {
      const attributes = [
        'data-action',
        'data-field',
        'data-path',
        'data-request-id',
      ] as const;
      for (const attribute of attributes) {
        const value = activeElement.getAttribute(attribute);
        if (value) {
          focus = { attribute, value };
          break;
        }
      }
    }
    return { focus, scrollTop: this.rootEl.scrollTop };
  }

  private restoreViewState(state: CollabPanelViewState): void {
    this.rootEl.scrollTop = state.scrollTop;
    if (!state.focus) return;
    const candidates = this.rootEl.querySelectorAll<HTMLElement>(
      `[${state.focus.attribute}]`,
    );
    for (const candidate of candidates) {
      if (candidate.getAttribute(state.focus.attribute) === state.focus.value) {
        candidate.focus({ preventScroll: true });
        return;
      }
    }
  }

  private clearRoot(): void {
    this.pendingRecoveryAction = null;
    this.destroyPersonalPanel();
    this.destroyTeamPanel();
    this.destroyTicketPanel();
    this.rootEl.replaceChildren();
  }

  private destroyPersonalPanel(): void {
    this.personalPanel?.destroy();
    this.personalPanel = null;
  }

  private destroyTeamPanel(): void {
    this.teamPanel?.destroy();
    this.teamPanel = null;
  }

  private destroyTicketPanel(): void {
    this.ticketPanel?.destroy();
    this.ticketPanel = null;
  }

  private shellSignature(state: CollabFeatureState): string {
    return JSON.stringify({
      error: state.error?.code ?? null,
      lifecycle: state.lifecycle,
      projects: state.projects,
      selectedProjectId: state.selectedProjectId,
    });
  }
}
