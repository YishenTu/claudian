import { type CollabChangeRequest, type CollabComment } from '@claudian-collab/protocol';
import {
  type App,
  type Component,
  MarkdownRenderer,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { type CollabAcceptRequest, type CollabConflictDescriptor, type CollabCoordinationSnapshot, type CollabPublicationReview, type CollabRequestReview, type CollabResult, type CollabWorkingTreeReview } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type {
  CollabConflictDetailViewState,
  CollabDetailViewPort,
  CollabPublicationDetailViewState,
  CollabRequestDetailViewState,
  CollabReviewDetailViewState,
} from '@/features/collab/detail/CollabDetailContracts';
import type { ReviewDiffSession } from '@/features/collab/detail/review/ReviewDiffSession';
import {
  type CollabDisplayReview,
  isPublicationReview,
  isRequestReview,
  isWorkingTreeReview,
  reviewsShareIdentity,
} from '@/features/collab/detail/review/ReviewDiffSession';
import {
  TicketReferenceResolver,
} from '@/features/collab/detail/sessions/TicketReferenceResolver';
import type {
  CollabPreparedReviewCache,
} from '@/features/collab/handoff/CollabPreparedReviewCache';
import {
  CollabCommentComposer,
  renderCollabComment,
} from '@/features/collab/shared/markdown/CollabCommentUI';
import { MarkdownDraftEditor } from '@/features/collab/shared/markdown/MarkdownDraftEditor';
import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';
import { t } from '@/i18n/i18n';

type ReviewMutationKind = 'accept' | 'comment' | 'description';
type AcceptMutation = Omit<CollabAcceptRequest, 'intentId'>;

export type ReviewDetailSessionPort = Pick<
  CollabDetailViewPort,
  | 'acceptRequest'
  | 'addComment'
  | 'addTicketComment'
  | 'closeTicket'
  | 'confirmPublish'
  | 'createTicket'
  | 'listTickets'
  | 'preparePublicationReview'
  | 'prepareReview'
  | 'prepareWorkingTreeReview'
  | 'publish'
  | 'readPublishDescription'
  | 'readSnapshot'
  | 'readTicket'
  | 'reopenTicket'
  | 'updateRequestMetadata'
  | 'updateTicketContent'
>;

export interface ReviewDetailSessionOptions {
  readonly app: App;
  readonly component: Component;
  readonly diffSession: ReviewDiffSession;
  readonly leaf: WorkspaceLeaf;
  readonly openTicketInNewTab?: (projectId: string, ticketId: string) => Promise<void>;
  readonly onStateChange?: (state: CollabReviewDetailViewState) => void;
  readonly port: ReviewDetailSessionPort;
  readonly preparedReviews?: CollabPreparedReviewCache;
  readonly rootEl: HTMLElement;
  readonly viewType: string;
}

export class ReviewDetailSession {
  private acceptController: AbortController | null = null;
  private coordination: CollabCoordinationSnapshot | null = null;
  private contentHostEl: HTMLElement | null = null;
  private descriptionEditor: MarkdownDraftEditor | null = null;
  private generation = 0;
  private memberNames: ReadonlyMap<string, string> = new Map();
  private readonly mutationIntents = new MutationIntentStore<ReviewMutationKind>();
  private readonly openTicketInNewTab?: (projectId: string, ticketId: string) => Promise<void>;
  private readonly onStateChange?: (state: CollabReviewDetailViewState) => void;
  private readonly preparedReviews: CollabPreparedReviewCache | null;
  private publishDescription: string | null = null;
  private requestCommentComposer: CollabCommentComposer | null = null;
  private requestCommentsListEl: HTMLElement | null = null;
  private requestCommentsTitleEl: HTMLElement | null = null;
  private requestCoordinationController: AbortController | null = null;
  private requestCoordinationRefreshPending = false;
  private requestChangesLoaded = false;
  private requestDescriptionController: AbortController | null = null;
  private requestReviewId: string | null = null;
  private requestReviewTab: 'changes' | 'overview' = 'overview';
  private review: CollabDisplayReview | null = null;
  private reviewController: AbortController | null = null;
  private state: CollabReviewDetailViewState | null = null;
  private readonly ticketReferences: TicketReferenceResolver;

  private readonly app: App;
  private readonly component: Component;
  private readonly diffSession: ReviewDiffSession;
  private readonly leaf: WorkspaceLeaf;
  private mode: CollabReviewDetailViewState['kind'] | null = null;
  private readonly port: ReviewDetailSessionPort;
  private readonly rootEl: HTMLElement;
  private readonly viewType: string;

  constructor(options: ReviewDetailSessionOptions) {
    this.app = options.app;
    this.component = options.component;
    this.diffSession = options.diffSession;
    this.leaf = options.leaf;
    this.openTicketInNewTab = options.openTicketInNewTab;
    this.onStateChange = options.onStateChange;
    this.port = options.port;
    this.preparedReviews = options.preparedReviews ?? null;
    this.rootEl = options.rootEl;
    this.viewType = options.viewType;
    this.ticketReferences = new TicketReferenceResolver(options.port);
  }

  get displayText(): string {
    return this.state?.kind === 'publication' || this.state?.kind === 'working-tree'
      ? t('collab.review.publicationTitle')
      : t('collab.review.title');
  }

  get stateSnapshot(): CollabReviewDetailViewState | null {
    return this.state ? { ...this.state } : null;
  }

  get kind(): CollabReviewDetailViewState['kind'] | null {
    return this.mode;
  }

  async setState(state: CollabReviewDetailViewState): Promise<void> {
    if (this.mode !== null && this.mode !== state.kind) {
      throw new Error(`Review session cannot change mode from ${this.mode} to ${state.kind}`);
    }
    this.mode = state.kind;
    if (
      this.review !== null
      && reviewMatchesState(this.review, state)
      && this.state?.kind === state.kind
    ) {
      const previousReview = this.review;
      if (state.kind === 'request') {
        const prepared = this.preparedReviews?.read(state) ?? null;
        if (prepared) {
          this.review = prepared.review;
          this.coordination = prepared.coordination;
          this.memberNames = new Map(
            prepared.coordination.snapshot.members.map(member => [member.id, member.displayName]),
          );
        }
      } else if (state.kind === 'publication') {
        const prepared = this.preparedReviews?.readPublication(state) ?? null;
        if (prepared) {
          this.review = prepared;
          this.coordination = null;
          this.memberNames = new Map();
        }
      }
      const selected = this.review.files.find(file => file.path === state.selectedPath)
        ?? this.review.files[0];
      this.state = selected
        ? { ...state, selectedPath: selected.path }
        : { ...state, selectedPath: undefined };
      this.publishState();
      if (isRequestReview(this.review) && this.requestReviewTab === 'overview') {
        if (this.reviewPresentationChanged(previousReview, this.review)) {
          const ownsRequest = this.coordination?.snapshot.currentMember.id
            === this.review.detail.request.memberId;
          if (
            !this.rootEl.querySelector('.claudian-collab-request-description.is-editing')
            && (!ownsRequest || this.publishDescription === null)
          ) {
            this.descriptionEditor?.setValue(this.review.detail.request.description);
          }
          this.renderRequestCommentItems(this.review);
        }
        return;
      }
      if (this.contentHostEl) {
        this.diffSession.bind(this.contentHostEl, this.review, selected?.path);
        if (!reviewsShareIdentity(previousReview, this.review)) this.diffSession.start();
        else if (selected) this.diffSession.select(selected.path);
      }
      return;
    }
    this.cancelWork({ retainDiff: true });
    this.state = state;
    this.publishState();
    await this.loadReview(state);
  }

  selectPath(path: string): void {
    if (!this.state) return;
    this.state = { ...this.state, selectedPath: path };
    this.publishState();
  }

  refresh(): Promise<void> {
    const state = this.state;
    return state?.kind === 'request'
      ? this.refreshRequestCoordination(state)
      : Promise.resolve();
  }

  destroy(options: { readonly retainDiff?: boolean } = {}): void {
    this.generation += 1;
    this.cancelWork(options);
  }

  private async loadReview(state: CollabReviewDetailViewState): Promise<void> {
    const generation = ++this.generation;
    this.renderMessage(t('collab.review.loading'));
    const controller = new AbortController();
    this.reviewController = controller;
    try {
      this.publishDescription = await this.port.readPublishDescription(
        state.projectId,
        { signal: controller.signal },
      ).then(result => result.status === 'success' ? result.value : null, () => null);
      let review: CollabDisplayReview;
      let snapshot: CollabCoordinationSnapshot | null;
      if (state.kind === 'request') {
        const requestSnapshot = await this.port.readSnapshot(state.projectId, {
          signal: controller.signal,
        }).then(requireSuccess);
        snapshot = requestSnapshot;
        const prepared = this.preparedReviews?.read(state) ?? null;
        const projectedRequest = requestSnapshot.snapshot.openRequests.find(request => (
          request.id === state.requestId
        ));
        const requestReview = prepared && !requestProjectionChanged(
          prepared.review.detail.request,
          projectedRequest,
        )
          ? prepared.review
          : await this.port.prepareReview(state.projectId, state.requestId, {
            signal: controller.signal,
          }).then(requireSuccess);
        review = withFreshAcceptEligibility(requestReview, snapshot);
        this.preparedReviews?.store({ coordination: requestSnapshot, review });
      } else if (state.kind === 'publication') {
        review = this.preparedReviews?.readPublication(state)
          ?? await this.port.preparePublicationReview(
            state.projectId,
            state.operationId,
            { signal: controller.signal },
          ).then(requireSuccess);
        snapshot = await this.port.readSnapshot(state.projectId, {
          signal: controller.signal,
        }).then(result => result.status === 'success' ? result.value : null, () => null);
      } else {
        review = await this.port.prepareWorkingTreeReview(
          state.projectId,
          state.baseOid,
          { signal: controller.signal },
        ).then(requireSuccess);
        snapshot = await this.port.readSnapshot(state.projectId, {
          signal: controller.signal,
        }).then(result => result.status === 'success' ? result.value : null, () => null);
      }
      if (controller.signal.aborted || generation !== this.generation) return;
      assertReviewMatchesState(review, state);
      this.review = review;
      this.renderReview(review, snapshot, state.selectedPath);
      if (isRequestReview(review)) {
        if (this.requestReviewTab === 'overview') return;
        this.requestChangesLoaded = true;
      }
      this.diffSession.start();
    } catch {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.diffSession.clear();
      this.renderMessage(t('collab.review.loadFailed'), true);
    } finally {
      if (this.reviewController === controller) this.reviewController = null;
    }
  }

  private renderReview(
    review: CollabDisplayReview,
    coordination: CollabCoordinationSnapshot | null,
    selectedPath?: string,
  ): void {
    this.destroyDescriptionEditor();
    this.rootEl.replaceChildren();
    this.coordination = coordination;
    this.requestChangesLoaded = false;
    this.requestCommentsListEl = null;
    this.requestCommentsTitleEl = null;
    if (isRequestReview(review)) {
      if (this.requestReviewId !== review.detail.request.id) {
        this.requestReviewId = review.detail.request.id;
        this.requestReviewTab = 'overview';
      }
    } else {
      this.requestReviewId = null;
      this.requestReviewTab = 'changes';
    }
    const memberNames = new Map(
      coordination?.snapshot.members.map(member => [member.id, member.displayName]) ?? [],
    );
    this.memberNames = memberNames;
    const header = this.rootEl.createDiv({ cls: 'claudian-collab-review-header' });
    if (isRequestReview(review)) header.classList.add('is-request');
    header.createEl('h2', {
      text: !isRequestReview(review)
        ? t('collab.review.publicationTitle')
        : `${t('collab.review.title')} @${memberNames.get(review.detail.request.memberId)
          ?? t('collab.team.unknownMember')}`,
    });
    if (!isRequestReview(review)) {
      this.renderDescriptionEditor(header, review, coordination);
    }
    if (isRequestReview(review)) {
      this.renderRequestAcceptAction(header, review, coordination);
    } else if (isPublicationReview(review) && review.canConfirm) {
      header.classList.add('has-primary-action');
      const confirm = header.createEl('button', {
        attr: { 'data-collab-action': 'confirm-publish', type: 'button' },
        cls: 'claudian-collab-review-accept',
        text: t('collab.publish.action'),
      });
      this.requireDescription(confirm);
      confirm.addEventListener('click', () => {
        void this.confirmPublish(review, confirm);
      });
    } else if (isWorkingTreeReview(review)) {
      header.classList.add('has-primary-action');
      const publish = header.createEl('button', {
        attr: { 'data-collab-action': 'publish-working-tree', type: 'button' },
        cls: 'claudian-collab-review-accept',
        text: t('collab.publish.action'),
      });
      this.requireDescription(publish);
      publish.addEventListener('click', () => {
        void this.publishWorkingTree(review, publish);
      });
    }
    const selected = review.files.find(file => file.path === selectedPath) ?? review.files[0];
    if (this.state) {
      this.state = selected
        ? { ...this.state, selectedPath: selected.path }
        : { ...this.state, selectedPath: undefined };
      this.publishState();
    }
    if (isRequestReview(review)) {
      const tabs = header.createDiv({
        attr: { 'aria-label': t('collab.review.sections'), role: 'tablist' },
        cls: 'claudian-collab-review-tabs',
      });
      const overviewTab = tabs.createEl('button', {
        attr: { role: 'tab', type: 'button' },
        text: t('collab.review.overview'),
      });
      const changesTab = tabs.createEl('button', {
        attr: { role: 'tab', type: 'button' },
        text: t('collab.review.changes', { count: review.files.length }),
      });
      const condition = this.reviewCondition(review);
      if (condition) {
        tabs.createDiv({
          cls: `claudian-collab-review-condition is-${condition.kind}`,
          text: condition.text,
        });
      }
      const overviewControls = tabs.createDiv({
        cls: [
          'claudian-collab-review-display-controls',
          'claudian-collab-review-overview-controls',
        ],
      });
      const changesControls = this.renderReviewDisplayControls(tabs);
      changesControls.classList.add('claudian-collab-review-changes-controls');
      const overview = this.rootEl.createDiv({
        attr: { role: 'tabpanel' },
        cls: 'claudian-collab-review-content claudian-collab-review-overview',
      });
      const changes = this.rootEl.createDiv({
        attr: { role: 'tabpanel' },
        cls: 'claudian-collab-review-content claudian-collab-review-changes',
      });
      this.contentHostEl = changes;
      this.renderDescriptionEditor(overview, review, coordination, overviewControls);
      this.renderRequestComments(overview, review, coordination);
      const activate = (tab: 'changes' | 'overview', loadChanges: boolean): void => {
        this.requestReviewTab = tab;
        const showingOverview = tab === 'overview';
        overview.hidden = !showingOverview;
        changes.hidden = showingOverview;
        overviewControls.hidden = !showingOverview;
        changesControls.hidden = showingOverview;
        overviewTab.setAttribute('aria-selected', String(showingOverview));
        changesTab.setAttribute('aria-selected', String(!showingOverview));
        overviewTab.classList.toggle('is-active', showingOverview);
        changesTab.classList.toggle('is-active', !showingOverview);
        if (loadChanges && !showingOverview) {
          const activePath = this.state?.kind === 'request'
            ? this.state.selectedPath
            : selected?.path;
          const current = this.review;
          if (current && isRequestReview(current)) {
            this.startRequestChanges(current, activePath);
          }
        }
      };
      overviewTab.addEventListener('click', () => activate('overview', false));
      changesTab.addEventListener('click', () => activate('changes', true));
      activate(this.requestReviewTab, false);
    } else {
      this.contentHostEl = this.rootEl.createDiv({ cls: 'claudian-collab-review-content' });
    }
    if (this.contentHostEl) {
      this.diffSession.bind(this.contentHostEl, review, selected?.path);
    }
    if (review.files.length === 0) {
      this.contentHostEl.createDiv({ text: t('collab.review.noFiles') });
    }
  }

  private renderRequestAcceptAction(
    header: HTMLElement,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot | null,
  ): void {
    header.querySelector('[data-collab-action="accept"]')?.remove();
    header.classList.remove('has-primary-action');
    if (!review.canAccept || !isCurrentManager(coordination)) return;
    header.classList.add('has-primary-action');
    const accept = header.createEl('button', {
      attr: { 'data-collab-action': 'accept', type: 'button' },
      cls: 'claudian-collab-review-accept',
      text: t('collab.review.accept'),
    });
    const synchronized = canAcceptFromCoordination(coordination);
    accept.disabled = !synchronized;
    if (!synchronized) accept.title = t('collab.review.acceptRequiresSync');
    accept.addEventListener('click', () => {
      const current = this.review;
      if (
        current
        && isRequestReview(current)
        && canAcceptFromCoordination(this.coordination)
      ) void this.accept(current, accept);
    });
  }

  private async refreshRequestCoordination(state: CollabRequestDetailViewState): Promise<void> {
    if (this.acceptController) {
      this.requestCoordinationRefreshPending = true;
      return;
    }
    this.requestCoordinationRefreshPending = false;
    this.requestCoordinationController?.abort();
    const controller = new AbortController();
    this.requestCoordinationController = controller;
    try {
      let coordination: CollabCoordinationSnapshot | null = null;
      let refreshFailed = false;
      try {
        coordination = await this.port.readSnapshot(state.projectId, {
          signal: controller.signal,
        }).then(requireSuccess);
      } catch {
        if (controller.signal.aborted) return;
        refreshFailed = true;
      }
      if (controller.signal.aborted) return;
      let currentState = this.state;
      let currentReview = this.review;
      if (
        currentState?.kind !== 'request'
        || currentState.projectId !== state.projectId
        || currentState.requestId !== state.requestId
        || !currentReview
        || !isRequestReview(currentReview)
        || !reviewMatchesState(currentReview, currentState)
      ) return;
      const currentRequestId = currentReview.detail.request.id;
      const projectedRequest = coordination?.snapshot.openRequests.find(request => (
        request.id === currentRequestId
      ));
      let refreshedReview = currentReview;
      const acceptedMainChanged = coordination !== null
        && coordination.snapshot.project.mainOid !== currentReview.detail.currentMainOid;
      if (
        !refreshFailed
        && (
          acceptedMainChanged
          || requestProjectionChanged(currentReview.detail.request, projectedRequest)
        )
      ) {
        try {
          refreshedReview = await this.port.prepareReview(state.projectId, state.requestId, {
            signal: controller.signal,
          }).then(requireSuccess);
        } catch {
          if (controller.signal.aborted) return;
          refreshFailed = true;
        }
      }
      if (controller.signal.aborted) return;
      currentState = this.state;
      currentReview = this.review;
      if (
        currentState?.kind !== 'request'
        || currentState.projectId !== state.projectId
        || currentState.requestId !== state.requestId
        || !currentReview
        || !isRequestReview(currentReview)
      ) return;
      const mergedReview = refreshedReview === currentReview
        ? refreshedReview
        : mergeRefreshedRequestReview(currentReview, refreshedReview);
      const normalizedReview = refreshFailed
        ? { ...mergedReview, canAccept: false }
        : withFreshAcceptEligibility(mergedReview, coordination);
      this.applyRefreshedRequestReview(currentReview, normalizedReview, coordination);
    } finally {
      if (this.requestCoordinationController === controller) {
        this.requestCoordinationController = null;
      }
    }
  }

  private applyRefreshedRequestReview(
    previous: CollabRequestReview,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot | null,
  ): void {
    const identityChanged = !reviewsShareIdentity(previous, review);
    const presentationChanged = this.reviewPresentationChanged(previous, review);
    const selected = review.files.find(file => (
      this.state?.kind === 'request' && file.path === this.state.selectedPath
    )) ?? review.files[0];
    this.review = review;
    this.state = requestState(review, selected?.path);
    this.publishState();
    this.coordination = coordination;
    this.memberNames = new Map(
      coordination?.snapshot.members.map(member => [member.id, member.displayName]) ?? [],
    );
    if (coordination) this.preparedReviews?.store({ coordination, review });

    if (previous.detail.request.status === 'open' && review.detail.request.status !== 'open') {
      this.renderReview(review, coordination, selected?.path);
      if (this.requestReviewTab === 'changes') this.startRequestChanges(review, selected?.path);
      return;
    }

    const header = this.rootEl.querySelector<HTMLElement>('.claudian-collab-review-header');
    if (header) {
      this.renderRequestAcceptAction(header, review, coordination);
      const title = header.querySelector('h2');
      if (title) {
        title.textContent = `${t('collab.review.title')} @${this.memberNames.get(
          review.detail.request.memberId,
        ) ?? t('collab.team.unknownMember')}`;
      }
      const tabs = header.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      if (tabs[1]) tabs[1].textContent = t('collab.review.changes', { count: review.files.length });
      const conditionEl = header.querySelector<HTMLElement>('.claudian-collab-review-condition');
      const condition = this.reviewCondition(review);
      if (conditionEl && condition) {
        conditionEl.className = `claudian-collab-review-condition is-${condition.kind}`;
        conditionEl.textContent = condition.text;
      }
    }

    if (presentationChanged) {
      const ownsRequest = coordination?.snapshot.currentMember.id
        === review.detail.request.memberId;
      if (
        !this.rootEl.querySelector('.claudian-collab-request-description.is-editing')
        && (!ownsRequest || this.publishDescription === null)
      ) {
        this.descriptionEditor?.setValue(review.detail.request.description);
      }
    }
    if (presentationChanged || identityChanged) {
      this.renderRequestCommentItems(review);
    }

    if (identityChanged) {
      this.diffSession.detach();
      this.contentHostEl?.replaceChildren();
      this.requestChangesLoaded = false;
    }
    if (this.requestReviewTab === 'changes' && identityChanged) {
      this.requestChangesLoaded = false;
      this.startRequestChanges(review, selected?.path);
    }
  }

  private renderReviewDisplayControls(metadata: HTMLElement): HTMLElement {
    return this.diffSession.createControls(metadata);
  }

  private renderDescriptionEditor(
    host: HTMLElement,
    review: CollabDisplayReview,
    coordination: CollabCoordinationSnapshot | null,
    editActionHost?: HTMLElement,
  ): void {
    const section = host.createDiv({ cls: 'claudian-collab-request-description' });
    if (isRequestReview(review)) section.classList.add('is-request');
    const descriptionHeader = section.createDiv({
      cls: 'claudian-collab-request-description-header',
    });
    if (!isRequestReview(review)) {
      descriptionHeader.createSpan({ text: t('collab.publish.description') });
      const metadata = descriptionHeader.createDiv({
        cls: 'claudian-collab-review-metadata-line',
      });
      metadata.createDiv({
        cls: 'claudian-collab-review-summary',
        text: t('collab.review.fileCount', { count: review.files.length }),
      });
      const condition = this.reviewCondition(review);
      if (condition) {
        metadata.createDiv({
          cls: `claudian-collab-review-condition is-${condition.kind}`,
          text: condition.text,
        });
      }
      this.renderReviewDisplayControls(metadata);
    }
    const request = isRequestReview(review)
      ? review.detail.request
      : coordination?.snapshot.openRequests.find(candidate => (
        candidate.memberId === coordination.snapshot.currentMember.id
      ));
    const currentMemberOwnsRequest = request?.memberId
      === coordination?.snapshot.currentMember.id;
    const initialValue = currentMemberOwnsRequest
      ? this.publishDescription ?? request?.description ?? ''
      : request?.description ?? this.publishDescription ?? '';
    const canEdit = !isRequestReview(review) || (
      request?.status === 'open'
      && coordination?.snapshot.currentMember.id === request.memberId
    );
    const descriptionModes = canEdit
      ? descriptionHeader.createDiv({ cls: 'claudian-collab-request-description-modes' })
      : null;
    if (isRequestReview(review) && descriptionModes) descriptionModes.hidden = true;
    const editorRoot = section.createDiv({
      attr: { 'data-collab-description': 'true' },
    });
    const input = new MarkdownDraftEditor(editorRoot, {
      actionName: 'publish-description',
      ariaLabel: t('collab.publish.description'),
      editable: canEdit,
      ...(isRequestReview(review) ? { initialMode: 'preview' as const } : {}),
      initialValue,
      ...(this.openTicketInNewTab ? {
        onOpenTicket: (ticketNumber: number) => (
          this.openTicketReference(review.projectId, ticketNumber)
        ),
      } : {}),
      ...(isRequestReview(review) ? {
        placeholder: t('collab.publish.descriptionPlaceholder'),
      } : {}),
      renderMarkdown: (markdown, host) => MarkdownRenderer.render(
        this.app,
        markdown,
        host,
        '',
        this.component,
      ),
      ticketSuggestions: coordination?.snapshot.ticketHighlights
        .filter(ticket => ticket.status === 'open')
        .map(ticket => ({ number: ticket.number, title: ticket.title })) ?? [],
      ...(descriptionModes ? { toolbarEl: descriptionModes } : {}),
    });
    this.descriptionEditor = input;
    const descriptionDiffersFromAuthority = currentMemberOwnsRequest
      && this.publishDescription !== null
      && this.publishDescription !== request?.description;
    if (!isRequestReview(review)) {
      if (descriptionDiffersFromAuthority) {
        section.createDiv({
          attr: { 'aria-live': 'polite' },
          cls: 'claudian-collab-request-description-status',
          text: t('collab.publish.descriptionNotSynced'),
        });
      }
      return;
    }
    if (!canEdit || !request) return;
    const openEditor = (editActionHost ?? descriptionHeader).createEl('button', {
      attr: {
        'aria-label': t('common.edit'),
        'data-action': 'open-request-description-editor',
        type: 'button',
      },
      cls: 'claudian-collab-review-display-toggle',
    });
    setIcon(openEditor, 'pencil');
    const enterEditing = (): void => {
      section.classList.add('is-editing');
      descriptionModes!.hidden = false;
      openEditor.hidden = true;
      input.focus();
    };
    const exitEditing = (): void => {
      input.setMode('preview');
      section.classList.remove('is-editing');
      descriptionModes!.hidden = true;
      openEditor.hidden = false;
    };
    openEditor.addEventListener('click', enterEditing);
    const status = section.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-request-description-status',
    });
    if (descriptionDiffersFromAuthority) {
      status.setText(t('collab.publish.descriptionNotSynced'));
    }
    const save = descriptionModes!.createEl('button', {
      attr: { 'data-action': 'submit-request-description', type: 'button' },
      cls: 'claudian-collab-request-description-submit',
      text: t('collab.publish.saveDescription'),
    });
    save.addEventListener('click', () => {
      void this.saveRequestDescription(review, input, save, status).then(saved => {
        if (saved) exitEditing();
      });
    });
  }

  private async saveRequestDescription(
    review: CollabRequestReview,
    input: MarkdownDraftEditor,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<boolean> {
    if (this.requestDescriptionController) return false;
    const activeReview = this.review && isRequestReview(this.review)
      && this.review.detail.request.id === review.detail.request.id
      ? this.review
      : review;
    const description = input.getValue();
    const mutation = {
      description,
      expectedHeadOid: activeReview.detail.reviewedHeadOid,
      expectedRequestRevision: activeReview.detail.request.revision,
      projectId: activeReview.projectId,
      requestId: activeReview.detail.request.id,
    };
    const intentId = this.mutationIntents.intent('description', mutation);
    const controller = new AbortController();
    this.requestDescriptionController = controller;
    button.disabled = true;
    status.setText(t('collab.publish.savingDescription'));
    try {
      const result = await this.port.updateRequestMetadata({
        ...mutation,
        intentId,
      }, { signal: controller.signal });
      const currentReview = this.currentRequestMutationReview(activeReview);
      if (
        controller.signal.aborted
        || !currentReview
      ) return false;
      if (result.status !== 'success') {
        button.disabled = false;
        status.setText(t('collab.publish.descriptionSaveFailed'));
        return false;
      }
      const updated = result.value;
      const updatedRequest = mergeAcknowledgedRequest(
        currentReview.detail.request,
        updated,
      );
      const updatedReview: CollabRequestReview = {
        ...currentReview,
        detail: { ...currentReview.detail, request: updatedRequest },
      };
      this.review = updatedReview;
      this.publishDescription = null;
      this.mutationIntents.clear('description', intentId);
      if (this.coordination) {
        const updatedCoordination = {
          ...this.coordination,
          snapshot: {
            ...this.coordination.snapshot,
            openRequests: this.coordination.snapshot.openRequests.map(request => (
              request.id === updated.id
                ? mergeAcknowledgedRequest(request, updated)
                : request
            )),
          },
        };
        this.coordination = updatedCoordination;
        this.preparedReviews?.store({
          coordination: updatedCoordination,
          review: updatedReview,
        });
      }
      input.setValue(updatedRequest.description);
      input.setMode('preview');
      button.disabled = false;
      status.setText('');
      return true;
    } catch {
      if (
        controller.signal.aborted
        || !this.currentRequestMutationReview(activeReview)
      ) return false;
      button.disabled = false;
      status.setText(t('collab.publish.descriptionSaveFailed'));
      return false;
    } finally {
      if (this.requestDescriptionController === controller) {
        this.requestDescriptionController = null;
      }
    }
  }

  private currentRequestMutationReview(
    expected: CollabRequestReview,
  ): CollabRequestReview | null {
    const current = this.review;
    return current !== null
      && isRequestReview(current)
      && current.projectId === expected.projectId
      && current.detail.request.id === expected.detail.request.id
      ? current
      : null;
  }

  private renderRequestComments(
    host: HTMLElement,
    review: CollabRequestReview,
    coordination: CollabCoordinationSnapshot | null,
  ): void {
    const section = host.createDiv({ cls: 'claudian-collab-request-comments' });
    this.requestCommentsTitleEl = section.createEl('h3');
    this.requestCommentsListEl = section.createDiv({
      cls: 'claudian-collab-request-comment-list',
    });
    this.renderRequestCommentItems(review);
    if (review.detail.request.status !== 'open') return;
    const composer = new CollabCommentComposer(section, {
      actionName: 'request-comment',
      ariaLabel: t('collab.comments.input'),
      dataField: 'request-comment',
      label: t('collab.comments.input'),
      ...(this.openTicketInNewTab ? {
        onOpenTicket: (ticketNumber: number) => (
          this.openTicketReference(review.projectId, ticketNumber)
        ),
      } : {}),
      onSubmit: (body, button, status) => this.submitRequestComment(
        review,
        body,
        button,
        status,
      ),
      renderMarkdown: (markdown, markdownHost) => MarkdownRenderer.render(
        this.app,
        markdown,
        markdownHost,
        '',
        this.component,
      ),
      submitAction: 'submit-request-comment',
      submitLabel: t('collab.comments.submit'),
      ticketSuggestions: coordination?.snapshot.ticketHighlights
        .filter(ticket => ticket.status === 'open')
        .map(ticket => ({ number: ticket.number, title: ticket.title })) ?? [],
    });
    this.requestCommentComposer = composer;
  }

  private renderRequestCommentItems(review: CollabRequestReview): void {
    const title = this.requestCommentsTitleEl;
    const list = this.requestCommentsListEl;
    if (!title || !list) return;
    const comments = [...review.detail.comments.comments]
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      ));
    title.setText(t('collab.comments.title', { count: comments.length }));
    title.parentElement?.classList.toggle('has-entries', comments.length > 0);
    title.hidden = comments.length === 0;
    list.replaceChildren();
    list.hidden = comments.length === 0;
    if (comments.length === 0) return;
    for (const comment of comments) {
      const item = list.createDiv({
        attr: { 'data-request-comment-id': comment.id },
        cls: 'claudian-collab-request-comment',
      });
      renderCollabComment(item, {
        authorName: this.memberNames.get(comment.authorMemberId)
          ?? t('collab.team.unknownMember'),
        body: comment.body,
        createdAt: comment.createdAt,
      }, {
        ...(this.openTicketInNewTab ? {
          onOpenTicket: (ticketNumber: number) => (
            this.openTicketReference(review.projectId, ticketNumber)
          ),
        } : {}),
        renderMarkdown: (markdown, markdownHost) => MarkdownRenderer.render(
          this.app,
          markdown,
          markdownHost,
          '',
          this.component,
        ),
      });
    }
  }

  private async submitRequestComment(
    renderedReview: CollabRequestReview,
    body: string,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    const review = this.review;
    if (
      !review
      || !isRequestReview(review)
      || review.detail.request.id !== renderedReview.detail.request.id
      || review.detail.request.status !== 'open'
    ) {
      status.setText(t('collab.comments.submitFailed'));
      return;
    }
    const mutation = {
      body,
      projectId: review.projectId,
      requestId: review.detail.request.id,
    };
    const intentId = this.mutationIntents.intent('comment', mutation);
    button.disabled = true;
    button.setText(t('collab.comments.submitting'));
    status.setText('');
    const result = await this.port.addComment({
      ...mutation,
      intentId,
    });
    if (result.status !== 'success' || this.review !== review) {
      button.disabled = false;
      button.setText(t('collab.comments.retry'));
      status.setText(t('collab.comments.submitFailed'));
      return;
    }
    this.adoptRequestComment(review, result.value);
    this.mutationIntents.clear('comment', intentId);
    this.requestCommentComposer?.editor.setValue('');
    button.disabled = false;
    button.setText(t('collab.comments.submit'));
    status.setText('');
  }

  private currentDescription(): string {
    return this.descriptionEditor?.getValue() ?? '';
  }

  private async openTicketReference(projectId: string, ticketNumber: number): Promise<void> {
    const openTicketInNewTab = this.openTicketInNewTab;
    if (!openTicketInNewTab) return;
    const generation = this.generation;
    await this.ticketReferences.openReference(
      projectId,
      ticketNumber,
      openTicketInNewTab,
      () => this.generation === generation,
    );
  }

  private requireDescription(button: HTMLButtonElement): void {
    const input = this.descriptionEditor;
    if (!input) return;
    const update = () => {
      const descriptionMissing = input.getValue().trim().length === 0;
      button.disabled = descriptionMissing;
      if (descriptionMissing) {
        button.title = t('collab.publish.descriptionRequired');
      } else {
        button.removeAttribute('title');
      }
    };
    input.onUpdate(update);
    update();
  }

  private startRequestChanges(review: CollabRequestReview, selectedPath?: string): void {
    if (this.requestChangesLoaded || this.review !== review) return;
    this.requestChangesLoaded = true;
    const host = this.contentHostEl;
    if (!host) return;
    this.diffSession.show(host, review, selectedPath);
  }

  private reviewPresentationChanged(
    previous: CollabDisplayReview,
    current: CollabDisplayReview,
  ): boolean {
    if (!isRequestReview(previous) || !isRequestReview(current)) {
      return !reviewsShareIdentity(previous, current);
    }
    if (
      previous.detail.request.status !== current.detail.request.status
      || previous.detail.request.revision !== current.detail.request.revision
      || previous.detail.request.updatedAt !== current.detail.request.updatedAt
      || previous.detail.request.commentCount !== current.detail.request.commentCount
      || previous.detail.comments.comments.length !== current.detail.comments.comments.length
    ) return true;
    return previous.detail.comments.comments.some((comment, index) => (
      comment.id !== current.detail.comments.comments[index]?.id
    ));
  }

  private async accept(review: CollabRequestReview, button: HTMLButtonElement): Promise<void> {
    if (
      !review.canAccept
      || this.acceptController
      || this.coordination?.source !== 'online'
      || this.coordination.stale
      || this.coordination.syncState.status !== 'synchronized'
    ) return;
    const controller = new AbortController();
    this.acceptController = controller;
    button.disabled = true;
    button.textContent = t('collab.review.accepting');
    const mutation = this.acceptMutation(review);
    const intentId = this.mutationIntents.intent('accept', mutation);
    const mutationIdentity = JSON.stringify(mutation);
    try {
      const outcome = requireSuccess(await this.port.acceptRequest({
        ...mutation,
        intentId,
      }, { signal: controller.signal }));
      const current = this.review;
      if (
        !controller.signal.aborted
        && current
        && isRequestReview(current)
        && JSON.stringify(this.acceptMutation(current)) === mutationIdentity
      ) {
        this.mutationIntents.clear('accept', intentId);
        const detail = {
          ...review.detail,
          request: outcome.request,
        };
        this.review = { ...review, canAccept: false, detail };
        const condition = this.rootEl.querySelector<HTMLElement>(
          '.claudian-collab-review-condition',
        );
        if (condition) {
          condition.className = 'claudian-collab-review-condition is-merged';
          condition.textContent = t('collab.review.accepted');
        }
        button.remove();
        if (this.state?.kind === 'request') this.preparedReviews?.discard(this.state);
        this.leaf.detach();
      }
    } catch {
      if (controller.signal.aborted) return;
      button.disabled = false;
      button.textContent = t('collab.review.acceptFailed');
    } finally {
      if (this.acceptController === controller) {
        this.acceptController = null;
        const state = this.state;
        if (this.requestCoordinationRefreshPending && state?.kind === 'request') {
          this.requestCoordinationRefreshPending = false;
          void this.refreshRequestCoordination(state);
        }
      }
    }
  }

  private acceptMutation(review: CollabRequestReview): AcceptMutation {
    const expectedResolvingTickets = review.detail.request.ticketRelations
      .filter(relation => relation.kind === 'resolves')
      .map(relation => ({
        revision: relation.ticketRevision,
        ticketId: relation.ticketId,
      }))
      .sort((left, right) => (
        left.ticketId.localeCompare(right.ticketId) || left.revision - right.revision
      ));
    return {
      expectedHeadOid: review.detail.reviewedHeadOid,
      expectedMainOid: review.detail.currentMainOid,
      expectedRequestRevision: review.detail.request.revision,
      expectedResolvingTickets,
      projectId: review.projectId,
      requestId: review.detail.request.id,
    };
  }

  private async confirmPublish(
    review: CollabPublicationReview,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!review.canConfirm || this.acceptController) return;
    const controller = new AbortController();
    this.acceptController = controller;
    button.disabled = true;
    button.textContent = t('collab.review.confirmingPublish');
    try {
      const result = await this.port.confirmPublish({
        description: this.currentDescription(),
        expectedCandidateOid: review.candidateOid,
        expectedMainOid: review.currentMainOid,
        operationId: review.operationId,
        projectId: review.projectId,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status === 'conflict') {
        this.preparedReviews?.discardPublication(review);
        const conflictState = await this.conflictState(result.conflict, controller.signal);
        if (controller.signal.aborted) return;
        await this.leaf.setViewState({
          active: true,
          state: { ...conflictState },
          type: this.viewType,
        });
        return;
      }
      const outcome = requireSuccess(result);
      if (outcome.state === 'review-required' && outcome.review) {
        this.preparedReviews?.discardPublication(review);
        this.preparedReviews?.storePublication(outcome.review);
        await this.leaf.setViewState({
          active: true,
          state: { ...publicationState(outcome.review, outcome.review.files[0]?.path) },
          type: this.viewType,
        });
        return;
      }
      this.preparedReviews?.discardPublication(review);
      this.leaf.detach();
    } catch {
      if (controller.signal.aborted) return;
      button.disabled = false;
      button.textContent = t('collab.review.confirmPublishFailed');
    } finally {
      if (this.acceptController === controller) this.acceptController = null;
    }
  }

  private async publishWorkingTree(
    review: CollabWorkingTreeReview,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (this.acceptController) return;
    const controller = new AbortController();
    this.acceptController = controller;
    button.disabled = true;
    button.textContent = t('collab.publish.publishing');
    try {
      const result = await this.port.publish({
        description: this.currentDescription(),
        projectId: review.projectId,
      }, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.status === 'conflict') {
        const conflictState = await this.conflictState(result.conflict, controller.signal);
        if (controller.signal.aborted) return;
        await this.leaf.setViewState({
          active: true,
          state: { ...conflictState },
          type: this.viewType,
        });
        return;
      }
      const outcome = requireSuccess(result);
      if (outcome.state === 'review-required' && outcome.review) {
        this.preparedReviews?.storePublication(outcome.review);
        this.leaf.detach();
        return;
      }
      this.leaf.detach();
    } catch {
      if (controller.signal.aborted) return;
      button.disabled = false;
      button.textContent = t('collab.publish.error');
    } finally {
      if (this.acceptController === controller) this.acceptController = null;
    }
  }

  private renderMessage(message: string, warning = false): void {
    this.destroyDescriptionEditor();
    this.rootEl.replaceChildren();
    this.rootEl.createDiv({
      cls: warning ? 'claudian-collab-review-message mod-warning' : 'claudian-collab-review-message',
      text: message,
    });
  }

  private async conflictState(
    conflict: CollabConflictDescriptor,
    signal: AbortSignal,
  ): Promise<CollabConflictDetailViewState> {
    let coordination = this.coordination;
    if (coordination?.snapshot.project.id !== conflict.projectId) {
      try {
        const result = await this.port.readSnapshot(conflict.projectId, { signal });
        coordination = result.status === 'success' ? result.value : null;
      } catch {
        coordination = null;
      }
    }
    const ownRequest = coordination?.snapshot.openRequests.find(
      request => request.memberId === coordination?.snapshot.currentMember.id,
    );
    return ownRequest
      ? {
          kind: 'conflict',
          location: 'request',
          operationId: conflict.operationId,
          projectId: conflict.projectId,
          requestId: ownRequest.id,
        }
      : {
          kind: 'conflict',
          location: 'my-changes',
          operationId: conflict.operationId,
          projectId: conflict.projectId,
        };
  }

  private adoptRequestComment(
    review: CollabRequestReview,
    comment: CollabComment,
  ): CollabRequestReview {
    const replayed = review.detail.comments.comments
      .some(candidate => candidate.id === comment.id);
    const comments = replayed
      ? review.detail.comments.comments
      : [...review.detail.comments.comments, comment];
    const updatedReview: CollabRequestReview = {
      ...review,
      detail: {
        ...review.detail,
        comments: { comments },
        request: {
          ...review.detail.request,
          commentCount: Math.max(
            review.detail.request.commentCount + (replayed ? 0 : 1),
            comments.length,
          ),
        },
      },
    };
    this.review = updatedReview;
    if (this.coordination) {
      this.preparedReviews?.store({
        coordination: this.coordination,
        review: updatedReview,
      });
    }
    this.renderRequestCommentItems(updatedReview);
    return updatedReview;
  }

  private reviewMatchesState(
    review: CollabDisplayReview,
    state: CollabReviewDetailViewState,
  ): boolean {
    return reviewMatchesState(review, state);
  }

  private reviewCondition(review: CollabDisplayReview): {
    readonly kind: 'clean' | 'conflicting' | 'merged' | 'stale';
    readonly text: string;
  } | null {
    if (isWorkingTreeReview(review)) return null;
    if (isPublicationReview(review)) {
      return { kind: 'clean', text: t('collab.review.readyToPublish') };
    }
    if (review.detail.request.status === 'merged') {
      return { kind: 'merged', text: t('collab.review.accepted') };
    }
    if (review.detail.reviewCondition === 'clean') {
      return { kind: 'clean', text: t('collab.review.clean') };
    }
    if (review.detail.reviewCondition === 'conflicting') {
      return { kind: 'conflicting', text: t('collab.review.conflicting') };
    }
    return { kind: 'stale', text: t('collab.review.stale') };
  }

  private cancelWork(options: { readonly retainDiff?: boolean } = {}): void {
    this.destroyDescriptionEditor();
    this.ticketReferences.cancel();
    this.reviewController?.abort();
    this.reviewController = null;
    this.requestCoordinationController?.abort();
    this.requestCoordinationController = null;
    this.requestCoordinationRefreshPending = false;
    if (options.retainDiff) this.diffSession.detach();
    else this.diffSession.clear();
    this.acceptController?.abort();
    this.acceptController = null;
    this.mutationIntents.clearAll();
    this.review = null;
    this.coordination = null;
    this.memberNames = new Map();
    this.contentHostEl = null;
  }

  private destroyDescriptionEditor(): void {
    this.requestDescriptionController?.abort();
    this.requestDescriptionController = null;
    this.descriptionEditor?.destroy();
    this.descriptionEditor = null;
    this.requestCommentComposer?.destroy();
    this.requestCommentComposer = null;
    this.requestCommentsListEl = null;
    this.requestCommentsTitleEl = null;
  }

  private publishState(): void {
    if (this.state) this.onStateChange?.({ ...this.state });
  }

}

