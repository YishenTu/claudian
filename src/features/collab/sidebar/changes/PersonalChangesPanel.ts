import { type CollabChangedFile } from '@claudian-collab/protocol';

import { type CollabFeatureState, type CollabLocalProjectSummary, type CollabProjectInspection, type CollabPublicationReview, type CollabResult, type CollabWorkingTreeReview } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { renderCollabChangedFileList } from '@/features/collab/shared/CollabChangedFileList';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';

export interface PersonalChangesPanelPort {
  readonly state: CollabFeatureState;
  inspectProject(
    projectId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabResult<CollabProjectInspection>>;
  subscribe(
    listener: (state: CollabFeatureState) => void,
  ): { dispose(): void };
}

export interface PersonalChangesPanelOptions {
  readonly onInspection?: (result: CollabResult<CollabProjectInspection>) => void;
  readonly onOpenConflict?: (operationId: string) => void;
  readonly onOpenPublicationReview?: (
    review: CollabPublicationReview,
    selectedPath?: string,
  ) => void;
  readonly onOpenWorkingTreeReview?: (
    review: CollabWorkingTreeReview,
    selectedPath?: string,
  ) => void;
  readonly port: PersonalChangesPanelPort;
  readonly project: CollabLocalProjectSummary;
}

type PersonalChangesKind =
  | 'awaiting-request'
  | 'cancelled'
  | 'clean'
  | 'conflict'
  | 'dirty'
  | 'error'
  | 'loading'
  | 'offline'
  | 'publishing'
  | 'review';

interface PersonalChangesViewState {
  readonly changedFiles: readonly CollabChangedFile[];
  readonly conflictOperationId?: string;
  readonly kind: PersonalChangesKind;
  readonly publicationReview?: CollabPublicationReview;
  readonly unpublishedReview?: CollabWorkingTreeReview;
}

interface FocusSnapshot {
  readonly action?: string;
  readonly path?: string;
  readonly scrollTop: number;
}

const EMPTY_STATE: PersonalChangesViewState = {
  changedFiles: [],
  kind: 'loading',
};

const WORKING_TREE_REFRESH_DELAY_MS = 200;

export class PersonalChangesPanel {
  private active = true;
  private destroyed = false;
  private readonly inspectionTasks = new LatestTaskScope();
  private project: CollabLocalProjectSummary;
  private refreshCycle = 0;
  private refreshOnResume = false;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private refreshRequested = false;
  private readonly rootEl: HTMLDivElement;
  private selectedPath: string | null = null;
  private readonly subscription: { dispose(): void };
  private viewState = EMPTY_STATE;
  private workingTreeInspectionVersion = -1;
  private workingTreeInvalidationVersion = 0;
  private workingTreeRefreshTimer: number | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly options: PersonalChangesPanelOptions,
  ) {
    this.project = options.project;
    this.rootEl = containerEl.createDiv({ cls: 'claudian-collab-publish' });
    this.subscription = options.port.subscribe(state => {
      if (this.destroyed || state.selectedProjectId !== this.project.id) return;
      if (!this.active) {
        this.refreshOnResume = true;
        return;
      }
      if (state.activeOperation?.kind === 'publish') {
        this.setView({ ...this.viewState, kind: 'publishing' });
      } else if (this.viewState.kind !== 'loading') {
        this.queueRefresh();
      }
    });
    this.render();
    void this.refresh();
  }

  setActive(active: boolean): boolean {
    if (this.destroyed || this.active === active) return false;
    this.active = active;
    if (!active) {
      const hadWorkingTreeRefresh = this.clearWorkingTreeRefreshTimer();
      this.refreshOnResume = this.refreshOnResume
        || this.refreshPromise !== null
        || hadWorkingTreeRefresh;
      this.refreshCycle += 1;
      this.refreshQueued = false;
      this.refreshRequested = false;
      this.refreshPromise = null;
      this.inspectionTasks.cancel();
      return false;
    }
    if (!this.refreshOnResume) return false;
    this.refreshOnResume = false;
    void this.refresh();
    return true;
  }

