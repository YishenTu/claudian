import { type CollabOperationId } from '@claudian-collab/protocol';
import {
  type App,
  type EventRef,
  Menu,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { type CollabCoordinationSnapshot, type CollabFeaturePort, type CollabFeatureState, type CollabLocalCleanupChoice, type CollabLocalProjectSummary, type CollabPendingSetupSummary, type CollabPublicationReview, type CollabRequestReview, type CollabWorkingTreeReview, resolveEffectiveCollabProjectId } from '@/core/collab';
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
import { ProjectUpdatePanel } from '@/features/collab/sidebar/ProjectUpdatePanel';
import {
  type TicketFocusPort,
  TicketListPanel,
} from '@/features/collab/sidebar/tickets/TicketListPanel';
import type { CollabSidebarSurfaceController } from '@/features/FeatureHost';
import { t } from '@/i18n/i18n';

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
    location: 'my-changes' | 'request' | 'update',
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
  readonly resolveGit: (rescan: boolean) => Promise<GitSetupResolution>;
  readonly ticketFocus?: TicketFocusPort;
  readonly transientSurfaces?: Pick<
    CollabTransientSurfaceRegistry,
    'closeAll' | 'open'
  >;
}

interface CollabPanelViewState {
  readonly focus: {
    readonly attribute: 'data-action' | 'data-field' | 'data-path' | 'data-request-id';
    readonly value: string;
  } | null;
  readonly scrollTop: number;
}