function mergeAcknowledgedRequest(
  current: CollabChangeRequest,
  acknowledged: CollabChangeRequest,
): CollabChangeRequest {
  if (current.id !== acknowledged.id) return acknowledged;
  if (current.revision >= acknowledged.revision) return current;
  return {
    ...acknowledged,
    commentCount: Math.max(current.commentCount, acknowledged.commentCount),
  };
}

function isCurrentManager(coordination: CollabCoordinationSnapshot | null): boolean {
  return coordination?.snapshot.currentMember.role === 'manager';
}

function canAcceptFromCoordination(coordination: CollabCoordinationSnapshot | null): boolean {
  return isCurrentManager(coordination)
    && coordination?.source === 'online'
    && coordination.stale === false
    && coordination.syncState.status === 'synchronized';
}

function withFreshAcceptEligibility(
  review: CollabRequestReview,
  coordination: CollabCoordinationSnapshot | null,
): CollabRequestReview {
  const canAccept = isCurrentManager(coordination)
    && review.detail.request.status === 'open'
    && review.detail.reviewCondition === 'clean';
  return review.canAccept === canAccept ? review : { ...review, canAccept };
}

function requestProjectionChanged(
  current: CollabChangeRequest,
  projected: CollabChangeRequest | undefined,
): boolean {
  if (!projected) return current.status === 'open';
  return current.id !== projected.id
    || current.status !== projected.status
    || current.latestHeadOid !== projected.latestHeadOid
    || current.revision !== projected.revision
    || current.updatedAt !== projected.updatedAt
    || current.commentCount !== projected.commentCount;
}