  setProject(project: CollabLocalProjectSummary): void {
    if (this.destroyed) return;
    if (this.project.id === project.id) {
      this.clearWorkingTreeRefreshTimer();
      this.project = project;
      void this.refresh();
      return;
    }
    this.refreshCycle += 1;
    this.clearWorkingTreeRefreshTimer();
    this.refreshPromise = null;
    this.refreshRequested = false;
    this.inspectionTasks.cancel();
    this.project = project;
    this.selectedPath = null;
    this.workingTreeInspectionVersion = -1;
    this.workingTreeInvalidationVersion = 0;
    this.viewState = EMPTY_STATE;
    this.render();
    if (this.active) void this.refresh();
    else this.refreshOnResume = true;
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    if (!this.active) {
      this.refreshOnResume = true;
      return;
    }
    this.refreshRequested = true;
    if (this.refreshPromise) return this.refreshPromise;
    const refreshPromise = this.drainRefreshes(this.refreshCycle);
    this.refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    }
  }

  invalidateWorkingTree(): void {
    if (this.destroyed) return;
    this.workingTreeInvalidationVersion += 1;
    if (!this.active) {
      this.clearWorkingTreeRefreshTimer();
      this.refreshOnResume = true;
      return;
    }
    this.clearWorkingTreeRefreshTimer();
    this.workingTreeRefreshTimer = window.setTimeout(() => {
      this.workingTreeRefreshTimer = null;
      void this.refresh();
    }, WORKING_TREE_REFRESH_DELAY_MS);
  }

  private async drainRefreshes(cycle: number): Promise<void> {
    while (
      this.active
      && this.refreshRequested
      && !this.destroyed
      && cycle === this.refreshCycle
    ) {
      this.refreshRequested = false;
      await this.refreshOnce();
    }
  }

  private async refreshOnce(): Promise<void> {
    const task = this.inspectionTasks.start();
    const projectId = this.project.id;
    const workingTreeVersion = this.workingTreeInvalidationVersion;
    try {
      const result = await this.options.port.inspectProject(projectId, {
        signal: task.signal,
      });
      if (!this.isCurrent(task, projectId)) return;
      if (result.status === 'success') {
        this.workingTreeInspectionVersion = Math.max(
          this.workingTreeInspectionVersion,
          workingTreeVersion,
        );
      }
      this.options.onInspection?.(result);
      this.setView(this.viewFromInspection(result));
    } catch {
      if (this.isCurrent(task, projectId)) {
        this.options.onInspection?.({
          error: new CollabError({ code: 'operation-failed' }),
          status: 'failure',
        });
        this.setView({ changedFiles: [], kind: 'error' });
      }
      return;
    } finally {
      task.complete();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearWorkingTreeRefreshTimer();
    this.refreshQueued = false;
    this.refreshRequested = false;
    this.refreshCycle += 1;
    this.inspectionTasks.close();
    this.subscription.dispose();
    this.rootEl.remove();
  }

  private viewFromInspection(
    result: CollabResult<CollabProjectInspection>,
  ): PersonalChangesViewState {
    if (result.status !== 'success') {
      return {
        changedFiles: [],
        kind: result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'conflict'
            ? 'conflict'
            : result.status === 'failure' && result.error.group === 'connectivity'
              ? 'offline'
              : 'error',
      };
    }
    const inspection = result.value;
    const status = inspection.gitStatus;
    const personal = inspection.personalChanges;
    if (!status || !personal) {
      return { changedFiles: [], kind: 'error' };
    }
    const unpublishedReview = personal.unpublishedReview;
    const changedFiles = unpublishedReview.files;
    const ownRequestId = inspection.coordination?.snapshot.openRequests.find(
      request => request.memberId === inspection.coordination?.snapshot.currentMember.id,
    )?.id;
    if (personal.action === 'resolve-changes') {
      if (ownRequestId) {
        return {
          changedFiles,
          kind: changedFiles.length > 0 ? 'dirty' : 'clean',
          unpublishedReview,
        };
      }
      return {
        changedFiles,
        ...(personal.conflictOperationId
          ? { conflictOperationId: personal.conflictOperationId }
          : {}),
        kind: 'conflict',
        unpublishedReview,
      };
    }
    if (personal.action === 'review-and-publish') {
      if (ownRequestId) {
        return {
          changedFiles,
          kind: changedFiles.length > 0 ? 'dirty' : 'clean',
          unpublishedReview,
        };
      }
      return {
        changedFiles,
        kind: 'review',
        ...(personal.review
          ? { publicationReview: personal.review }
          : {}),
        unpublishedReview,
      };
    }
    const offline = inspection.project.connectionStatus === 'offline'
      || inspection.project.connectionStatus === 'host-stopped';
    if (personal.action === 'publish') return {
      changedFiles,
      kind: offline ? 'offline' : 'dirty',
      unpublishedReview,
    };
    if (personal.action === 'retry') {
      return {
        changedFiles,
        kind: 'awaiting-request',
        unpublishedReview,
      };
    }
    return {
      changedFiles,
      kind: 'clean',
      unpublishedReview,
    };
  }

  private render(): void {
    if (this.destroyed) return;
    const focus = this.captureFocus();
    this.rootEl.replaceChildren();
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-publish-header' });
    const canOpenWorkingTree = this.viewState.unpublishedReview !== undefined
      && this.viewState.kind !== 'clean'
      && this.viewState.kind !== 'conflict'
      && this.viewState.kind !== 'loading'
      && this.viewState.kind !== 'publishing'
      && this.viewState.kind !== 'review';
    if (canOpenWorkingTree) {
      const title = header.createEl('button', {
        attr: {
          'aria-label': t('collab.review.title'),
          'data-action': 'review-personal',
          type: 'button',
        },
        cls: 'claudian-collab-publish-title',
        text: t('collab.publish.title'),
      });
      title.disabled = !this.options.onOpenWorkingTreeReview;
      title.addEventListener('click', () => this.openWorkingTreeReview());
    } else {
      header.createEl('h4', { text: t('collab.publish.title') });
    }
    const actions = header.createDiv({ cls: 'claudian-collab-publish-actions' });
    if (this.viewState.kind === 'conflict' && this.viewState.conflictOperationId) {
      const operationId = this.viewState.conflictOperationId;
      const resolve = actions.createEl('button', {
        attr: { 'data-action': 'open-conflict', type: 'button' },
        cls: 'claudian-collab-publish-navigation',
        text: t('collab.conflict.title'),
      });
      resolve.disabled = !this.options.onOpenConflict;
      resolve.addEventListener('click', () => {
        this.options.onOpenConflict?.(operationId);
      });
    } else if (this.viewState.kind === 'review' && this.viewState.publicationReview) {
      const review = actions.createEl('button', {
        attr: { 'data-action': 'open-publication-review', type: 'button' },
        cls: 'claudian-collab-publish-navigation',
        text: t('collab.review.title'),
      });
      review.disabled = !this.options.onOpenPublicationReview;
      review.addEventListener('click', () => {
        if (this.viewState.publicationReview) {
          this.openPublicationReview(this.viewState.publicationReview);
        }
      });
    }
    if (actions.childElementCount === 0) actions.remove();
    if (this.shouldRenderStatus()) {
      this.rootEl.createDiv({
        attr: { 'aria-live': 'polite' },
        cls: `claudian-collab-publish-status claudian-collab-publish-status--${this.viewState.kind}`,
        text: this.statusText(),
      });
    }

    if (this.viewState.changedFiles.length > 0) {
      renderCollabChangedFileList({
        accessibleLabel: t('collab.publish.changedFiles', {
          count: this.viewState.changedFiles.length,
        }),
        container: this.rootEl,
        files: this.viewState.changedFiles,
        focusOnSelect: true,
        onSelect: path => {
          this.selectedPath = path;
          this.openWorkingTreeReview(path);
        },
        selectedPath: this.selectedPath,
        semantics: 'list',
      });
    }

    this.restoreFocus(focus);
  }

  private openWorkingTreeReview(selectedPath?: string): void {
    if (this.workingTreeRefreshTimer !== null
      || this.workingTreeInspectionVersion < this.workingTreeInvalidationVersion) {
      this.clearWorkingTreeRefreshTimer();
      void this.refreshWorkingTreeThenOpen(selectedPath);
      return;
    }
    if (this.refreshPromise) {
      void this.refreshPromise.then(() => this.dispatchWorkingTreeReview(selectedPath));
      return;
    }
    this.dispatchWorkingTreeReview(selectedPath);
  }

  private async refreshWorkingTreeThenOpen(selectedPath?: string): Promise<void> {
    await this.refresh();
    this.dispatchWorkingTreeReview(selectedPath);
  }

  private dispatchWorkingTreeReview(selectedPath?: string): void {
    if (!this.active || this.destroyed) return;
    const review = this.viewState.unpublishedReview;
    if (!review) return;
    const requestedPath = selectedPath ?? this.selectedPath;
    const path = requestedPath && review.files.some(file => file.path === requestedPath)
      ? requestedPath
      : review.files[0]?.path;
    this.options.onOpenWorkingTreeReview?.(review, path);
  }

  private openPublicationReview(
    review: CollabPublicationReview,
    selectedPath?: string,
  ): void {
    if (selectedPath) {
      this.options.onOpenPublicationReview?.(review, selectedPath);
    } else {
      this.options.onOpenPublicationReview?.(review);
    }
  }

  private queueRefresh(): void {
    if (this.destroyed) return;
    if (!this.active) {
      this.refreshOnResume = true;
      return;
    }
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this.destroyed) void this.refresh();
    });
  }

  private clearWorkingTreeRefreshTimer(): boolean {
    if (this.workingTreeRefreshTimer === null) return false;
    window.clearTimeout(this.workingTreeRefreshTimer);
    this.workingTreeRefreshTimer = null;
    return true;
  }

  private statusText(): string {
    switch (this.viewState.kind) {
      case 'loading': return t('collab.publish.loading');
      case 'clean': return t('collab.publish.clean');
      case 'dirty': return t('collab.publish.changedFiles', {
        count: this.viewState.changedFiles.length,
      });
      case 'offline': return t('collab.publish.offline');
      case 'publishing': return t('collab.publish.publishing');
      case 'awaiting-request': return t('collab.publish.awaitingRequest');
      case 'review': return t('collab.review.readyToPublish');
      case 'conflict': return t('collab.publish.conflict');
      case 'cancelled': return t('collab.publish.cancelled');
      case 'error': return t('collab.publish.error');
    }
  }

  private shouldRenderStatus(): boolean {
    return this.viewState.kind !== 'conflict'
      && this.viewState.kind !== 'dirty'
      && this.viewState.kind !== 'review';
  }

  private setView(viewState: PersonalChangesViewState): void {
    this.viewState = viewState;
    this.render();
  }

  private isCurrent(task: LatestTaskHandle, projectId: string): boolean {
    return this.active
      && !this.destroyed
      && task.isCurrent()
      && this.project.id === projectId
      && this.options.port.state.selectedProjectId === projectId;
  }

  private captureFocus(): FocusSnapshot {
    const active = this.rootEl.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.rootEl.contains(active)) {
      return { scrollTop: this.rootEl.scrollTop };
    }
    return {
      action: active.dataset.action,
      path: active.dataset.path,
      scrollTop: this.rootEl.scrollTop,
    };
  }

  private restoreFocus(snapshot: FocusSnapshot): void {
    this.rootEl.scrollTop = snapshot.scrollTop;
    const target = snapshot.path
      ? [...this.rootEl.querySelectorAll<HTMLElement>('[data-path]')]
        .find(element => element.dataset.path === snapshot.path)
      : snapshot.action
        ? this.rootEl.querySelector<HTMLElement>(`[data-action="${snapshot.action}"]`)
        : null;
    target?.focus();
  }
}
