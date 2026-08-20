import type { CollabChangeRequest, CollabOperationId, CollabRequestId } from '@claudian/collab-protocol';

import type { CollabCoordinationSnapshot, CollabFeatureState, CollabLocalProjectSummary, CollabOperationOptions, CollabPublicationReview, CollabRequestReview, CollabResult } from '@/core/collab';
import type { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';
import {
  collabReviewSourceKey,
} from '@/features/collab/handoff/CollabReviewSourceKey';
import { renderCollabChangedFileList } from '@/features/collab/shared/CollabChangedFileList';
import {
  TeamReviewLoader,
  type TeamReviewLoaderPort,
} from '@/features/collab/sidebar/changes/TeamReviewLoader';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';

export interface TeamChangesPanelPort extends TeamReviewLoaderPort {
  readonly state: CollabFeatureState;
  readSnapshot(
    projectId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabCoordinationSnapshot>>;
  subscribe(listener: (state: CollabFeatureState) => void): { dispose(): void };
}

export interface TeamChangesPanelOptions {
  readonly deferInitialRefresh?: boolean;
  readonly onOpenConflict?: (
    operationId: CollabOperationId,
    requestId: string,
  ) => void;
  readonly onOpenFile: (
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot,
    path?: string,
  ) => void;
  readonly onOpenPublicationReview?: (
    review: CollabPublicationReview,
    selectedPath?: string,
  ) => void;
  readonly onReviewIntent?: () => void;
  readonly port: TeamChangesPanelPort;
  readonly preparedReviews?: CollabPreparedReviewCache;
  readonly project: CollabLocalProjectSummary;
}

export interface OwnRequestConflict {
  readonly operationId: CollabOperationId;
  readonly requestId: CollabRequestId;
}

export interface OwnRequestPublicationReview {
  readonly requestId: CollabRequestId;
  readonly review: CollabPublicationReview;
  readonly selectedPath?: string;
}

type OwnRequestActivity = OwnRequestConflict | OwnRequestPublicationReview;

interface TeamViewState {
  readonly kind: 'error' | 'loading' | 'ready';
  readonly snapshot?: CollabCoordinationSnapshot;
}

type ExpandedReviewState =
  | { readonly cacheKey: string; readonly kind: 'error'; readonly requestId: string }
  | { readonly cacheKey: string; readonly kind: 'loading'; readonly requestId: string }
  | {
    readonly cacheKey: string;
    readonly kind: 'ready';
    readonly requestId: string;
    readonly review: CollabRequestReview;
    readonly selectedPath: string | null;
  };

interface FocusSnapshot {
  readonly path?: string;
  readonly requestId?: string;
  readonly scrollTop: number;
}

export class TeamChangesPanel {
  private active = true;
  private destroyed = false;
  private expandedRequestId: string | null = null;
  private expandedReviewState: ExpandedReviewState | null = null;
  private ownRequestActivity: OwnRequestActivity | null = null;
  private project: CollabLocalProjectSummary;
  private refreshQueued = false;
  private refreshOnResume = false;
  private reviewOnResume = false;
  private reviewIntentGeneration = 0;
  private readonly reviewLoader: TeamReviewLoader;
  private readonly rootEl: HTMLDivElement;
  private readonly snapshotTasks = new LatestTaskScope();
  private readonly subscription: { dispose(): void };
  private viewState: TeamViewState = { kind: 'loading' };

  constructor(
    containerEl: HTMLElement,
    private readonly options: TeamChangesPanelOptions,
  ) {
    this.project = options.project;
    this.reviewLoader = new TeamReviewLoader(options.port, options.preparedReviews);
    this.rootEl = containerEl.createDiv({ cls: 'claudian-collab-team' });
    let observedState = options.port.state;
    this.subscription = options.port.subscribe(state => {
      if (state === observedState) return;
      observedState = state;
      if (this.destroyed || state.selectedProjectId !== this.project.id) return;
      if (!this.active) {
        this.refreshOnResume = true;
        return;
      }
      this.queueRefresh();
    });
    this.render();
    if (!options.deferInitialRefresh) void this.refresh();
  }

  setActive(active: boolean, refreshOnResume = true): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.refreshOnResume ||= this.snapshotTasks.active;
      this.refreshQueued = false;
      this.reviewIntentGeneration += 1;
      if (this.expandedReviewState?.kind === 'loading') {
        this.expandedReviewState = null;
        this.reviewOnResume = true;
      }
      this.snapshotTasks.cancel();
      this.reviewLoader.cancelPending();
      return;
    }
    if (this.refreshOnResume) {
      if (refreshOnResume) {
        this.refreshOnResume = false;
        void this.refresh();
      }
      return;
    }
    this.resumeExpandedReview();
  }

  adoptSnapshot(
    snapshot: CollabCoordinationSnapshot,
    ownRequestActivity: OwnRequestActivity | null | undefined = undefined,
  ): void {
    if (this.destroyed || snapshot.snapshot.project.id !== this.project.id) return;
    this.refreshOnResume = false;
    this.snapshotTasks.cancel();
    this.applySnapshot(
      snapshot,
      ownRequestActivity === undefined ? this.ownRequestActivity : ownRequestActivity,
    );
  }

  adoptOwnRequestConflict(conflict: OwnRequestConflict | null): void {
    if (this.destroyed) return;
    const snapshot = this.viewState.snapshot;
    this.ownRequestActivity = snapshot && conflict
      ? this.validOwnRequestActivity(conflict, snapshot)
      : conflict;
    this.render();
  }

  adoptOwnRequestPublicationReview(
    publication: OwnRequestPublicationReview | null,
  ): void {
    if (this.destroyed) return;
    const snapshot = this.viewState.snapshot;
    this.ownRequestActivity = snapshot && publication
      ? this.validOwnRequestActivity(publication, snapshot)
      : publication;
    this.render();
  }

  setProject(project: CollabLocalProjectSummary): void {
    if (this.destroyed) return;
    if (project.id === this.project.id) {
      this.project = project;
      this.queueRefresh();
      return;
    }
    this.reviewIntentGeneration += 1;
    this.snapshotTasks.cancel();
    this.reviewLoader.cancelPending();
    this.expandedRequestId = null;
    this.expandedReviewState = null;
    this.reviewOnResume = false;
    this.ownRequestActivity = null;
    this.project = project;
    this.viewState = { kind: 'loading' };
    this.render();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    if (!this.active) {
      this.refreshOnResume = true;
      return;
    }
    this.refreshOnResume = false;
    const task = this.snapshotTasks.start();
    const projectId = this.project.id;
    try {
      const result = await this.options.port.readSnapshot(projectId, {
        signal: task.signal,
      });
      if (!this.isCurrent(task, projectId)) return;
      if (result.status !== 'success') {
        this.viewState = { kind: 'error' };
        this.render();
        return;
      }
      this.applySnapshot(result.value, this.ownRequestActivity);
    } catch {
      if (this.isCurrent(task, projectId)) {
        this.viewState = { kind: 'error' };
        this.render();
      }
      return;
    } finally {
      task.complete();
    }
  }

  private applySnapshot(
    snapshot: CollabCoordinationSnapshot,
    ownRequestActivity: OwnRequestActivity | null,
  ): void {
    this.reviewOnResume = false;
    this.viewState = { kind: 'ready', snapshot };
    this.ownRequestActivity = ownRequestActivity
      ? this.validOwnRequestActivity(ownRequestActivity, snapshot)
      : null;
    this.reviewLoader.update(this.project.id, snapshot);
    const previousCacheKey = this.expandedReviewState?.cacheKey;
    const request = this.reconcileExpandedRequest(snapshot);
    this.render();
    const readyState = this.expandedReviewState?.kind === 'ready'
      ? this.expandedReviewState
      : null;
    if (readyState && readyState.cacheKey !== previousCacheKey) {
      this.options.onOpenFile(
        readyState.review,
        snapshot,
        readyState.selectedPath ?? undefined,
      );
    }
    if (request) {
      void this.loadReview(request, snapshot, this.reviewIntentGeneration);
    }
  }

  private resumeExpandedReview(): void {
    if (!this.reviewOnResume) return;
    const coordination = this.viewState.snapshot;
    if (!coordination) {
      this.refreshOnResume = true;
      return;
    }
    this.reviewOnResume = false;
    const request = this.reconcileExpandedRequest(coordination);
    this.render();
    const readyState = this.expandedReviewState?.kind === 'ready'
      ? this.expandedReviewState
      : null;
    if (readyState) {
      this.options.onOpenFile(
        readyState.review,
        coordination,
        readyState.selectedPath ?? undefined,
      );
    }
    if (request) {
      void this.loadReview(request, coordination, this.reviewIntentGeneration);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reviewIntentGeneration += 1;
    this.snapshotTasks.close();
    this.reviewLoader.destroy();
    this.subscription.dispose();
    this.rootEl.remove();
  }

  private render(): void {
    const focus = this.captureFocus();
    this.rootEl.replaceChildren();
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-team-header' });
    header.createEl('h4', { text: t('collab.team.title') });
    if (this.viewState.kind === 'loading') {
      this.rootEl.createDiv({ text: t('collab.team.loading') });
      this.restoreFocus(focus);
      return;
    }
    if (this.viewState.kind === 'error' || !this.viewState.snapshot) {
      this.rootEl.createDiv({
        cls: 'claudian-collab-team-status mod-warning',
        text: t('collab.team.loadFailed'),
      });
      const retry = this.rootEl.createEl('button', {
        attr: { 'data-action': 'retry-team-changes', type: 'button' },
        text: t('collab.team.retry'),
      });
      retry.addEventListener('click', () => void this.refresh());
      this.restoreFocus(focus);
      return;
    }

    const coordination = this.viewState.snapshot;
    const requests = [...coordination.snapshot.openRequests]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    header.createSpan({
      cls: 'claudian-collab-team-count',
      text: String(requests.length),
    });
    if (coordination.stale) {
      this.rootEl.createDiv({
        cls: 'claudian-collab-team-status',
        text: t('collab.team.stale'),
      });
    }
    if (requests.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-collab-team-empty',
        text: t('collab.team.empty'),
      });
      this.restoreFocus(focus);
      return;
    }
    const names = new Map(
      coordination.snapshot.members.map(member => [member.id, member.displayName]),
    );
    const list = this.rootEl.createDiv({ cls: 'claudian-collab-team-list' });
    for (const request of requests) {
      const memberName = names.get(request.memberId) ?? t('collab.team.unknownMember');
      const displayName = request.memberId === coordination.snapshot.currentMember.id
        ? t('collab.team.ownMember')
        : memberName;
      const conflict = this.conflictFor(request);
      const expanded = request.id === this.expandedRequestId;
      const item = list.createDiv({ cls: 'claudian-collab-team-request-item' });
      const bodyId = `claudian-collab-request-${request.id}`;
      const row = item.createEl('button', {
        attr: {
          'aria-controls': bodyId,
          'aria-expanded': String(expanded),
          'data-request-id': request.id,
          type: 'button',
        },
        cls: 'claudian-collab-team-request',
      });
      row.createSpan({
        cls: 'claudian-collab-team-member',
        text: displayName,
      });
      if (conflict) {
        row.createSpan({
          cls: 'claudian-collab-team-request-conflict',
          text: t('collab.conflict.title'),
        });
      }
      row.addEventListener('click', () => this.toggleRequest(request, coordination));
      if (!conflict && !this.publicationFor(request)) {
        row.addEventListener('pointerenter', () => this.options.onReviewIntent?.());
        row.addEventListener('focus', () => this.options.onReviewIntent?.());
      }
      if (expanded) this.renderExpandedReview(item, bodyId, request, coordination);
    }
    this.restoreFocus(focus);
  }

  private renderExpandedReview(
    item: HTMLElement,
    bodyId: string,
    request: CollabChangeRequest,
    coordination: CollabCoordinationSnapshot,
  ): void {
    const body = item.createDiv({
      attr: { id: bodyId },
      cls: 'claudian-collab-team-request-body',
    });
    const conflict = this.conflictFor(request);
    if (conflict) {
      const resolve = body.createEl('button', {
        attr: { 'data-action': 'resolve-request-conflict', type: 'button' },
        cls: 'claudian-collab-team-request-resolve',
        text: t('collab.conflict.title'),
      });
      resolve.disabled = !this.options.onOpenConflict;
      resolve.addEventListener('click', () => {
        this.options.onOpenConflict?.(conflict.operationId, request.id);
      });
      return;
    }
    const publication = this.publicationFor(request);
    if (publication) {
      const selectedPath = publication.selectedPath
        ?? publication.review.files[0]?.path;
      renderCollabChangedFileList({
        accessibleLabel: t('collab.publish.changedFiles', {
          count: publication.review.files.length,
        }),
        container: body,
        files: publication.review.files,
        focusOnSelect: false,
        onSelect: path => {
          const currentSelection = this.publicationFor(request)?.selectedPath
            ?? publication.review.files[0]?.path;
          if (path !== currentSelection) {
            this.ownRequestActivity = { ...publication, selectedPath: path };
          }
          this.options.onOpenPublicationReview?.(publication.review, path);
        },
        selectedPath,
        semantics: 'flat',
      });
      if (publication.review.files.length === 0) {
        body.createDiv({
          cls: 'claudian-collab-team-request-status',
          text: t('collab.review.noFiles'),
        });
      }
      return;
    }
    const state = this.expandedReviewState;
    if (!state || state.requestId !== request.id || state.kind === 'loading') {
      body.createDiv({
        attr: { 'aria-live': 'polite' },
        cls: 'claudian-collab-team-request-status',
        text: t('collab.review.loading'),
      });
      return;
    }
    if (state.kind === 'error') {
      body.createDiv({
        cls: 'claudian-collab-team-request-status mod-warning',
        text: t('collab.review.loadFailed'),
      });
      const retry = body.createEl('button', {
        attr: { 'data-action': 'retry-review', type: 'button' },
        text: t('collab.team.retry'),
      });
      retry.addEventListener('click', () => {
        const intentGeneration = ++this.reviewIntentGeneration;
        this.expandedReviewState = {
          cacheKey: this.reviewLoader.currentKey(request.id)
            ?? this.reviewCacheKey(request, coordination),
          kind: 'loading',
          requestId: request.id,
        };
        this.render();
        void this.loadReview(request, coordination, intentGeneration);
      });
      return;
    }

    const { review } = state;
    renderCollabChangedFileList({
      accessibleLabel: t('collab.publish.changedFiles', {
        count: review.files.length,
      }),
      container: body,
      files: review.files,
      focusOnSelect: false,
      onSelect: path => {
        const currentSelection = this.expandedReviewState?.kind === 'ready'
          ? this.expandedReviewState.selectedPath
          : null;
        if (path !== currentSelection) {
          this.expandedReviewState = { ...state, selectedPath: path };
        }
        this.options.onOpenFile(review, coordination, path);
      },
      selectedPath: state.selectedPath,
      semantics: 'flat',
    });
    if (review.files.length === 0) {
      body.createDiv({
        cls: 'claudian-collab-team-request-status',
        text: t('collab.review.noFiles'),
      });
    }
  }

  private toggleRequest(
    request: CollabChangeRequest,
    coordination: CollabCoordinationSnapshot,
  ): void {
    const intentGeneration = ++this.reviewIntentGeneration;
    if (request.id === this.expandedRequestId) {
      this.reviewLoader.cancelPending();
      this.expandedRequestId = null;
      this.expandedReviewState = null;
      this.render();
      return;
    }

    const conflict = this.conflictFor(request);
    if (conflict) {
      this.reviewLoader.cancelPending();
      this.expandedRequestId = request.id;
      this.expandedReviewState = null;
      this.render();
      this.options.onOpenConflict?.(conflict.operationId, request.id);
      return;
    }

    const publication = this.publicationFor(request);
    if (publication) {
      this.reviewLoader.cancelPending();
      const selectedPath = publication.selectedPath
        ?? publication.review.files[0]?.path;
      this.ownRequestActivity = selectedPath
        ? { ...publication, selectedPath }
        : publication;
      this.expandedRequestId = request.id;
      this.expandedReviewState = null;
      this.render();
      this.options.onOpenPublicationReview?.(publication.review, selectedPath);
      return;
    }

    this.options.onReviewIntent?.();

    this.expandedRequestId = request.id;
    const cacheKey = this.reviewLoader.currentKey(request.id)
      ?? this.reviewCacheKey(request, coordination);
    const cached = this.reviewLoader.peek(request.id);
    if (cached?.kind === 'ready') {
      void this.reviewLoader.select(request.id);
      const selectedPath = cached.review.files[0]?.path ?? null;
      this.expandedReviewState = {
        cacheKey,
        kind: 'ready',
        requestId: request.id,
        review: cached.review,
        selectedPath,
      };
      this.render();
      this.options.onOpenFile(cached.review, coordination, selectedPath ?? undefined);
      return;
    }
    this.expandedReviewState = { cacheKey, kind: 'loading', requestId: request.id };
    this.render();
    void this.loadReview(request, coordination, intentGeneration);
  }

  private async loadReview(
    request: CollabChangeRequest,
    coordination: CollabCoordinationSnapshot,
    intentGeneration: number,
  ): Promise<void> {
    const cacheKey = this.reviewLoader.currentKey(request.id)
      ?? this.reviewCacheKey(request, coordination);
    const result = await this.reviewLoader.load(request.id);
    if (
      this.destroyed
      || intentGeneration !== this.reviewIntentGeneration
      || this.expandedRequestId !== request.id
      || this.reviewLoader.currentKey(request.id) !== cacheKey
    ) return;
    if (result.kind === 'stale') {
      this.queueRefresh();
      return;
    }
    if (result.kind === 'error') {
      this.expandedReviewState = { cacheKey, kind: 'error', requestId: request.id };
      this.render();
      return;
    }
    const { review } = result;
    const selectedPath = review.files[0]?.path ?? null;
    this.expandedReviewState = {
      cacheKey,
      kind: 'ready',
      requestId: request.id,
      review,
      selectedPath,
    };
    this.render();
    this.options.onOpenFile(review, coordination, selectedPath ?? undefined);
  }

  private reconcileExpandedRequest(
    coordination: CollabCoordinationSnapshot,
  ): CollabChangeRequest | null {
    const requests = coordination.snapshot.openRequests;
    const currentIds = new Set(requests.map(request => request.id));
    if (!this.expandedRequestId || !currentIds.has(this.expandedRequestId)) {
      this.expandedRequestId = null;
      this.expandedReviewState = null;
      return null;
    }
    const request = requests.find(candidate => candidate.id === this.expandedRequestId)!;
    if (this.conflictFor(request) || this.publicationFor(request)) {
      this.expandedReviewState = null;
      return null;
    }
    const cacheKey = this.reviewLoader.currentKey(request.id)
      ?? this.reviewCacheKey(request, coordination);
    if (this.expandedReviewState?.cacheKey === cacheKey) return null;
    const cached = this.reviewLoader.peek(request.id);
    if (cached?.kind === 'ready') {
      const selectedPath = cached.review.files[0]?.path ?? null;
      this.expandedReviewState = {
        cacheKey,
        kind: 'ready',
        requestId: request.id,
        review: cached.review,
        selectedPath,
      };
      return null;
    }
    this.expandedReviewState = { cacheKey, kind: 'loading', requestId: request.id };
    return request;
  }

  private reviewCacheKey(
    request: CollabChangeRequest,
    coordination: CollabCoordinationSnapshot,
  ): string {
    return collabReviewSourceKey(this.project.id, request, {
      currentMemberId: coordination.snapshot.currentMember.id,
      currentMemberRole: coordination.snapshot.currentMember.role,
      mainOid: coordination.snapshot.project.mainOid,
    });
  }

  private conflictFor(request: CollabChangeRequest): OwnRequestConflict | null {
    return this.ownRequestActivity
      && 'operationId' in this.ownRequestActivity
      && this.ownRequestActivity.requestId === request.id
      ? this.ownRequestActivity
      : null;
  }

  private publicationFor(
    request: CollabChangeRequest,
  ): OwnRequestPublicationReview | null {
    return this.ownRequestActivity
      && 'review' in this.ownRequestActivity
      && this.ownRequestActivity.requestId === request.id
      ? this.ownRequestActivity
      : null;
  }

  private validOwnRequestActivity<T extends OwnRequestActivity>(
    activity: T,
    coordination: CollabCoordinationSnapshot,
  ): T | null {
    const currentMemberId = coordination.snapshot.currentMember.id;
    const request = coordination.snapshot.openRequests.find(
      candidate => candidate.id === activity.requestId,
    );
    if (request?.memberId !== currentMemberId) return null;
    if ('review' in activity && activity.review.projectId !== this.project.id) return null;
    return activity;
  }

  private queueRefresh(): void {
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

  private captureFocus(): FocusSnapshot {
    const active = this.rootEl.ownerDocument.activeElement;
    return {
      path: active instanceof HTMLElement && this.rootEl.contains(active)
        ? active.dataset.path
        : undefined,
      requestId: active instanceof HTMLElement && this.rootEl.contains(active)
        ? active.dataset.requestId
        : undefined,
      scrollTop: this.rootEl.scrollTop,
    };
  }

  private restoreFocus(snapshot: FocusSnapshot): void {
    this.rootEl.scrollTop = snapshot.scrollTop;
    const attribute = snapshot.path ? 'path' : snapshot.requestId ? 'requestId' : null;
    const value = snapshot.path ?? snapshot.requestId;
    if (!attribute || !value) return;
    [...this.rootEl.querySelectorAll<HTMLElement>(`[data-${attribute === 'path' ? 'path' : 'request-id'}]`)]
      .find(candidate => candidate.dataset[attribute] === value)
      ?.focus();
  }

  private isCurrent(task: LatestTaskHandle, projectId: string): boolean {
    return this.active
      && !this.destroyed
      && task.isCurrent()
      && projectId === this.project.id;
  }

}