function mergeRefreshedRequestReview(
  current: CollabRequestReview,
  incoming: CollabRequestReview,
): CollabRequestReview {
  if (current.detail.request.id !== incoming.detail.request.id) return incoming;
  const comments = [...incoming.detail.comments.comments];
  const commentIds = new Set(comments.map(comment => comment.id));
  for (const comment of current.detail.comments.comments) {
    if (commentIds.has(comment.id)) continue;
    commentIds.add(comment.id);
    comments.push(comment);
  }
  const currentRequest = current.detail.request;
  const incomingRequest = incoming.detail.request;
  const retainedRequest = currentRequest.revision > incomingRequest.revision
    || (currentRequest.revision === incomingRequest.revision
      && currentRequest.updatedAt > incomingRequest.updatedAt)
    ? currentRequest
    : incomingRequest;
  return {
    ...incoming,
    detail: {
      ...incoming.detail,
      comments: { comments },
      request: {
        ...retainedRequest,
        commentCount: Math.max(
          currentRequest.commentCount,
          incomingRequest.commentCount,
          comments.length,
        ),
      },
    },
  };
}

function requireSuccess<T>(result: CollabResult<T>): T {
  if (result.status === 'success') return result.value;
  if ('error' in result) throw result.error;
  throw new CollabError({ code: 'cancelled' });
}

