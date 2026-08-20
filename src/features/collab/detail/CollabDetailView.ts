import {
  ItemView,
  MarkdownRenderer,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import type {
  CollabConflictDetailViewState,
  CollabDetailConflictPanelFactory,
  CollabDetailViewPort,
  CollabDetailViewState,
  CollabReviewDetailViewState,
  CollabTicketDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
import {
  CollabConflictResolutionPanel,
} from '@/features/collab/detail/conflict/CollabConflictResolutionPanel';
import {
  type CollabDetailDiffPort,
  type CollabDetailObjectUrlPort,
  ReviewDiffSession,
} from '@/features/collab/detail/review/ReviewDiffSession';
import { ConflictDetailSession } from '@/features/collab/detail/sessions/ConflictDetailSession';
import {
  assertReviewMatchesState,
  ReviewDetailSession,
} from '@/features/collab/detail/sessions/ReviewDetailSession';
import { TicketDetailSession } from '@/features/collab/detail/sessions/TicketDetailSession';
import type {
  CollabPreparedReviewCache,
  CollabPreparedReviewEntry,
} from '@/features/collab/handoff/CollabPreparedReviewCache';
import { t } from '@/i18n/i18n';

export const COLLAB_DETAIL_VIEW_TYPE = 'claudian-collab-detail';

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type {
  CollabConflictDetailViewState,
  CollabDetailConflictPanel,
  CollabDetailConflictPanelFactory,
  CollabDetailViewPort,
  CollabDetailViewState,
  CollabPublicationDetailViewState,
  CollabRequestDetailViewState,
  CollabTicketDetailViewState,
  CollabWorkingTreeDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
export type {
  CollabDetailDiffPort,
  CollabDetailObjectUrlPort,
} from '@/features/collab/detail/review/ReviewDiffSession';

export interface CollabDetailViewOptions {
  readonly conflictPanelFactory?: CollabDetailConflictPanelFactory;
  readonly objectUrls?: CollabDetailObjectUrlPort;
  readonly openProjectFile?: (projectId: string, path: string) => Promise<void>;
  readonly openTicketInNewTab?: (projectId: string, ticketId: string) => Promise<void>;
  readonly preparedReviews?: CollabPreparedReviewCache;
  readonly renderer?: CollabDetailDiffPort;
  readonly rendererFactory?: () => CollabDetailDiffPort;
}

export interface CollabDetailWorkspacePort {
  getLeaf(type: 'tab'): WorkspaceLeaf | null;
  getLeavesOfType(type: string): readonly WorkspaceLeaf[];
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
}

class BrowserObjectUrlPort implements CollabDetailObjectUrlPort {
  create(bytes: Uint8Array, mimeType: string): string {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return URL.createObjectURL(new Blob([copy.buffer], { type: mimeType }));
  }

  revoke(url: string): void {
    URL.revokeObjectURL(url);
  }
}

function viewError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

function isSafePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\u0000')
    && value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function parseState(value: unknown): CollabDetailViewState {
  if (!value || typeof value !== 'object') throw viewError('review-view-state-invalid');
  const state = value as Record<string, unknown>;
  if (state.kind === 'ticket') {
    if (
      typeof state.projectId !== 'string'
      || !ID_PATTERN.test(state.projectId)
      || (state.ticketId !== undefined && (
        typeof state.ticketId !== 'string' || !ID_PATTERN.test(state.ticketId)
      ))
    ) {
      throw viewError('review-view-state-invalid');
    }
    return {
      kind: 'ticket',
      projectId: state.projectId,
      ...(typeof state.ticketId === 'string' ? { ticketId: state.ticketId } : {}),
    };
  }
  if (state.kind === 'conflict') {
    if (
      typeof state.projectId !== 'string'
      || !ID_PATTERN.test(state.projectId)
      || typeof state.operationId !== 'string'
      || !ID_PATTERN.test(state.operationId)
      || (state.location !== 'my-changes' && state.location !== 'request')
      || (state.location === 'request' && (
        typeof state.requestId !== 'string' || !ID_PATTERN.test(state.requestId)
      ))
      || (state.location === 'my-changes' && state.requestId !== undefined)
    ) {
      throw viewError('review-view-state-invalid');
    }
    return {
      kind: state.kind,
      location: state.location,
      operationId: state.operationId,
      projectId: state.projectId,
      ...(state.location === 'request' ? { requestId: state.requestId as string } : {}),
    };
  }
  if (state.kind === 'publication') {
    if (
      typeof state.projectId !== 'string'
      || !ID_PATTERN.test(state.projectId)
      || typeof state.operationId !== 'string'
      || !ID_PATTERN.test(state.operationId)
      || typeof state.currentMainOid !== 'string'
      || !OID_PATTERN.test(state.currentMainOid)
      || typeof state.candidateOid !== 'string'
      || !OID_PATTERN.test(state.candidateOid)
      || typeof state.comparisonBaseOid !== 'string'
      || !OID_PATTERN.test(state.comparisonBaseOid)
      || typeof state.comparisonTargetOid !== 'string'
      || !OID_PATTERN.test(state.comparisonTargetOid)
      || (state.selectedPath !== undefined && !isSafePath(state.selectedPath))
    ) {
      throw viewError('review-view-state-invalid');
    }
    return {
      candidateOid: state.candidateOid,
      comparisonBaseOid: state.comparisonBaseOid,
      comparisonTargetOid: state.comparisonTargetOid,
      currentMainOid: state.currentMainOid,
      kind: state.kind,
      operationId: state.operationId,
      projectId: state.projectId,
      ...(state.selectedPath === undefined ? {} : { selectedPath: state.selectedPath }),
    };
  }
  if (state.kind === 'working-tree') {
    if (
      typeof state.projectId !== 'string'
      || !ID_PATTERN.test(state.projectId)
      || typeof state.baseOid !== 'string'
      || !OID_PATTERN.test(state.baseOid)
      || typeof state.headOid !== 'string'
      || !OID_PATTERN.test(state.headOid)
      || typeof state.snapshotId !== 'string'
      || !OID_PATTERN.test(state.snapshotId)
      || (state.selectedPath !== undefined && !isSafePath(state.selectedPath))
    ) {
      throw viewError('review-view-state-invalid');
    }
    return {
      baseOid: state.baseOid,
      headOid: state.headOid,
      kind: state.kind,
      projectId: state.projectId,
      ...(state.selectedPath === undefined ? {} : { selectedPath: state.selectedPath }),
      snapshotId: state.snapshotId,
    };
  }
  if (
    state.kind !== 'request'
    || typeof state.projectId !== 'string'
    || !ID_PATTERN.test(state.projectId)
    || typeof state.requestId !== 'string'
    || !ID_PATTERN.test(state.requestId)
    || typeof state.comparisonBaseOid !== 'string'
    || !OID_PATTERN.test(state.comparisonBaseOid)
    || typeof state.comparisonTargetOid !== 'string'
    || !OID_PATTERN.test(state.comparisonTargetOid)
    || typeof state.reviewedMainOid !== 'string'
    || !OID_PATTERN.test(state.reviewedMainOid)
    || typeof state.reviewedHeadOid !== 'string'
    || !OID_PATTERN.test(state.reviewedHeadOid)
    || (state.selectedPath !== undefined && !isSafePath(state.selectedPath))
  ) {
    throw viewError('review-view-state-invalid');
  }
  return {
    comparisonBaseOid: state.comparisonBaseOid,
    comparisonTargetOid: state.comparisonTargetOid,
    kind: state.kind,
    projectId: state.projectId,
    requestId: state.requestId,
    reviewedHeadOid: state.reviewedHeadOid,
    reviewedMainOid: state.reviewedMainOid,
    ...(state.selectedPath === undefined ? {} : { selectedPath: state.selectedPath }),
  };
}

export class CollabDetailView extends ItemView {
  private conflictSession: ConflictDetailSession | null = null;
  private readonly conflictPanelFactory: CollabDetailConflictPanelFactory;
  private readonly diffSession: ReviewDiffSession;
  private featureSubscription: { dispose(): void } | null = null;
  private readonly openTicketInNewTab: CollabDetailViewOptions['openTicketInNewTab'];
  private readonly preparedReviews: CollabPreparedReviewCache | null;
  private reviewSession: ReviewDetailSession | null = null;
  private state: CollabDetailViewState | null = null;
  private ticketSession: TicketDetailSession | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly port: CollabDetailViewPort,
    options: CollabDetailViewOptions = {},
  ) {
    super(leaf);
    this.openTicketInNewTab = options.openTicketInNewTab;
    this.preparedReviews = options.preparedReviews ?? null;
    this.diffSession = new ReviewDiffSession({
      objectUrls: options.objectUrls ?? new BrowserObjectUrlPort(),
      ...(options.openProjectFile ? { openProjectFile: options.openProjectFile } : {}),
      onSelectedPath: path => this.reviewSession?.selectPath(path),
      port,
      ...(options.renderer ? { renderer: options.renderer } : {}),
      ...(options.rendererFactory ? { rendererFactory: options.rendererFactory } : {}),
    });
    this.conflictPanelFactory = options.conflictPanelFactory ?? ((root, port, panelOptions) => (
      new CollabConflictResolutionPanel(root, port, panelOptions)
    ));
  }

  getViewType(): string {
    return COLLAB_DETAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    if (this.state?.kind === 'ticket') {
      return this.ticketSession?.displayText ?? t('collab.tickets.editorTitle');
    }
    if (this.state?.kind === 'conflict') return t('collab.conflict.title');
    return this.reviewSession?.displayText ?? t('collab.review.title');
  }

  getIcon(): string {
    return this.state?.kind === 'ticket' ? 'circle-dot' : 'git-pull-request';
  }

  getState(): Record<string, unknown> {
    return this.state ? { ...this.state } : {};
  }

  async setState(value: unknown, result: ViewStateResult): Promise<void> {
    const state = parseState(value);
    result.history = true;
    if (!this.port.isDetailAdmissionOpen()) {
      // A restored leaf before workspace-layout readiness may keep its parsed
      // state but must not activate, subscribe, or read; startup detaches it
      // once the layout is ready.
      if (this.ticketSession || this.conflictSession || this.reviewSession) {
        this.cancelWork();
      }
      this.state = state;
      return;
    }
    if (state.kind === 'conflict') {
      this.activateMode('conflict');
      this.state = state;
      await this.loadConflict(state);
    } else if (state.kind === 'ticket') {
      this.activateMode('ticket');
      this.state = state;
      await this.loadTicket(state);
    } else {
      this.activateMode(state.kind);
      this.state = state;
      await this.loadReview(state);
    }
  }

  async onOpen(): Promise<void> {
    if (!this.port.isDetailAdmissionOpen()) return;
    this.featureSubscription ??= this.port.subscribe(() => {
      const state = this.state;
      if (state?.kind === 'ticket') void this.loadTicket(state);
      if (state?.kind === 'request') void this.reviewSession?.refresh();
    });
    this.contentEl.replaceChildren();
    this.contentEl.classList.add('claudian-collab-review');
    if (this.state) {
      if (this.state.kind === 'conflict') {
        await this.loadConflict(this.state);
      } else if (this.state.kind === 'ticket') {
        await this.loadTicket(this.state);
      } else {
        await this.loadReview(this.state);
      }
    } else {
      this.renderMessage(t('collab.review.openRequest'));
    }
  }

  private async loadTicket(state: CollabTicketDetailViewState): Promise<void> {
    this.diffSession.clear();
    const session = this.ticketSession ?? new TicketDetailSession({
      navigate: next => this.leaf.setViewState({
        active: true,
        state: { ...next },
        type: COLLAB_DETAIL_VIEW_TYPE,
      }),
      ...(this.openTicketInNewTab ? { openTicketInNewTab: this.openTicketInNewTab } : {}),
      port: this.port,
      renderMarkdown: (markdown, host) => MarkdownRenderer.render(
        this.app,
        markdown,
        host,
        '',
        this,
      ),
      rootEl: this.contentEl,
    });
    this.ticketSession = session;
    await session.open(state);
  }
  async onClose(): Promise<void> {
    this.cancelWork();
    this.diffSession.destroy();
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    this.contentEl.replaceChildren();
  }

  private async loadConflict(state: CollabConflictDetailViewState): Promise<void> {
    this.diffSession.clear();
    const session = this.conflictSession ?? new ConflictDetailSession({
      factory: this.conflictPanelFactory,
      port: this.port,
      rootEl: this.contentEl,
    });
    this.conflictSession = session;
    await session.open(state);
  }
  private async loadReview(state: CollabReviewDetailViewState): Promise<void> {
    const session = this.reviewSession ?? new ReviewDetailSession({
      app: this.app,
      component: this,
      diffSession: this.diffSession,
      leaf: this.leaf,
      ...(this.openTicketInNewTab ? { openTicketInNewTab: this.openTicketInNewTab } : {}),
      onStateChange: next => {
        this.state = next;
      },
      port: this.port,
      ...(this.preparedReviews ? { preparedReviews: this.preparedReviews } : {}),
      rootEl: this.contentEl,
      viewType: COLLAB_DETAIL_VIEW_TYPE,
    });
    this.reviewSession = session;
    await session.setState(state);
  }

  private renderMessage(message: string, warning = false): void {
    this.contentEl.replaceChildren();
    this.diffSession.clear();
    this.contentEl.createDiv({
      cls: warning ? `claudian-collab-review-empty is-warning` : `claudian-collab-review-empty`,
      text: message,
    });
  }

  private activateMode(kind: CollabDetailViewState['kind']): void {
    if (kind === 'ticket' && this.ticketSession) return;
    if (kind === 'conflict' && this.conflictSession) return;
    if (
      kind !== 'ticket'
      && kind !== 'conflict'
      && this.reviewSession?.kind === kind
    ) return;
    this.cancelWork({
      retainReviewDiff: kind !== 'ticket' && kind !== 'conflict' && this.reviewSession !== null,
    });
  }

  private cancelWork(options: { readonly retainReviewDiff?: boolean } = {}): void {
    this.ticketSession?.destroy();
    this.ticketSession = null;
    this.conflictSession?.destroy();
    this.conflictSession = null;
    this.reviewSession?.destroy({ retainDiff: options.retainReviewDiff });
    this.reviewSession = null;
    this.contentEl.classList.remove('claudian-collab-conflict');
    if (!options.retainReviewDiff) this.diffSession.clear();
  }

}

export class CollabDetailViewCoordinator {
  private generation = 0;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: CollabDetailWorkspacePort,
    private readonly preparedReviews?: CollabPreparedReviewCache,
  ) {}

  async close(): Promise<void> {
    const generation = ++this.generation;
    const transition = this.transitionTail.then(() => {
      if (generation !== this.generation) return;
      for (const leaf of this.workspace.getLeavesOfType(COLLAB_DETAIL_VIEW_TYPE)) {
        leaf.detach();
      }
    });
    this.transitionTail = transition.catch(() => undefined);
    return transition;
  }

  async open(
    state: CollabDetailViewState,
    prepared?: CollabPreparedReviewEntry,
  ): Promise<void> {
    const safeState = parseState(state);
    if (safeState.kind === 'request' && prepared) {
      assertReviewMatchesState(prepared.review, safeState);
    }
    const generation = ++this.generation;
    const transition = this.transitionTail.then(async () => {
      if (generation !== this.generation) return;
      if (safeState.kind === 'request' && prepared) {
        this.preparedReviews?.store(prepared);
      }
      const existing = this.workspace.getLeavesOfType(COLLAB_DETAIL_VIEW_TYPE)[0];
      const leaf = existing ?? this.workspace.getLeaf('tab');
      if (!leaf) throw viewError('review-leaf-unavailable');
      if (generation !== this.generation) return;
      await leaf.setViewState({
        active: true,
        state: { ...safeState },
        type: COLLAB_DETAIL_VIEW_TYPE,
      });
      if (generation !== this.generation) return;
      await this.workspace.revealLeaf(leaf);
    });
    this.transitionTail = transition.catch(() => undefined);
    return transition;
  }

  async openInNewTab(state: CollabDetailViewState): Promise<void> {
    const safeState = parseState(state);
    const generation = ++this.generation;
    const transition = this.transitionTail.then(async () => {
      if (generation !== this.generation) return;
      const leaf = this.workspace.getLeaf('tab');
      if (!leaf) throw viewError('review-leaf-unavailable');
      if (generation !== this.generation) return;
      await leaf.setViewState({
        active: true,
        state: { ...safeState },
        type: COLLAB_DETAIL_VIEW_TYPE,
      });
      if (generation !== this.generation) return;
      await this.workspace.revealLeaf(leaf);
    });
    this.transitionTail = transition.catch(() => undefined);
    return transition;
  }
}
