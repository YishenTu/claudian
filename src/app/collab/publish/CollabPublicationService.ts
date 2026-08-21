import { randomUUID } from 'node:crypto';

import { type CollabChangeRequest, type CollabComment, type CollabCommentPage, type CollabGitOid, type CollabOperationId, type CollabProjectId, type CollabRequestDetail, type CollabTicketAcceptedRelationPage, type CollabTicketComment, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketSummary } from '@claudian/collab-protocol';

import {
  type CollabProjectInspectionLease,
  CollabProjectWorkSessionRegistry,
  type CollabProjectWorkSessionSuspension,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  CollabGitFoundation,
} from '@/app/collab/ClaudianCollabService';
import {
  CollabClientProjection,
  type CollabManagerResponsibilityProjectionPort,
} from '@/app/collab/client/CollabClientProjection';
import type {
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { ConflictResolutionCoordinator } from '@/app/collab/conflicts/ConflictResolutionCoordinator';
import { ConflictScratchGitRepository } from '@/app/collab/conflicts/ConflictScratchGitRepository';
import { ConflictScratchStore } from '@/app/collab/conflicts/ConflictScratchStore';
import type {
  CollabLanDiscoveryPort,
} from '@/app/collab/discovery/CollabLanDiscoveryService';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import {
  COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
  type CollabRequestDraftRecord,
} from '@/app/collab/publish/CollabRequestDraftRecord';
import { CollabRequestDraftStore } from '@/app/collab/publish/CollabRequestDraftStore';
import { ConflictPublicationReviewPreparer } from '@/app/collab/publish/ConflictPublicationReviewPreparer';
import {
  hasUnpublishedPersonalState,
  personalChangesReviewBaseOid,
} from '@/app/collab/publish/LocalContributionClassifier';
import {
  LocalProjectControlPort,
} from '@/app/collab/publish/LocalProjectControlPort';
import {
  LocalPublishGitNetworkPort,
  LocalPublishProjectPort,
} from '@/app/collab/publish/LocalPublishProjectPort';
import { NativeGitPublicationCandidateRepository } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';
import {
  NativeGitPublishRepository,
} from '@/app/collab/publish/NativeGitPublishRepository';
import {
  normalizeCollabPublishDescription,
  PublishCoordinator,
} from '@/app/collab/publish/PublishCoordinator';
import { toCollabGitStatus } from '@/app/collab/publish/PublishSnapshotProjection';
import { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
import { ReconciliationCoordinator } from '@/app/collab/reconciliation/ReconciliationCoordinator';
import {
  ReconciliationMutationSafety,
} from '@/app/collab/reconciliation/ReconciliationMutationSafety';
import { ReconciliationRepository } from '@/app/collab/reconciliation/ReconciliationRepository';
import type {
  ReconnectDiscoveredProjectRequest,
} from '@/app/collab/reconnect/ReconnectProjectCoordinator';
import type { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import { CollabReviewService } from '@/app/collab/review/CollabReviewService';
import { LocalReviewProjectPort } from '@/app/collab/review/LocalReviewProjectPort';
import { NativeGitExactComparisonRepository } from '@/app/collab/review/NativeGitExactComparisonRepository';
import { NativeGitReviewRepository } from '@/app/collab/review/NativeGitReviewRepository';
import {
  NativeGitWorkingTreeReviewRepository,
} from '@/app/collab/review/NativeGitWorkingTreeReviewRepository';
import { WorkingTreeReviewService } from '@/app/collab/review/WorkingTreeReviewService';
import type { CollabProjectSnapshot } from '@/core/collab';
import type { CollabChangedFile } from '@/core/collab';
import { type CollabAcceptOutcome, type CollabAcceptRequest, type CollabAddCommentRequest, type CollabAddTicketCommentRequest, type CollabChangeTicketStatusRequest, type CollabConfirmPublishRequest, type CollabConflictDescriptor, type CollabConflictFileContent, type CollabConflictFileRequest, type CollabConflictSession, type CollabCoordinationSnapshot, type CollabCreateTicketRequest, type CollabGitStatus, type CollabListTicketsRequest, type CollabLocalProjectSummary, type CollabOperationOptions, type CollabPersonalChangesInspection, type CollabPublicationReview, type CollabPublicationReviewFileRequest, type CollabPublishOutcome, type CollabPublishRequest, type CollabReconciliationOutcome, type CollabReconnectProjectRequest, type CollabRequestReview, type CollabResult, type CollabReviewFileContent, type CollabReviewFileRequest, type CollabTicketDetailProjection, type CollabTicketPageProjection, type CollabUpdateRequestMetadataRequest, type CollabUpdateTicketContentRequest, type CollabWorkingTreeReview, type CollabWorkingTreeReviewFileRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabPublicationFoundationPort {
  readonly local: {
    readonly pathPolicy: CollabPathPolicy;
    readonly projects: CollabLocalProjectRepository;
    readonly workspace: CollabWorkspaceService;
  };
  requireGitFoundation(): Promise<CollabGitFoundation>;
}

export interface CollabPublicationServiceOptions {
  readonly discovery: Pick<CollabLanDiscoveryPort, 'discoverProjectCandidates'>;
  readonly isLocalHostRunning: (projectId: CollabProjectId) => boolean;
  readonly managerResponsibility: CollabManagerResponsibilityProjectionPort;
  readonly reconnect: CollabPublicationReconnectPort;
  readonly retirement: Pick<RetirementClientHandler, 'handle'>;
  readonly vaultRoot: string;
}

export interface CollabPublicationReconnectPort {
  reconnectProject(
    request: CollabReconnectProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>>;
  reconnectDiscoveredProject(
    request: ReconnectDiscoveredProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>>;
}

export type CollabCoordinationInvalidationListener = (
  projectId: CollabProjectId,
  reason: 'accepted-main-changed' | 'coordination-changed',
) => void;

interface PublicationRuntime {
  readonly comparisons: NativeGitExactComparisonRepository;
  readonly conflicts: ConflictResolutionCoordinator;
  readonly coordinator: PublishCoordinator;
  readonly projects: LocalPublishProjectPort;
  readonly publicationState: CollabPublicationStateStore;
  readonly requestDrafts: CollabRequestDraftStore;
  readonly reconciliation: ReconciliationCoordinator;
  readonly review: CollabReviewService;
  readonly repository: NativeGitPublishRepository;
  readonly workingTreeReview: WorkingTreeReviewService;
}

function conflictResult<T>(descriptor: CollabConflictDescriptor): CollabResult<T> {
  return {
    conflict: descriptor,
    error: new CollabError({
      code: 'content-conflict',
      recoveryActions: ['review-conflicts'],
      safeContext: { reason: 'accepted-state-conflict-pending' },
    }),
    status: 'conflict',
  };
}

function sameChangedFile(left: CollabChangedFile, right: CollabChangedFile): boolean {
  return left.path === right.path
    && left.previousPath === right.previousPath
    && left.kind === right.kind
    && left.binary === right.binary
    && left.workingTreeContentHash === right.workingTreeContentHash
    && left.oldBytes === right.oldBytes
    && left.newBytes === right.newBytes
    && left.additions === right.additions
    && left.deletions === right.deletions
    && left.largeForReview === right.largeForReview;
}

export class CollabPublicationService {
  private closePromise: Promise<void> | null = null;
  private readonly coordinationListeners = new Set<CollabCoordinationInvalidationListener>();
  private readonly control: LocalProjectControlPort;
  private disposed = false;
  private readonly projection: CollabClientProjection;
  private readonly sessions = new CollabProjectWorkSessionRegistry();
  private runtimePromise: Promise<PublicationRuntime> | null = null;

  constructor(
    private readonly foundation: CollabPublicationFoundationPort,
    private readonly options: CollabPublicationServiceOptions,
  ) {
    this.control = new LocalProjectControlPort(foundation.local.projects);
    this.projection = new CollabClientProjection(foundation.local.projects, this.control, {
      managerResponsibility: options.managerResponsibility,
      retirement: options.retirement,
      sessions: this.sessions,
    });
  }

  async readGitStatus(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabGitStatus> {
    const runtime = await this.runtime();
    const context = await runtime.projects.load(projectId);
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    return toCollabGitStatus(await runtime.repository.inspect(context, options.signal));
  }

  readSnapshot(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabProjectSnapshot> {
    return this.projection.readSnapshot(projectId, options).then(result => result.snapshot);
  }

  async readCoordinationSnapshot(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabCoordinationSnapshot> {
    const snapshot = await this.projection.readSnapshot(projectId, options);
    this.sessions.acquire(projectId).observedAcceptedMainOid = snapshot.snapshot.project.mainOid;
    await this.ensureEventSubscription(projectId);
    return snapshot;
  }

  readRequest(
    projectId: CollabProjectId,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestDetail> {
    return this.projection.readRequest(projectId, requestId, options);
  }

  listRequestComments(
    projectId: CollabProjectId,
    requestId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabCommentPage> {
    return this.projection.listRequestComments(projectId, requestId, query, options);
  }

  async prepareReview(
    projectId: CollabProjectId,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestReview> {
    return (await this.runtime()).review.prepare(projectId, requestId, options);
  }

  async prepareReviewPage(
    projectId: CollabProjectId,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestReview> {
    return (await this.runtime()).review.preparePage(projectId, requestId, options);
  }

  async readReviewFile(
    request: CollabReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabReviewFileContent> {
    return (await this.runtime()).review.readFile(request, options);
  }

  async prepareWorkingTreeReview(
    projectId: CollabProjectId,
    baseOid: CollabGitOid,
    options: CollabOperationOptions = {},
  ): Promise<CollabWorkingTreeReview> {
    return (await this.runtime()).workingTreeReview.prepare(projectId, baseOid, options);
  }

  async readWorkingTreeReviewFile(
    request: CollabWorkingTreeReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabReviewFileContent> {
    return (await this.runtime()).workingTreeReview.readFile(request, options);
  }

  async preparePublicationReview(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    options: CollabOperationOptions = {},
  ): Promise<CollabPublicationReview> {
    return this.enqueueProjectMutation(projectId, async () => (
      (await this.runtime()).coordinator.prepareReview(projectId, operationId, options)
    ));
  }

  async readPublicationReviewFile(
    request: CollabPublicationReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabReviewFileContent> {
    return this.enqueueProjectMutation(request.projectId, async () => {
      const runtime = await this.runtime();
      const review = await runtime.coordinator.prepareReview(
        request.projectId,
        request.operationId,
        options,
      );
      if (
        review.currentMainOid !== request.expectedMainOid
        || review.candidateOid !== request.expectedCandidateOid
        || review.comparisonBaseOid !== request.comparisonBaseOid
        || review.comparisonTargetOid !== request.comparisonTargetOid
      ) {
        throw new CollabError({
          code: 'stale-request-head',
          recoveryActions: ['retry'],
          safeContext: { reason: 'publication-review-file-state-changed' },
        });
      }
      const expectedFile = review.files.find(file => file.path === request.file.path);
      if (!expectedFile || !sameChangedFile(expectedFile, request.file)) {
        throw new CollabError({
          code: 'authority-integrity-error',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'publication-review-file-mismatch' },
        });
      }
      const context = await runtime.projects.load(request.projectId);
      return runtime.comparisons.readFile(context.repositoryPath, request, options.signal);
    });
  }

  async inspectPersonalChanges(
    projectId: CollabProjectId,
    gitStatus: CollabGitStatus,
    coordination: CollabCoordinationSnapshot | undefined,
    options: CollabOperationOptions = {},
  ): Promise<CollabPersonalChangesInspection> {
    return this.enqueueProjectMutation(projectId, async () => {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const runtime = await this.runtime();
      const currentMemberId = coordination?.snapshot.currentMember.id;
      const ownRequest = currentMemberId === undefined
        ? undefined
        : coordination?.snapshot.openRequests.find(
          request => request.memberId === currentMemberId,
        );
      const reviewBaseOid = personalChangesReviewBaseOid({
        coordinationAuthoritative: coordination?.source === 'online' && !coordination.stale,
        headOid: gitStatus.headOid,
        ...(ownRequest ? { openRequestHeadOid: ownRequest.latestHeadOid } : {}),
        personalRemoteOid: gitStatus.personalRemoteOid,
      });
      if (!reviewBaseOid) {
        throw new CollabError({
          code: 'repository-invalid',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'personal-changes-review-base-missing' },
        });
      }
      const unpublishedReview = await runtime.workingTreeReview.prepare(
        projectId,
        reviewBaseOid,
        options,
      );
      const inspected = (
        value: Omit<CollabPersonalChangesInspection, 'unpublishedReview'>,
      ): CollabPersonalChangesInspection => ({ ...value, unpublishedReview });
      const state = await runtime.publicationState.load(projectId);
      if (state.operation?.phase === 'review-ready') {
        try {
          const review = await runtime.coordinator.prepareReview(
            projectId,
            state.operation.operationId,
            options,
          );
          return inspected({
            action: 'review-and-publish',
            hasContribution: true,
            review,
            updateAvailable: true,
          });
        } catch (error) {
          if (!(error instanceof CollabError) || error.code === 'cancelled') throw error;
          return inspected({
            action: 'retry',
            hasContribution: true,
            updateAvailable: gitStatus.includesAcceptedMain === false,
          });
        }
      }
      if (state.operation) {
        return inspected({
          action: 'retry',
          hasContribution: true,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        });
      }
      const hasOpenRequest = ownRequest !== undefined;
      const hasUnpublishedLocalState = hasUnpublishedPersonalState({
        headOid: gitStatus.headOid,
        ...(ownRequest ? { openRequestHeadOid: ownRequest.latestHeadOid } : {}),
        personalRemoteOid: gitStatus.personalRemoteOid,
        workingTreeClean: gitStatus.workingTreeClean,
      });
      if (hasUnpublishedLocalState) {
        return inspected({
          action: 'publish',
          hasContribution: true,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        });
      }
      const cleanAtRecordedBase = gitStatus.workingTreeClean
        && gitStatus.headOid === state.baseMainOid
        && gitStatus.personalRemoteOid === gitStatus.headOid
        && gitStatus.aheadBy === 0
        && gitStatus.behindBy === 0;
      if (hasOpenRequest || cleanAtRecordedBase) {
        return inspected({
          action: 'none',
          hasContribution: hasOpenRequest,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        });
      }
      const hasContribution = gitStatus.aheadBy > 0
        || gitStatus.headOid !== state.baseMainOid;
      if (hasContribution) {
        return inspected({
          action: 'publish',
          hasContribution: true,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        });
      }
      if (gitStatus.behindBy > 0 || coordination === undefined) {
        return inspected({
          action: 'retry',
          hasContribution: false,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        });
      }
      return inspected({
        action: 'none',
        hasContribution: false,
        updateAvailable: gitStatus.includesAcceptedMain === false,
      });
    });
  }

  addComment(
    request: CollabAddCommentRequest,
    options: CollabOperationOptions = {},
    idempotencyKey?: string,
  ): Promise<CollabComment> {
    return this.projection.addComment({
      body: request.body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      projectId: request.projectId,
      requestId: request.requestId,
    }, options);
  }

  listTickets(
    request: CollabListTicketsRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketPageProjection> {
    return this.projection.listTickets(request, options);
  }

  async readTicket(
    projectId: CollabProjectId,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketDetailProjection> {
    return this.projection.readTicket(projectId, ticketId, options);
  }

  async readTicketPage(
    projectId: CollabProjectId,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketDetailProjection> {
    return this.projection.readTicketPage(projectId, ticketId, options);
  }

  listTicketComments(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketCommentPage> {
    return this.projection.listTicketComments(projectId, ticketId, query, options);
  }

  listTicketAcceptedRelations(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketAcceptedRelationPage> {
    return this.projection.listTicketAcceptedRelations(projectId, ticketId, query, options);
  }

  createTicket(
    request: CollabCreateTicketRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `ticket-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabTicketDetail> {
    return this.control.createTicket(request, idempotencyKey, options);
  }

  updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `ticket-content-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabTicketSummary> {
    return this.control.updateTicketContent(request, idempotencyKey, options);
  }

  addTicketComment(
    request: CollabAddTicketCommentRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `ticket-comment-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabTicketComment> {
    return this.control.addTicketComment(request, idempotencyKey, options);
  }

  closeTicket(
    request: CollabChangeTicketStatusRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `ticket-close-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabTicketSummary> {
    return this.control.closeTicket(request, idempotencyKey, options);
  }

  reopenTicket(
    request: CollabChangeTicketStatusRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `ticket-reopen-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabTicketSummary> {
    return this.control.reopenTicket(request, idempotencyKey, options);
  }

  async updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    options: CollabOperationOptions = {},
    idempotencyKey = `request-metadata-${randomUUID().replaceAll('-', '')}`,
  ): Promise<CollabChangeRequest> {
    return this.enqueueProjectMutation(request.projectId, async () => {
      const runtime = await this.runtime();
      const description = normalizeCollabPublishDescription(request.description);
      const draft = await this.saveRequestDraft(runtime, {
        baseRequestRevision: request.expectedRequestRevision,
        description,
        projectId: request.projectId,
        requestId: request.requestId,
        syncState: 'syncing',
        targetHeadOid: request.expectedHeadOid,
      });
      try {
        const updated = await this.control.updateRequestMetadata(
          { ...request, description },
          idempotencyKey,
          options,
        );
        if (
          updated.status === 'open'
          && updated.latestHeadOid === request.expectedHeadOid
          && updated.description === description
        ) {
          await this.removeRequestDraftIfUnchanged(runtime, draft);
        }
        return updated;
      } catch (error) {
        await this.markRequestDraftNeedsAttention(runtime, draft);
        throw error;
      }
    });
  }

  async readPublishDescription(projectId: CollabProjectId): Promise<string | null> {
    return (await (await this.runtime()).requestDrafts.load(projectId))?.description ?? null;
  }

  subscribeCoordination(
    listener: CollabCoordinationInvalidationListener,
  ): { dispose(): void } {
    this.coordinationListeners.add(listener);
    return { dispose: () => this.coordinationListeners.delete(listener) };
  }

  acceptRequest(
    request: CollabAcceptRequest,
    options: CollabOperationOptions = {},
    idempotencyKey?: string,
  ): Promise<CollabAcceptOutcome> {
    return this.projection.acceptRequest(
      request.projectId,
      request.requestId,
      request.expectedMainOid,
      request.expectedHeadOid,
      request.expectedRequestRevision,
      request.expectedResolvingTickets,
      options,
      idempotencyKey,
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    const close = (async () => {
      try {
        await this.sessions.close();
      } finally {
        this.coordinationListeners.clear();
        this.projection.dispose();
      }
    })();
    this.closePromise = close;
    return close;
  }

  resetProjectConnection(projectId: CollabProjectId): void {
    if (this.disposed) return;
    this.projection.resetProjectConnection(projectId);
  }

  closeProject(projectId: CollabProjectId): void {
    if (this.disposed) return;
    void this.sessions.closeProject(projectId);
  }

  async drainProject(projectId: CollabProjectId): Promise<void> {
    await this.sessions.drainProject(projectId);
  }

  suspendProject(
    projectId: CollabProjectId,
  ): Promise<CollabProjectWorkSessionSuspension> {
    return this.sessions.suspendProject(projectId);
  }

  async completeProjectSuspension(
    suspension: CollabProjectWorkSessionSuspension,
  ): Promise<void> {
    await this.sessions.completeSuspension(suspension);
  }

  async resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void> {
    if (!await this.sessions.resumeProject(suspension)) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry', 'open-diagnostics'],
        safeContext: { reason: 'collab-project-work-session-resume-failed' },
      });
    }
  }

  beginProjectInspection(projectId: CollabProjectId): CollabProjectInspectionLease {
    return this.sessions.acquire(projectId).beginInspection();
  }

  scheduleAcceptedMainSynchronization(projectId: CollabProjectId): void {
    if (this.disposed) return;
    this.sessions.acquire(projectId).scheduleSynchronization(signal => (
      this.synchronizeAcceptedMain(projectId, { signal })
    ));
  }

  abortProjectBackgroundWork(projectId: CollabProjectId): void {
    if (this.disposed) return;
    this.sessions.acquire(projectId).abortBackgroundSynchronization();
  }

  async publish(
    request: CollabPublishRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    return this.enqueueProjectMutation(request.projectId, async () => {
      const runtime = await this.runtime();
      const description = normalizeCollabPublishDescription(request.description);
      const draft = await this.saveRequestDraft(runtime, {
        description,
        projectId: request.projectId,
        syncState: 'local',
      });
      const existingConflict = await runtime.conflicts.findProject(request.projectId, options);
      if (existingConflict.status !== 'success') return existingConflict;
      let result: CollabResult<CollabPublishOutcome>;
      if (existingConflict.value) {
        result = await runtime.coordinator.publishConflictResolution(
          { ...request, description },
          existingConflict.value.descriptor,
          options,
        );
        if (
          result.status === 'conflict'
          && result.conflict.startingPersonalOid
            !== existingConflict.value.descriptor.startingPersonalOid
        ) {
          const prepared = await runtime.conflicts.prepareWorkingTreeResolution(
            result.conflict,
            options,
          );
          if (prepared.status !== 'success') return prepared;
          if (prepared.value.publicationReview) {
            result = {
              status: 'success',
              value: {
                localHeadOid: prepared.value.publicationReview.contributionHeadOid,
                projectId: request.projectId,
                review: prepared.value.publicationReview,
                state: 'review-required',
              },
            };
          }
        } else if (result.status === 'success') {
          await runtime.conflicts.discard(existingConflict.value.descriptor.operationId);
        }
      } else {
        result = await runtime.coordinator.publish({ ...request, description }, options);
      }
      await this.reconcileRequestDraft(runtime, draft, result);
      if (result.status !== 'conflict') return result;
      const started = await runtime.conflicts.start(result.conflict, options);
      return started.status === 'success' ? result : started;
    });
  }

  async confirmPublish(
    request: CollabConfirmPublishRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    return this.enqueueProjectMutation(request.projectId, async () => {
      const runtime = await this.runtime();
      const description = normalizeCollabPublishDescription(request.description);
      const draft = await this.saveRequestDraft(runtime, {
        description,
        projectId: request.projectId,
        syncState: 'local',
      });
      const result = await runtime.coordinator.confirm({ ...request, description }, options);
      await this.reconcileRequestDraft(runtime, draft, result);
      if (result.status !== 'conflict') return result;
      const started = await runtime.conflicts.start(result.conflict, options);
      return started.status === 'success' ? result : started;
    });
  }

  reconnectProject(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.enqueueProjectMutation(request.projectId, async () => {
      const result = await this.options.reconnect.reconnectProject(request, options);
      if (result.status === 'success') this.resetProjectConnection(request.projectId);
      return result;
    });
  }

  tryAutoReconnect(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<boolean> {
    const discovery = this.options.discovery;
    const reconnect = this.options.reconnect;
    if (this.disposed) return Promise.resolve(false);
    const session = this.sessions.acquire(projectId);
    return session.coalesceAutoReconnect(() => this.enqueueProjectMutation(projectId, async () => {
      const membership = await this.foundation.local.projects.loadMembership(projectId);
      if (
        !membership
        || membership.hostOwnership.ownsAuthority
        || !membership.authority.hostCaFingerprint
      ) {
        return false;
      }
      const candidates = await discovery.discoverProjectCandidates(
        projectId,
        membership.authority.hostCaFingerprint,
        options,
      );
      if (candidates.length === 0) return false;
      const result = await reconnect.reconnectDiscoveredProject({
        candidates,
        projectId,
      }, options);
      if (result.status !== 'success') {
        if (
          result.status === 'failure'
          && (
            result.error.code === 'authority-integrity-error'
            || result.error.group === 'authorization'
          )
        ) {
          throw result.error;
        }
        return false;
      }
      this.resetProjectConnection(projectId);
      return true;
    }));
  }

  async synchronizeAcceptedMain(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabReconciliationOutcome>> {
    return this.enqueueProjectMutation(
      projectId,
      () => this.synchronizeAcceptedMainUnlocked(projectId, options),
    );
  }

  private async synchronizeAcceptedMainUnlocked(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabReconciliationOutcome>> {
    const runtime = await this.runtime();
    const existing = await runtime.conflicts.findProject(projectId, options);
    if (existing.status !== 'success') return existing;
    if (existing.value) return conflictResult(existing.value.descriptor);
    const result = await runtime.reconciliation.reconcile(projectId, options);
    if (result.status !== 'conflict') return result;
    await runtime.coordinator.captureConflict(result.conflict, options);
    const started = await runtime.conflicts.start(result.conflict, options);
    return started.status === 'success' ? result : started;
  }

  async findConflict(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession | null>> {
    return (await this.runtime()).conflicts.findProject(projectId, options);
  }

  async readConflict(
    operationId: CollabOperationId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    return (await this.runtime()).conflicts.read(operationId, options);
  }

  async readConflictFile(
    request: CollabConflictFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictFileContent>> {
    return (await this.runtime()).conflicts.readFile(request, options);
  }

  private runtime(): Promise<PublicationRuntime> {
    if (this.runtimePromise) return this.runtimePromise;
    const pending = this.createRuntime();
    this.runtimePromise = pending;
    void pending.catch(() => {
      if (this.runtimePromise === pending) this.runtimePromise = null;
    });
    return pending;
  }

  private ensureEventSubscription(
    projectId: CollabProjectId,
  ): Promise<{ dispose(): void }> {
    const session = this.sessions.acquire(projectId);
    return session.ensureCoordinationSubscription(() => this.projection.subscribe(
      projectId,
      snapshot => {
      const previousMainOid = session.observedAcceptedMainOid;
      const currentMainOid = snapshot.project.mainOid;
      session.observedAcceptedMainOid = currentMainOid;
      const acceptedMainChanged = previousMainOid !== null
        && previousMainOid !== currentMainOid;
      this.notifyCoordination(
        projectId,
        acceptedMainChanged ? 'accepted-main-changed' : 'coordination-changed',
      );
      },
    ));
  }

  private async createRuntime(): Promise<PublicationRuntime> {
    const git = await this.foundation.requireGitFoundation();
    const projects = new LocalPublishProjectPort(
      this.foundation.local.projects,
      this.foundation.local.workspace,
      git.repositories,
    );
    const network = new LocalPublishGitNetworkPort(
      this.options.vaultRoot,
      this.foundation.local.projects,
      this.options.isLocalHostRunning,
      async projectId => {
        await this.control.readSnapshot(projectId);
      },
    );
    const acceptedState = new NativeGitAcceptedStateIntegrator(
      git.repositories,
      git.runner,
      this.foundation.local.pathPolicy,
    );
    const safety = new ReconciliationMutationSafety(acceptedState);
    const publicationState = new CollabPublicationStateStore(
      this.foundation.local.projects,
    );
    const requestDrafts = new CollabRequestDraftStore(
      this.foundation.local.projects,
    );
    const candidates = new NativeGitPublicationCandidateRepository(
      git.repositories,
      git.runner,
    );
    const comparisons = new NativeGitExactComparisonRepository(git.repositories);
    const repository = new NativeGitPublishRepository(git.repositories, {
      acceptedState,
      network,
      pathPolicy: this.foundation.local.pathPolicy,
    });
    const workingTreeReview = new WorkingTreeReviewService(
      projects,
      repository,
      new NativeGitWorkingTreeReviewRepository(
        git.repositories,
        this.foundation.local.pathPolicy,
      ),
    );
    const review = new CollabReviewService(
      this.control,
      new LocalReviewProjectPort(projects, this.foundation.local.projects),
      new NativeGitReviewRepository(git.repositories, network),
    );
    const coordinator = new PublishCoordinator(
      projects,
      repository,
      this.control,
      safety,
      publicationState,
      candidates,
      comparisons,
    );
    const conflicts = new ConflictResolutionCoordinator(
      projects,
      new ConflictScratchStore(this.options.vaultRoot, this.foundation.local.projects),
      new ConflictScratchGitRepository(
        git.repositories,
        git.runner,
        this.foundation.local.pathPolicy,
      ),
      safety,
      new ConflictPublicationReviewPreparer(
        publicationState,
        candidates,
        coordinator,
      ),
    );
    return {
      comparisons,
      conflicts,
      coordinator,
      projects,
      publicationState,
      requestDrafts,
      reconciliation: new ReconciliationCoordinator(
        projects,
        new ReconciliationRepository(repository, acceptedState),
        this.control,
        safety,
        publicationState,
      ),
      review,
      repository,
      workingTreeReview,
    };
  }

  private async saveRequestDraft(
    runtime: PublicationRuntime,
    input: Pick<CollabRequestDraftRecord, 'description' | 'projectId' | 'syncState'>
      & Partial<Pick<
        CollabRequestDraftRecord,
        'baseRequestRevision' | 'requestId' | 'targetHeadOid'
      >>,
  ): Promise<CollabRequestDraftRecord> {
    const existing = await runtime.requestDrafts.load(input.projectId);
    const timestamp = new Date().toISOString();
    const record: CollabRequestDraftRecord = {
      ...(input.baseRequestRevision === undefined
        ? existing?.baseRequestRevision === undefined
          ? {}
          : { baseRequestRevision: existing.baseRequestRevision }
        : { baseRequestRevision: input.baseRequestRevision }),
      createdAt: existing?.createdAt ?? timestamp,
      description: input.description,
      projectId: input.projectId,
      ...(input.requestId === undefined
        ? existing?.requestId === undefined ? {} : { requestId: existing.requestId }
        : { requestId: input.requestId }),
      schemaVersion: COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
      syncState: input.syncState,
      ...(input.targetHeadOid === undefined
        ? existing?.targetHeadOid === undefined ? {} : { targetHeadOid: existing.targetHeadOid }
        : { targetHeadOid: input.targetHeadOid }),
      updatedAt: timestamp,
    };
    await runtime.requestDrafts.save(record);
    return record;
  }

  private async markRequestDraftNeedsAttention(
    runtime: PublicationRuntime,
    expected: CollabRequestDraftRecord,
  ): Promise<void> {
    const draft = await runtime.requestDrafts.load(expected.projectId);
    if (!draft || !this.sameRequestDraft(draft, expected)) return;
    await runtime.requestDrafts.save({
      ...draft,
      syncState: 'needs-attention',
      updatedAt: new Date().toISOString(),
    });
  }

  private async reconcileRequestDraft(
    runtime: PublicationRuntime,
    draft: CollabRequestDraftRecord,
    result: CollabResult<CollabPublishOutcome>,
  ): Promise<void> {
    if (
      result.status === 'success'
      && result.value.request?.status === 'open'
      && result.value.request.description === draft.description
      && result.value.request.latestHeadOid === result.value.localHeadOid
    ) {
      await this.removeRequestDraftIfUnchanged(runtime, draft);
      return;
    }
    if (result.status === 'success') {
      const current = await runtime.requestDrafts.load(draft.projectId);
      if (!current || !this.sameRequestDraft(current, draft)) return;
      await this.saveRequestDraft(runtime, {
        description: draft.description,
        projectId: draft.projectId,
        syncState: 'local',
        targetHeadOid: result.value.localHeadOid,
      });
      return;
    }
    await this.markRequestDraftNeedsAttention(runtime, draft);
  }

  private async removeRequestDraftIfUnchanged(
    runtime: PublicationRuntime,
    expected: CollabRequestDraftRecord,
  ): Promise<void> {
    const current = await runtime.requestDrafts.load(expected.projectId);
    if (current && this.sameRequestDraft(current, expected)) {
      await runtime.requestDrafts.remove(expected.projectId);
    }
  }

  private sameRequestDraft(
    left: CollabRequestDraftRecord,
    right: CollabRequestDraftRecord,
  ): boolean {
    return left.schemaVersion === right.schemaVersion
      && left.projectId === right.projectId
      && left.description === right.description
      && left.syncState === right.syncState
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.requestId === right.requestId
      && left.baseRequestRevision === right.baseRequestRevision
      && left.targetHeadOid === right.targetHeadOid;
  }

  private notifyCoordination(
    projectId: CollabProjectId,
    reason: 'accepted-main-changed' | 'coordination-changed',
  ): void {
    for (const listener of this.coordinationListeners) {
      try {
        listener(projectId, reason);
      } catch {
        // Presentation invalidation observers cannot own projection state.
      }
    }
  }

  private enqueueProjectMutation<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.sessions.acquire(projectId).runMutation(operation);
  }

}