export function assertReviewMatchesState(
  review: CollabDisplayReview,
  state: CollabReviewDetailViewState,
): void {
  if (!reviewMatchesState(review, state)) {
    throw new CollabError({
      code: 'operation-failed',
      recoveryActions: ['retry'],
      safeContext: { reason: 'review-view-state-stale' },
    });
  }
}

export function reviewMatchesState(
  review: CollabDisplayReview,
  state: CollabReviewDetailViewState,
): boolean {
  if (state.kind === 'publication') {
    return isPublicationReview(review)
      && review.projectId === state.projectId
      && review.operationId === state.operationId
      && review.currentMainOid === state.currentMainOid
      && review.candidateOid === state.candidateOid
      && review.comparisonBaseOid === state.comparisonBaseOid
      && review.comparisonTargetOid === state.comparisonTargetOid;
  }
  if (state.kind === 'working-tree') {
    return isWorkingTreeReview(review)
      && review.projectId === state.projectId
      && review.baseOid === state.baseOid
      && review.headOid === state.headOid
      && review.snapshotId === state.snapshotId;
  }
  return isRequestReview(review)
    && review.projectId === state.projectId
    && review.detail.request.id === state.requestId
    && review.comparisonBaseOid === state.comparisonBaseOid
    && review.comparisonTargetOid === state.comparisonTargetOid
    && review.detail.currentMainOid === state.reviewedMainOid
    && review.detail.reviewedHeadOid === state.reviewedHeadOid;
}

export function publicationState(
  review: CollabPublicationReview,
  selectedPath?: string,
): CollabPublicationDetailViewState {
  return {
    candidateOid: review.candidateOid,
    comparisonBaseOid: review.comparisonBaseOid,
    comparisonTargetOid: review.comparisonTargetOid,
    currentMainOid: review.currentMainOid,
    kind: 'publication',
    operationId: review.operationId,
    projectId: review.projectId,
    ...(selectedPath ? { selectedPath } : {}),
  };
}

function requestState(
  review: CollabRequestReview,
  selectedPath?: string,
): CollabRequestDetailViewState {
  return {
    comparisonBaseOid: review.comparisonBaseOid,
    comparisonTargetOid: review.comparisonTargetOid,
    kind: 'request',
    projectId: review.projectId,
    requestId: review.detail.request.id,
    reviewedHeadOid: review.detail.reviewedHeadOid,
    reviewedMainOid: review.detail.currentMainOid,
    ...(selectedPath ? { selectedPath } : {}),
  };
}