interface WorkingCopyRecoveryAction {
  readonly projectId: string;
  completed?: boolean;
  pending: boolean;
  failed: boolean;
  operationId?: CollabOperationId;
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
  private updatePanel: ProjectUpdatePanel | null = null;
  private personalPanel: PersonalChangesPanel | null = null;
  private readonly setupActions = new Map<string, 'pending' | 'failed' | 'completed'>();
  private retiredAction: RetiredActionState | null = null;
  private workingCopyRecovery: WorkingCopyRecoveryAction | null = null;
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
      if (this.workingCopyRecovery && state.projects.some(project => (
        project.id === this.workingCopyRecovery?.projectId && project.health === 'healthy'
      ))) {
        this.workingCopyRecovery = null;
        this.shellStateSignature = null;
      }
      if (this.active && this.#shellSignature(state) !== this.shellStateSignature) {
        this.render();
      }
    });
    this.vaultEventRefs = [
      options.app.vault.on('modify', file => this.#handleVaultPathChange(file.path)),
      options.app.vault.on('create', file => this.#handleVaultPathChange(file.path)),
      options.app.vault.on('delete', file => this.#handleVaultPathChange(file.path)),
      options.app.vault.on('rename', (file, oldPath) => {
        this.#handleVaultPathChange(oldPath);
        this.#handleVaultPathChange(file.path);
      }),
    ];
  }

  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    this.rootEl.classList.toggle('claudian-collab-panel--inactive', !active);
    if (!active) {
      this.updatePanel?.setActive(false);
      this.personalPanel?.setActive(false);
      this.teamPanel?.setActive(false);
      this.ticketPanel?.setActive(false);
      return;
    }
    if (!this.gitResolution) {
      if (!this.initializationPromise) this.#startInitialization();
      else this.#renderLoading();
      return;
    }
    const state = this.#readState();
    if (this.#shellSignature(state) === this.shellStateSignature) {
      this.updatePanel?.setActive(true);
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
    this.#startInitialization();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.#destroyPersonalPanel();
    this.#destroyTeamPanel();
    this.#destroyTicketPanel();
    this.fallbackProjectSelection = null;
    this.retiredAction = null;
    this.subscription.dispose();
    for (const ref of this.vaultEventRefs) this.options.app.vault.offref(ref);
    this.rootEl.remove();
  }

  openCreateProject(): void {
    if (this.destroyed) return;
    this.#openTransientSurface(onClosed => (
      new CreateProjectModal(this.options.app, this.options.port, { onClosed })
    ));
  }

  openJoinProject(): void {
    if (this.destroyed) return;
    this.#openTransientSurface(onClosed => new JoinProjectModal(
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
    this.#openTransientSurface(onClosed => new ReconnectProjectModal(
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

  #startInitialization(): void {
    if (this.destroyed || this.gitResolution || this.initializationPromise) return;
    const pending = this.initialize();
    this.initializationPromise = pending;
    void pending.finally(() => {
      if (this.initializationPromise === pending) this.initializationPromise = null;
      if (this.active && !this.destroyed && !this.gitResolution) {
        this.#startInitialization();
      }
    });
  }

  private async initialize(): Promise<void> {
    this.#renderLoading();
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
        && this.#shellSignature(this.#readState()) !== this.shellStateSignature
      ) this.render();
    } catch {
      if (this.destroyed) return;
      this.gitResolution = { status: 'missing' };
      if (this.active) this.render();
    }
  }

  private render(): void {
    if (!this.active || this.destroyed) return;
    const viewState = this.#captureViewState();
    try {
      this.#clearRoot();
      if (!this.gitResolution) {
        this.#renderLoading();
        return;
      }
      const state = this.#readState();
      const selectedProject = state.projects.find(
        project => project.id === state.selectedProjectId,
      );
      if (
        this.gitResolution.status !== 'available'
        && selectedProject?.lifecycle !== 'retired'
      ) {
        this.#renderGitSetup(this.gitResolution);
        return;
      }

      this.shellStateSignature = this.#shellSignature(state);
      if (state.lifecycle === 'initializing' || state.lifecycle === 'uninitialized') {
        this.#renderLoading();
        return;
      }
      if (state.lifecycle === 'failed') {
        this.#renderFailure();
        return;
      }
      this.#renderProjects(state);
    } finally {
      this.#restoreViewState(viewState);
    }
  }

  #renderGitSetup(resolution: GitSetupResolution): void {
    const host = this.rootEl.createDiv({ cls: 'claudian-collab-panel-git' });
    new GitSetupPanel(host, {
      configuredPath: this.options.configuredGitPath(),
      ...(this.options.copyText ? { copyText: this.options.copyText } : {}),
      onRescan: () => this.#refreshGit(true),
      onSaveConfiguredPath: path => this.#saveGitPath(path),
      resolution,
    }).render();
  }

  async #refreshGit(rescan: boolean): Promise<GitSetupResolution> {
    const resolution = await this.options.resolveGit(rescan);
    this.gitResolution = resolution;
    if (resolution.status === 'available') await this.options.port.initialize();
    if (this.active) this.render();
    return resolution;
  }

  async #saveGitPath(path: string): Promise<GitSetupResolution | void> {
    const saved = await this.options.onSaveConfiguredGitPath(path);
    if (saved) {
      this.gitResolution = saved;
      if (saved.status === 'available') await this.options.port.initialize();
      if (this.active) this.render();
    }
    return saved;
  }

  #renderProjects(state: CollabFeatureState): void {
    if (state.projects.length === 0) {
      this.#renderEmptyProjectHeader();
      this.#renderPendingSetups(state);
      this.#renderEmptyState();
      return;
    }

    const effectiveProjectId = resolveEffectiveCollabProjectId(
      state.projects,
      state.selectedProjectId,
    );
    if (state.selectedProjectId !== effectiveProjectId) {
      this.#renderFallbackProjectSelection(effectiveProjectId!);
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
      this.#showProjectMenu(picker, state.projects, selected.id);
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
    addButton.addEventListener('click', () => this.#showAddProjectMenu(addButton));
    this.#renderPendingSetups(state);
    this.#renderProjectHome(selected, projectActions);
  }

  #renderFallbackProjectSelection(projectId: string): void {
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
    this.options.transientSurfaces?.closeAll();
    void this.options.port.selectProject(projectId).then(result => {
      if (this.destroyed || this.fallbackProjectSelection !== selection) return;
      selection.pending = false;
      selection.failed = result.status !== 'success'
        || this.#readState().selectedProjectId !== projectId;
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

  #showAddProjectMenu(anchor: HTMLButtonElement): void {
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

  #showProjectMenu(
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
          this.options.transientSurfaces?.closeAll();
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

  #renderEmptyProjectHeader(): void {
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-panel-header' });
    header.createEl('h3', { text: t('collab.panel.title') });
  }

  #renderEmptyState(): void {
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

  #renderProjectHome(
    project: CollabLocalProjectSummary,
    projectHeaderActions: HTMLDivElement,
  ): void {
    const home = this.rootEl.createDiv({ cls: 'claudian-collab-project-home' });

    if (project.lifecycle === 'retired') {
      this.#renderRetiredProject(home, project);
    } else if (project.lifecycle === 'leaving') {
      this.#renderLeaveRecovery(home, project);
    } else if (project.health === 'needs-attention') {
      if (!this.#readState().pendingSetups?.some(setup => setup.projectId === project.id)) {
        home.createDiv({ cls: 'claudian-collab-project-recovery', text: t('collab.panel.setupIncomplete') });
      }
    } else if (project.health === 'missing') {
      this.#renderMissingWorkingCopy(home, project);
    } else {
      this.updatePanel = new ProjectUpdatePanel(home.createDiv(), {
        projectId: project.id,
        port: this.options.port,
        onReview: review => this.options.onOpenPublicationReview?.(project, review),
        onConflict: operationId => this.options.onOpenConflict?.(project, operationId, 'update'),
        refresh: () => { void this.personalPanel?.refresh(); },
      });
      this.updatePanel.setActive(this.active);
      const personal = home.createDiv({ cls: 'claudian-collab-personal-home' });
      this.personalPanel = new PersonalChangesPanel(personal, {
        onInspection: result => {
          this.updatePanel?.adopt(result.status === 'success' ? result.value.projectUpdate : undefined);
          if (result.status === 'success' && result.value.coordination) {
            this.teamPanel?.adoptSnapshot(result.value.coordination);
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
        onOpenFile: (review, coordination, selectedPath) => {
          this.options.onOpenRequest?.(project, review, coordination, selectedPath);
        },
        onReviewIntent: this.options.onReviewIntent,
        port: this.options.port,
        preparedReviews: this.options.preparedReviews,
        project,
      });
      const tickets = home.createDiv({ cls: 'claudian-collab-ticket-home' });
      this.ticketPanel = new TicketListPanel(tickets, {
        scrollContainer: this.rootEl,
        ...(this.options.ticketFocus ? { focus: this.options.ticketFocus } : {}),
        onCreate: () => this.options.onCreateTicket?.(project),
        onOpen: ticket => this.options.onOpenTicket?.(project, ticket.id),
        port: this.options.port,
        project,
      });
      this.ticketPanel.setActive(this.active);
    }

    if (project.lifecycle !== 'retired') {
      this.#renderProjectManagementControl(
        project,
        projectHeaderActions,
      );
    }
  }

  #renderMissingWorkingCopy(home: HTMLElement, project: CollabLocalProjectSummary): void {
    const recovery = home.createDiv({ cls: 'claudian-collab-project-recovery' });
    const action = this.workingCopyRecovery?.projectId === project.id ? this.workingCopyRecovery : null;
    if (action?.completed) {
      this.#renderCompletedSetup(recovery, project.name);
      return;
    }
    recovery.createDiv({ text: t('collab.panel.workingCopyMissing') });
    if (project.authorityKind !== 'cloud') return;
    const repair = recovery.createEl('button', {
      attr: { 'data-action': 'restore-working-copy', type: 'button' },
      text: t(action?.operationId ? 'collab.createProject.resume' : 'collab.panel.restoreWorkingCopy'),
    });
    repair.disabled = this.workingCopyRecovery?.pending === true;
    repair.addEventListener('click', () => { void this.#restoreWorkingCopy(project.id); });
    if (action?.failed) recovery.createDiv({ attr: { role: 'alert' }, text: t('collab.panel.restoreWorkingCopyFailed') });
  }

  async #restoreWorkingCopy(projectId: string): Promise<void> {
    if (this.destroyed || this.workingCopyRecovery?.pending) return;
    const action: WorkingCopyRecoveryAction = {
      projectId, pending: true, failed: false,
      ...(this.workingCopyRecovery?.projectId === projectId && this.workingCopyRecovery.operationId
        ? { operationId: this.workingCopyRecovery.operationId } : {}),
    };
    this.workingCopyRecovery = action;
    this.render();
    const result = action.operationId
      ? await this.options.port.resumeSetup({ operationId: action.operationId, projectId })
      : await this.options.port.joinProject({ existingCloudProjectId: projectId });
    if (this.destroyed || this.workingCopyRecovery !== action) return;
    action.pending = false;
    action.failed = result.status !== 'success';
    if (result.status === 'success') { action.completed = true; delete action.operationId; }
    if (result.status === 'recovery-required') action.operationId = result.operationId;
    this.shellStateSignature = null;
    this.render();
  }

  #renderRetiredProject(
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
        void this.#runRetiredAction(project.id, () => (
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
      this.#createRetiredFinalizationButton(actions, project, 'keep-files');
      this.#createRetiredFinalizationButton(actions, project, 'delete-files');
    }
    if (action?.failed) {
      retired.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-panel-status--warning',
        text: t('collab.access.actionFailed'),
      });
    }
  }

  #createRetiredFinalizationButton(
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
      void this.#runRetiredAction(project.id, () => (
        this.options.port.finalizeRetiredProject({ cleanupChoice, projectId: project.id })
      ));
    });
  }

  async #runRetiredAction(
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
        this.#readState().projects,
        this.#readState().selectedProjectId,
      ) === projectId
    ) this.render();
  }

  #renderProjectManagementControl(
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
      this.#openTransientSurface(onClosed => new ProjectManagementModal(
        this.options.app,
        this.options.port,
        {
          ...(this.options.copyText ? { copyText: this.options.copyText } : {}),
          onChanged: () => {
            void this.options.port.inspectProject(project.id);
          },
          onReconnect: selected => this.openReconnectProject(selected),
          onClosed,
          project,
        },
      ));
    });
  }

  #openTransientSurface(factory: CollabTransientSurfaceFactory): void {
    if (this.options.transientSurfaces) {
      this.options.transientSurfaces.open(factory);
      return;
    }
    factory(() => undefined).open();
  }

  #renderCompletedSetup(container: HTMLElement, name: string): void {
    container.createDiv({ attr: { role: 'status' }, text: t('collab.notices.setupReady', { name }) });
    const refresh = container.createEl('button', { attr: { type: 'button' }, text: t('common.refresh') });
    refresh.addEventListener('click', () => {
      refresh.disabled = true;
      void this.options.port.initialize().finally(() => { refresh.disabled = false; });
    });
  }

  #renderPendingSetups(state: CollabFeatureState): void {
    const setups = state.pendingSetups ?? [];
    for (const operationId of this.setupActions.keys()) {
      if (!setups.some(setup => setup.operationId === operationId)) this.setupActions.delete(operationId);
    }
    for (const setup of setups) {
      const recovery = this.rootEl.createDiv({ cls: 'claudian-collab-project-recovery' });
      recovery.createEl('h4', { text: setup.name });
      if (!setup.operationId) {
        recovery.createDiv({ attr: { role: 'alert' }, text: t('collab.panel.setupRecoveryUnavailable') });
        const retry = recovery.createEl('button', { attr: { type: 'button' }, text: t('collab.access.retry') });
        retry.addEventListener('click', () => { retry.disabled = true; void this.options.port.initialize(); });
        continue;
      }
      if (this.setupActions.get(setup.operationId) === 'completed') {
        this.#renderCompletedSetup(recovery, setup.name);
        continue;
      }
      recovery.createDiv({ text: t('collab.panel.setupIncomplete') });
      const resume = recovery.createEl('button', {
        attr: { 'aria-label': `${t('collab.createProject.resume')}: ${setup.name}`, 'data-action': 'resume-setup', type: 'button' },
        text: t('collab.createProject.resume'),
      });
      resume.disabled = this.setupActions.get(setup.operationId) === 'pending';
      resume.addEventListener('click', () => { void this.#resumeSetup(setup); });
      if (this.setupActions.get(setup.operationId) === 'failed') {
        recovery.createDiv({ attr: { role: 'alert' }, text: t('collab.createProject.resumeFailed') });
      }
    }
  }

  async #resumeSetup(setup: CollabPendingSetupSummary): Promise<void> {
    if (this.destroyed || !setup.operationId || ['pending', 'completed'].includes(this.setupActions.get(setup.operationId) ?? '')) return;
    this.setupActions.set(setup.operationId, 'pending');
    this.render();
    const result = await this.options.port.resumeSetup({ operationId: setup.operationId, projectId: setup.projectId });
    if (this.destroyed) return;
    this.setupActions.set(setup.operationId, result.status === 'success' ? 'completed' : 'failed');
    this.shellStateSignature = null;
    this.render();
  }

  #renderLeaveRecovery(
    container: HTMLElement,
    project: CollabLocalProjectSummary,
  ): void {
    const recovery = container.createDiv({ cls: 'claudian-collab-project-recovery' });
    recovery.createDiv({ text: t('collab.panel.leaveRecovery') });
    const resume = recovery.createEl('button', {
      attr: { 'data-action': 'resume-leave', type: 'button' },
      text: t('collab.panel.resumeLeave'),
    });
    resume.addEventListener('click', () => {
      resume.disabled = true;
      void this.options.port.resumeLeave(project.id).then(result => {
        if (this.destroyed) return;
        if (result.status !== 'success') {
          resume.disabled = false;
          recovery.querySelector('[role="alert"]')?.remove();
          recovery.createDiv({
            attr: { role: 'alert' },
            text: t('collab.panel.leaveRecoveryFailed'),
          });
          return;
        }
        if (this.active) this.render();
      });
    });
  }

  #renderLoading(): void {
    if (!this.active || this.destroyed) return;
    this.#clearRoot();
    this.rootEl.createDiv({
      attr: { 'aria-live': 'polite', role: 'status' },
      cls: 'claudian-collab-panel-status',
      text: t('collab.panel.loading'),
    });
  }

  #renderFailure(): void {
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

  #readState(): CollabFeatureState {
    return this.options.port.state;
  }

  #handleVaultPathChange(path: string): void {
    if (this.destroyed || !this.personalPanel) return;
    const state = this.#readState();
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

  #captureViewState(): CollabPanelViewState {
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

  #restoreViewState(state: CollabPanelViewState): void {
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

  #clearRoot(): void {
    this.updatePanel?.destroy();
    this.updatePanel = null;
    this.#destroyPersonalPanel();
    this.#destroyTeamPanel();
    this.#destroyTicketPanel();
    this.rootEl.replaceChildren();
  }

  #destroyPersonalPanel(): void {
    this.personalPanel?.destroy();
    this.personalPanel = null;
  }

  #destroyTeamPanel(): void {
    this.teamPanel?.destroy();
    this.teamPanel = null;
  }

  #destroyTicketPanel(): void {
    this.ticketPanel?.destroy();
    this.ticketPanel = null;
  }

  #shellSignature(state: CollabFeatureState): string {
    return JSON.stringify({
      error: state.error?.code ?? null,
      lifecycle: state.lifecycle,
      projects: state.projects,
      pendingSetups: state.pendingSetups,
      selectedProjectId: state.selectedProjectId,
    });
  }
}
