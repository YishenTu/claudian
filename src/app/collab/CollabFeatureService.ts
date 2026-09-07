import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { type CollabChangeRequest, type CollabComment, type CollabCommentPage, type CollabGitOid, type CollabOperationId, type CollabProjectId, type CollabRequestId, type CollabTicketAcceptedRelationPage, type CollabTicketComment, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketSummary } from '@claudian-collab/protocol';

import type { CollabProjectInspectionLease } from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  StartCloudBootstrapServiceInput,
  SubmitCloudBootstrapServiceParticipantInput,
} from '@/app/collab/bootstrap/CloudBootstrapService';
import type {
  CloudBootstrapTransitionRecord,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import type {
  CollabAuthorityInstallationStatus,
  CollabLocalMembershipRecord,
  CollabLocalProjectIndex,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { HostInstallationBindingService } from '@/app/collab/host-installation/HostInstallationBindingService';
import {
  type CollabPendingProjectOperation,
  decodeCollabPendingProjectOperation,
} from '@/app/collab/PendingProjectOperation';
import type { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import {
  ProjectOperationAdmission,
  type ProjectOperationPolicy,
  type ProjectOperationSuspension,
} from '@/app/collab/ProjectOperationAdmission';
import type { CollabManagerResponsibilityOfferSummary } from '@/core/collab';
import { type CollabAcceptOutcome, type CollabAcceptRequest, type CollabAddCommentRequest, type CollabAddTicketCommentRequest, type CollabBoundedQueryPort, type CollabCancelManagerResponsibilityOfferRequest, type CollabChangeTicketStatusRequest, type CollabConfirmPublishRequest, type CollabConflictFileContent, type CollabConflictFileRequest, type CollabConflictSession, type CollabCoordinationSnapshot, type CollabCreateHostTransferRequest, type CollabCreateManagerResponsibilityOfferRequest, type CollabCreateProjectRequest, type CollabCreateTicketRequest, type CollabDemoteManagerRequest, type CollabFeaturePort, type CollabFeatureState, type CollabFeatureStateListener, type CollabFeatureSubscription, type CollabFinalizeRetiredProjectRequest, type CollabGitStatus, type CollabHostSession, type CollabHostStatus, type CollabHostTransferIntentRequest, type CollabInvitationView, type CollabJoinProjectRequest, type CollabLeaveProjectRequest, type CollabListTicketsRequest, type CollabLocalProjectSummary, type CollabOperationOptions, type CollabPersonalChangesInspection, type CollabProjectInspection, type CollabProjectSelectionProjection, type CollabPromoteManagerRequest, type CollabPublicationReview, type CollabPublicationReviewFileRequest, type CollabPublishOutcome, type CollabPublishRequest, type CollabReconciliationOutcome, type CollabReconnectProjectRequest, type CollabRemoveMemberRequest, type CollabRequestReview, type CollabResult, type CollabResumeSetupRequest, type CollabRetireProjectRequest, type CollabReviewFileContent, type CollabReviewFileRequest, type CollabTicketDetailProjection, type CollabTicketPageProjection, type CollabUpdateRequestMetadataRequest, type CollabUpdateTicketContentRequest, type CollabWorkingTreeReview, type CollabWorkingTreeReviewFileRequest, resolveEffectiveCollabProjectId } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabFeatureFoundationPort {
  readonly local: {
    readonly projects: Pick<
      CollabLocalProjectRepository,
      | 'loadIndex'
      | 'loadMembership'
      | 'loadProjectDocument'
      | 'listPendingOperationProjectIds'
      | 'selectProject'
    >;
    readonly workspace: Pick<CollabWorkspaceService, 'resolveManagedProjectPath'>;
  };
  requireGitFoundation(): Promise<CollabGitFoundation>;
}

export interface CollabProjectSetupPort {
  createProject: CollabProjectSetupService['createProject'];
  resumeSetup: CollabProjectSetupService['resumeSetup'];
}

export interface CollabJoinProjectPort {
  joinProject(
    request: CollabJoinProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>>;
  resumeJoin(
    request: CollabResumeSetupRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>>;
}

export interface CollabLanHostPort {
  getProjectState(projectId: CollabProjectId): {
    readonly endpoint?: string;
    readonly projectId: CollabProjectId;
    readonly status: Exclude<CollabHostStatus, 'not-host'>;
  };
  startProject(projectId: CollabProjectId): Promise<CollabHostSession>;
  stopProject(projectId: CollabProjectId): Promise<CollabHostSession>;
}

export interface CollabMembershipPort {
  cancelManagerResponsibilityOffer(
    request: CollabCancelManagerResponsibilityOfferRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  createInvitation(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabInvitationView>;
  createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  removeMember(
    request: CollabRemoveMemberRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  revokeInvitation(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<void>;
  promoteManager(
    request: CollabPromoteManagerRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  demoteManager(
    request: CollabDemoteManagerRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
}

export interface CollabLocalExitPort {
  leaveProject(
    request: CollabLeaveProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
}

export interface CollabHostTransferPort {
  acceptHostTransfer(
    request: CollabHostTransferIntentRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  cancelHostTransfer(
    request: CollabHostTransferIntentRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  createHostTransfer(
    request: CollabCreateHostTransferRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  declineHostTransfer(
    request: CollabHostTransferIntentRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface CollabRetirementPort {
  close(): Promise<void>;
  finalizeRetiredProject(
    request: CollabFinalizeRetiredProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  retireProject(
    request: CollabRetireProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<void>;
  retryProjectCleanup(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<void>;
}

export interface CollabLifecycleRecoveryPort {
  close(): Promise<void> | void;
  resume(options?: CollabOperationOptions): Promise<void>;
}

export interface CollabPublicationPort {
  abortProjectBackgroundWork(projectId: CollabProjectId): void;
  acceptRequest(
    request: CollabAcceptRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabAcceptOutcome>;
  addComment(
    request: CollabAddCommentRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabComment>;
  addTicketComment(
    request: CollabAddTicketCommentRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabTicketComment>;
  beginProjectInspection(
    projectId: CollabProjectId,
  ): CollabProjectInspectionLease;
  closeTicket(
    request: CollabChangeTicketStatusRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabTicketSummary>;
  confirmPublish(
    request: CollabConfirmPublishRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabPublishOutcome>>;
  createTicket(
    request: CollabCreateTicketRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabTicketDetail>;
  inspectPersonalChanges(
    projectId: CollabProjectId,
    gitStatus: CollabGitStatus,
    coordination: CollabCoordinationSnapshot | undefined,
    options?: CollabOperationOptions,
  ): Promise<CollabPersonalChangesInspection>;
  listTickets(
    request: CollabListTicketsRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketPageProjection>;
  close(): Promise<void>;
  findConflict(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabConflictSession | null>>;
  synchronizeAcceptedMain(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabReconciliationOutcome>>;
  publish(
    request: CollabPublishRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabPublishOutcome>>;
  readGitStatus(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabGitStatus>;
  readCoordinationSnapshot(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabCoordinationSnapshot>;
  readPublishDescription(projectId: CollabProjectId): Promise<string | null>;
  listRequestComments(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabCommentPage>;
  readTicket(
    projectId: CollabProjectId,
    ticketId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketDetailProjection>;
  readTicketPage(
    projectId: CollabProjectId,
    ticketId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabTicketDetailProjection>;
  listTicketComments(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabTicketCommentPage>;
  listTicketAcceptedRelations(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options?: CollabOperationOptions,
  ): Promise<CollabTicketAcceptedRelationPage>;
  reopenTicket(
    request: CollabChangeTicketStatusRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabTicketSummary>;
  scheduleAcceptedMainSynchronization(projectId: CollabProjectId): void;
  prepareReview(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestReview>;
  prepareReviewPage(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    options?: CollabOperationOptions,
  ): Promise<CollabRequestReview>;
  preparePublicationReview(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    options?: CollabOperationOptions,
  ): Promise<CollabPublicationReview>;
  prepareWorkingTreeReview(
    projectId: CollabProjectId,
    baseOid: CollabGitOid,
    options?: CollabOperationOptions,
  ): Promise<CollabWorkingTreeReview>;
  readConflict(
    operationId: CollabOperationId,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabConflictSession>>;
  readConflictFile(
    request: CollabConflictFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabConflictFileContent>>;
  readReviewFile(
    request: CollabReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabReviewFileContent>;
  readPublicationReviewFile(
    request: CollabPublicationReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabReviewFileContent>;
  readWorkingTreeReviewFile(
    request: CollabWorkingTreeReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabReviewFileContent>;
  reconnectProject(
    request: CollabReconnectProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>>;
  subscribeCoordination(
    listener: (
      projectId: CollabProjectId,
      reason: 'accepted-main-changed' | 'coordination-changed',
    ) => void,
  ): { dispose(): void };
  tryAutoReconnect(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<boolean>;
  updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabChangeRequest>;
  updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    options?: CollabOperationOptions,
    idempotencyKey?: string,
  ): Promise<CollabTicketSummary>;
}

export interface CollabFeatureServiceOptions {
  readonly cloudBootstrap: CollabCloudBootstrapPort;
  readonly hostTransfer: CollabHostTransferPort;
  readonly hostInstallation: Pick<HostInstallationBindingService, 'claimLegacy' | 'inspect'>;
  readonly join: CollabJoinProjectPort;
  readonly lanHost: CollabLanHostPort;
  readonly lifecycleRecovery: CollabLifecycleRecoveryPort;
  readonly localExit: CollabLocalExitPort;
  readonly membership: CollabMembershipPort;
  readonly publication: CollabPublicationPort;
  readonly retirement: CollabRetirementPort;
  readonly vaultRoot: string;
}

export interface CollabCloudBootstrapPort {
  cancel(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord>;
  close(): Promise<void>;
  prepareLocalRecovery(): Promise<void>;
  recoverPending(): Promise<void>;
  startFormerHost(
    input: StartCloudBootstrapServiceInput,
  ): Promise<CloudBootstrapTransitionRecord>;
  submitParticipant(
    input: SubmitCloudBootstrapServiceParticipantInput,
  ): Promise<CloudBootstrapTransitionRecord>;
}

function operationError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwInvalidCommentIntent(): never {
  throw operationError('comment-intent-invalid');
}

function mutationIntentKey(prefix: string, intentId: string | undefined): string | undefined {
  if (intentId === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(intentId)) {
    throw operationError(`${prefix}-intent-invalid`);
  }
  return `${prefix}-${intentId}`;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({
    code: 'cancelled',
    recoveryActions: ['retry'],
    safeContext: { reason: 'operation-cancelled' },
  });
}

function isEndpointTrustFailure(error: CollabError): boolean {
  return error.code === 'tls-ca-mismatch' || error.code === 'tls-untrusted';
}

function isHostRestoreLockConflict(error: unknown): boolean {
  return error instanceof CollabError
    && error.safeContext.reason === 'vault-host-already-running';
}

function isUnsupportedLocalMembership(error: unknown): boolean {
  return error instanceof CollabError
    && error.code === 'schema-version-unsupported'
    && error.safeContext.recordKind === 'membership';
}

function waitForHostLockRelease(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 750));
}

function cloneState(state: CollabFeatureState): CollabFeatureState {
  return Object.freeze({
    ...state,
    projects: Object.freeze([...state.projects]),
  });
}

interface CollabProjectProjection {
  readonly projects: readonly CollabLocalProjectSummary[];
  readonly selectedProjectId: CollabProjectId | null;
}

class CollabFeatureServiceCore {
   #activeOperationController: AbortController | null = null;
   #activeOperationProjectId: CollabProjectId | null = null;
   #activeProjectSelections = 0;
   #initializePromise: Promise<CollabResult<CollabFeatureState>> | null = null;
  private readonly listeners = new Set<CollabFeatureStateListener>();
   #lifecycleRecoveryController: AbortController | null = null;
   #lifecycleRecoveryPromise: Promise<void> | null = null;
   readonly #publicationSubscription: { dispose(): void };
   #closePromise: Promise<void> | null = null;
   #closing = false;
  private disposed = false;
   #refreshGeneration = 0;
   #stateValue: CollabFeatureState = cloneState({
    lifecycle: 'uninitialized',
    projects: [],
    selectedProjectId: null,
  });

  constructor(
    private readonly foundation: CollabFeatureFoundationPort,
    private readonly projectSetup: CollabProjectSetupPort,
    private readonly options: CollabFeatureServiceOptions,
    private readonly operationAdmission: ProjectOperationAdmission,
  ) {
    this.#publicationSubscription = options.publication.subscribeCoordination((
      projectId,
      reason,
    ) => {
      if (reason === 'accepted-main-changed') {
        this.scheduleAcceptedMainSynchronization(projectId);
      }
      if (this.#stateValue.selectedProjectId === projectId) {
        void this.operationAdmission.runGlobal(async () => {
          await this.#refreshProjects().catch(error => {
            this.#publishState({
              ...this.#stateValue,
              error: error instanceof CollabError
                ? error
                : operationError('collab-project-refresh-failed'),
            });
          });
        }).catch(() => undefined);
      }
    });
  }

  get state(): CollabFeatureState {
    return this.#stateValue;
  }

  initialize(
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabFeatureState>> {
    if (this.#initializePromise) return this.#initializePromise;
    const pending = this.#initializeUnlocked(options);
    this.#initializePromise = pending;
    const clearPending = () => {
      if (this.#initializePromise === pending) this.#initializePromise = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  async listProjects(
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<readonly CollabLocalProjectSummary[]>> {
    try {
      throwIfCancelled(options.signal);
      const projects = await this.#refreshProjects();
      throwIfCancelled(options.signal);
      return { status: 'success', value: projects };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readProjectSelection(
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabProjectSelectionProjection>> {
    try {
      throwIfCancelled(options.signal);
      const index = await this.foundation.local.projects.loadIndex();
      throwIfCancelled(options.signal);
      const projects = index.projects.map(project => ({ id: project.id, name: project.name }));
      return {
        status: 'success',
        value: {
          projects,
          selectedProjectId: resolveEffectiveCollabProjectId(
            projects,
            index.selectedProjectId,
          ),
        },
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async selectProject(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabProjectInspection>> {
    this.#activeProjectSelections += 1;
    try {
      this.#throwIfDisposed();
      throwIfCancelled(options.signal);
      if (this.#activeOperationProjectId !== null && this.#activeOperationProjectId !== projectId) {
        this.#activeOperationController?.abort();
      }
      const projects = await this.#refreshProjects({ publish: false });
      this.#throwIfDisposed();
      const project = projects.find(candidate => candidate.id === projectId);
      if (!project) {
        return {
          error: new CollabError({ code: 'project-not-found', safeContext: { projectId } }),
          status: 'failure',
        };
      }
      await this.foundation.local.projects.selectProject(projectId);
      this.#throwIfDisposed();
      const inspection = await this.inspectProject(projectId, options);
      this.#throwIfDisposed();
      this.scheduleAcceptedMainSynchronization(projectId);
      this.#publishState({ ...this.#stateValue, projects, selectedProjectId: projectId });
      return inspection;
    } catch (error) {
      return this.#failureResult(error);
    } finally {
      this.#activeProjectSelections -= 1;
    }
  }

  async inspectProject(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabProjectInspection>> {
    let inspection: CollabProjectInspectionLease;
    try {
      inspection = this.beginProjectInspection(projectId);
    } catch (error) {
      return this.#inspectClosedRetiredProject(projectId, options, error);
    }
    try {
      return await this.#inspectProjectWhileStable(
        projectId,
        options,
        inspection.precedingSynchronization,
      );
    } finally {
      inspection.release();
    }
  }

   async #inspectClosedRetiredProject(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    sessionError: unknown,
  ): Promise<CollabResult<CollabProjectInspection>> {
    if (!(sessionError instanceof CollabError) || sessionError.code !== 'project-retired') {
      return this.#failureResult(sessionError);
    }
    try {
      throwIfCancelled(options.signal);
      const projection = await this.#readProjectProjection();
      throwIfCancelled(options.signal);
      const project = projection.projects.find(candidate => candidate.id === projectId);
      return project?.lifecycle === 'retired'
        ? { status: 'success', value: { project } }
        : this.#failureResult(sessionError);
    } catch (error) {
      return this.#failureResult(error);
    }
  }

   async #inspectProjectWhileStable(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    precedingSynchronization: Promise<void> | null,
  ): Promise<CollabResult<CollabProjectInspection>> {
    let projection: CollabProjectProjection;
    try {
      throwIfCancelled(options.signal);
      projection = await this.#readProjectProjection();
      throwIfCancelled(options.signal);
    } catch (error) {
      return this.#failureResult(error);
    }
    let project = projection.projects.find(candidate => candidate.id === projectId);
    if (!project) {
      return {
        error: new CollabError({ code: 'project-not-found', safeContext: { projectId } }),
        status: 'failure',
      };
    }
    if (project.lifecycle === 'retired') {
      return { status: 'success', value: { project } };
    }
    try {
      if (precedingSynchronization) {
        await this.#waitForBackgroundTask(precedingSynchronization, options.signal);
      }
      const conflictResult = await this.options.publication.findConflict(projectId, options);
      if (conflictResult.status !== 'success') return conflictResult;
      const gitStatus = await this.options.publication.readGitStatus(projectId, options);
      throwIfCancelled(options.signal);
      let coordination: CollabCoordinationSnapshot | undefined;
      try {
        coordination = await this.options.publication.readCoordinationSnapshot(
          projectId,
          options,
        );
        if (coordination.stale) {
          project = {
            ...project,
            connectionStatus: project.hostStatus === 'stopped' ? 'host-stopped' : 'offline',
          };
        }
      } catch (error) {
        const collabError = error instanceof CollabError ? error : operationError(
          'collab-snapshot-read-failed',
        );
        if (collabError.code === 'cancelled') throw collabError;
        project = {
          ...project,
          connectionStatus: collabError.group === 'authorization'
            ? 'access-removed'
            : isEndpointTrustFailure(collabError)
              ? 'needs-attention'
            : collabError.group === 'connectivity'
              ? project.hostStatus === 'stopped' ? 'host-stopped' : 'offline'
              : 'needs-attention',
        };
      }
      const inspectedPersonalChanges = await this.options.publication.inspectPersonalChanges(
        projectId,
        gitStatus,
        coordination,
        options,
      );
      const personalChanges = conflictResult.value
        ? {
          ...inspectedPersonalChanges,
          action: 'resolve-changes' as const,
          conflictOperationId: conflictResult.value.descriptor.operationId,
          hasContribution: true,
          updateAvailable: gitStatus.includesAcceptedMain === false,
        }
        : inspectedPersonalChanges;
      return {
        status: 'success',
        value: {
          ...(conflictResult.value ? { conflict: conflictResult.value } : {}),
          ...(coordination ? { coordination } : {}),
          gitStatus,
          personalChanges,
          project,
        },
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async createProject(
    request: CollabCreateProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const result = await this.projectSetup.createProject(request, options);
    if (result.status !== 'success') {
      await this.#refreshAfterMutation(result);
      return result;
    }
    try {
      const session = await this.options.lanHost.startProject(result.value.id);
      const started: CollabResult<CollabLocalProjectSummary> = {
        status: 'success',
        value: {
          ...result.value,
          connectionStatus: 'connected',
          hostStatus: session.status,
        },
      };
      await this.#refreshAfterMutation(started);
      return started;
    } catch {
      // Project creation is durable even when the local listener cannot start.
      // The saved auto-start intent and Project management retry remain available.
      await this.#refreshAfterMutation(result);
      return result;
    }
  }

  async resumeSetup(
    request: CollabResumeSetupRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      const pending = await this.#findPendingOperation(request.operationId);
      if (!pending) {
        return {
          error: new CollabError({
            code: 'project-not-found',
            safeContext: { operationId: request.operationId },
          }),
          status: 'failure',
        };
      }
      const result = pending.kind === 'join-project'
        ? await this.options.join.resumeJoin(request, options)
        : await this.projectSetup.resumeSetup(request, options);
      await this.#refreshAfterMutation(result);
      return result;
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async getPendingSetupOperationId(
    projectId: CollabProjectId,
  ): Promise<CollabOperationId | null> {
    const pending = await this.foundation.local.projects.loadProjectDocument(
      projectId,
      'pending-operation',
      decodeCollabPendingProjectOperation,
    );
    return pending?.record.operationId ?? null;
  }

  async listPendingSetupOperationIds(): Promise<readonly CollabOperationId[]> {
    const projectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    const operationIds: CollabOperationId[] = [];
    const seen = new Set<CollabOperationId>();
    for (const projectId of projectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending) {
        if (seen.has(pending.record.operationId)) {
          throw operationError('pending-operation-duplicate');
        }
        seen.add(pending.record.operationId);
        operationIds.push(pending.record.operationId);
      }
    }
    return operationIds;
  }

  async joinProject(
    request: CollabJoinProjectRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const result = await this.options.join.joinProject(request, options);
    await this.#refreshAfterMutation(result);
    return result;
  }

  async reconnectProject(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    if (this.#activeOperationController) {
      return {
        error: new CollabError({
          code: 'working-tree-busy',
          recoveryActions: ['retry'],
          safeContext: { reason: 'collab-operation-already-active' },
        }),
        status: 'failure',
      };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    this.#activeOperationController = controller;
    this.#activeOperationProjectId = request.projectId;
    const operationId = `reconnect-${randomUUID().replaceAll('-', '')}`;
    this.#publishState({
      ...this.#stateValue,
      activeOperation: {
        cancellable: true,
        id: operationId,
        kind: 'reconnect-project',
        phase: 'validating',
        startedAt: new Date().toISOString(),
      },
    });
    try {
      throwIfCancelled(controller.signal);
      const result = await this.options.publication.reconnectProject(request, {
        signal: controller.signal,
      });
      await this.#refreshAfterMutation(result);
      return result;
    } catch (error) {
      return this.#failureResult(error);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.#activeOperationController === controller) {
        this.#activeOperationController = null;
        this.#activeOperationProjectId = null;
        const { activeOperation: _activeOperation, ...state } = this.#stateValue;
        this.#publishState(state);
      }
    }
  }

  async readSnapshot(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabCoordinationSnapshot>> {
    try {
      throwIfCancelled(options.signal);
      const snapshot = await this.options.publication.readCoordinationSnapshot(
        projectId,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: snapshot };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readPublishDescription(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<string | null>> {
    try {
      throwIfCancelled(options.signal);
      const description = await this.options.publication.readPublishDescription(projectId);
      throwIfCancelled(options.signal);
      return { status: 'success', value: description };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async publish(
    request: CollabPublishRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    if (this.#activeOperationController) {
      return {
        error: new CollabError({
          code: 'working-tree-busy',
          recoveryActions: ['retry'],
          safeContext: { reason: 'collab-operation-already-active' },
        }),
        status: 'failure',
      };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    this.#activeOperationController = controller;
    this.#activeOperationProjectId = request.projectId;
    const operationId = `publish-${randomUUID().replaceAll('-', '')}`;
    this.#publishState({
      ...this.#stateValue,
      activeOperation: {
        cancellable: true,
        id: operationId,
        kind: 'publish',
        phase: 'validating',
        startedAt: new Date().toISOString(),
      },
    });
    try {
      throwIfCancelled(controller.signal);
      return await this.options.publication.publish(request, {
        signal: controller.signal,
      });
    } catch (error) {
      return this.#failureResult(error);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.#activeOperationController === controller) {
        this.#activeOperationController = null;
        this.#activeOperationProjectId = null;
        const { activeOperation: _activeOperation, ...state } = this.#stateValue;
        this.#publishState(state);
      }
    }
  }

  async confirmPublish(
    request: CollabConfirmPublishRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    try {
      throwIfCancelled(options.signal);
      return await this.options.publication.confirmPublish(request, options);
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readConflict(
    operationId: CollabOperationId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    try {
      throwIfCancelled(options.signal);
      return await this.options.publication.readConflict(operationId, options);
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readConflictFile(
    request: CollabConflictFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictFileContent>> {
    try {
      throwIfCancelled(options.signal);
      return await this.options.publication.readConflictFile(request, options);
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async createInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabInvitationView>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.membership.createInvitation(projectId, options),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async revokeInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    try {
      throwIfCancelled(options.signal);
      await this.options.membership.revokeInvitation(projectId, options);
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async startHost(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabHostSession>> {
    try {
      throwIfCancelled(options.signal);
      if (await this.options.hostInstallation.inspect(projectId) !== 'hosted-here') {
        throw operationError('host-installation-not-owned');
      }
      const session = await this.options.lanHost.startProject(projectId);
      await this.#refreshAfterMutation({ status: 'success', value: session });
      return {
        status: 'success',
        value: { projectId: session.projectId, status: session.status },
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async claimLegacyHostInstallation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      throwIfCancelled(options.signal);
      const [index, membership] = await Promise.all([
        this.foundation.local.projects.loadIndex(),
        this.foundation.local.projects.loadMembership(projectId),
      ]);
      const project = index.projects.find(candidate => candidate.id === projectId);
      const lifecycle = project?.lifecycle ?? membership?.lifecycle ?? 'active';
      if (
        !project
        || lifecycle !== 'active'
        || !membership
        || !isCollabLocalLanMembership(membership)
        || !membership.hostOwnership.ownsAuthority
      ) {
        throw operationError('host-installation-claim-unavailable');
      }
      const status = await this.options.hostInstallation.inspect(projectId);
      if (status === 'legacy-unbound' || status === 'hosted-here') {
        await this.options.hostInstallation.claimLegacy(projectId);
      } else {
        throw operationError('host-installation-claim-unavailable');
      }
      throwIfCancelled(options.signal);
      const projects = await this.#refreshProjects();
      const summary = projects.find(candidate => candidate.id === projectId);
      if (!summary) throw operationError('host-installation-claim-unavailable');
      return { status: 'success', value: summary };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async stopHost(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabHostSession>> {
    try {
      throwIfCancelled(options.signal);
      const session = await this.options.lanHost.stopProject(projectId);
      await this.#refreshAfterMutation({ status: 'success', value: session });
      return { status: 'success', value: session };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async restoreHosts(): Promise<void> {
    const index = await this.foundation.local.projects.loadIndex();
    const retryAfterLockRelease: CollabProjectId[] = [];
    let firstError: unknown;
    for (const project of index.projects) {
      try {
        const membership = await this.foundation.local.projects.loadMembership(project.id);
        if (
          !membership
          || !isCollabLocalLanMembership(membership)
          || !membership.hostOwnership.ownsAuthority
          || await this.options.hostInstallation.inspect(project.id) !== 'hosted-here'
          || membership.hostOwnership.autoStart === false
        ) {
          continue;
        }
        await this.options.lanHost.startProject(project.id);
      } catch (error) {
        if (isHostRestoreLockConflict(error)) retryAfterLockRelease.push(project.id);
        else firstError ??= error;
        // One unavailable Host Project must not prevent other saved Hosts from restoring.
      }
    }
    if (retryAfterLockRelease.length > 0) {
      await waitForHostLockRelease();
      for (const projectId of retryAfterLockRelease) {
        await this.options.lanHost.startProject(projectId)
          .catch(error => {
            firstError ??= error;
          });
      }
    }
    await this.#refreshProjects();
    if (firstError instanceof Error) throw firstError;
    if (firstError) throw operationError('collab-host-restore-failed');
  }

  async listRequestComments(
    projectId: CollabProjectId,
    requestId: string,
    query: { readonly cursor?: string; readonly limit?: number } = {},
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabCommentPage>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.listRequestComments(
          projectId,
          requestId,
          query,
          options,
        ),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async addComment(
    request: CollabAddCommentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabComment>> {
    try {
      throwIfCancelled(options.signal);
      const idempotencyKey = request.intentId === undefined
        ? undefined
        : /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(request.intentId)
          ? `comment-${request.intentId}`
          : throwInvalidCommentIntent();
      const comment = await this.options.publication.addComment(
        request,
        options,
        idempotencyKey,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: comment };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async listTickets(
    request: CollabListTicketsRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketPageProjection>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.listTickets(request, options),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readTicket(
    projectId: CollabProjectId,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketDetailProjection>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.readTicket(projectId, ticketId, options),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readTicketPage(
    projectId: CollabProjectId,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketDetailProjection>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.readTicketPage(projectId, ticketId, options),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async listTicketComments(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number } = {},
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketCommentPage>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.listTicketComments(
          projectId,
          ticketId,
          query,
          options,
        ),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async listTicketAcceptedRelations(
    projectId: CollabProjectId,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number } = {},
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketAcceptedRelationPage>> {
    try {
      throwIfCancelled(options.signal);
      return {
        status: 'success',
        value: await this.options.publication.listTicketAcceptedRelations(
          projectId,
          ticketId,
          query,
          options,
        ),
      };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async createTicket(
    request: CollabCreateTicketRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketDetail>> {
    try {
      throwIfCancelled(options.signal);
      const value = await this.options.publication.createTicket(
        request,
        options,
        mutationIntentKey('ticket-create', request.intentId),
      );
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketSummary>> {
    try {
      throwIfCancelled(options.signal);
      const value = await this.options.publication.updateTicketContent(
        request,
        options,
        mutationIntentKey('ticket-content', request.intentId),
      );
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async addTicketComment(
    request: CollabAddTicketCommentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketComment>> {
    try {
      throwIfCancelled(options.signal);
      const value = await this.options.publication.addTicketComment(
        request,
        options,
        mutationIntentKey('ticket-comment', request.intentId),
      );
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async closeTicket(
    request: CollabChangeTicketStatusRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketSummary>> {
    return this.#changeTicketStatus('close', request, options);
  }

  async reopenTicket(
    request: CollabChangeTicketStatusRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabTicketSummary>> {
    return this.#changeTicketStatus('reopen', request, options);
  }

  async updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabChangeRequest>> {
    try {
      throwIfCancelled(options.signal);
      const value = await this.options.publication.updateRequestMetadata(
        request,
        options,
        mutationIntentKey('request-metadata', request.intentId),
      );
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

   async #changeTicketStatus(
    action: 'close' | 'reopen',
    request: CollabChangeTicketStatusRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketSummary>> {
    try {
      throwIfCancelled(options.signal);
      const method = action === 'close'
        ? this.options.publication.closeTicket.bind(this.options.publication)
        : this.options.publication.reopenTicket.bind(this.options.publication);
      const value = await method(
        request,
        options,
        mutationIntentKey(`ticket-${action}`, request.intentId),
      );
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async prepareReview(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabRequestReview>> {
    try {
      throwIfCancelled(options.signal);
      const review = await this.options.publication.prepareReview(
        projectId,
        requestId,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: review };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async prepareReviewPage(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabRequestReview>> {
    try {
      throwIfCancelled(options.signal);
      const review = await this.options.publication.prepareReviewPage(
        projectId,
        requestId,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: review };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readReviewFile(
    request: CollabReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabReviewFileContent>> {
    try {
      throwIfCancelled(options.signal);
      const content = await this.options.publication.readReviewFile(request, options);
      throwIfCancelled(options.signal);
      return { status: 'success', value: content };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async preparePublicationReview(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabPublicationReview>> {
    try {
      throwIfCancelled(options.signal);
      const review = await this.options.publication.preparePublicationReview(
        projectId,
        operationId,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: review };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async prepareWorkingTreeReview(
    projectId: CollabProjectId,
    baseOid: CollabGitOid,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabWorkingTreeReview>> {
    try {
      throwIfCancelled(options.signal);
      const review = await this.options.publication.prepareWorkingTreeReview(
        projectId,
        baseOid,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: review };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readPublicationReviewFile(
    request: CollabPublicationReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabReviewFileContent>> {
    try {
      throwIfCancelled(options.signal);
      const content = await this.options.publication.readPublicationReviewFile(
        request,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: content };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async readWorkingTreeReviewFile(
    request: CollabWorkingTreeReviewFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabReviewFileContent>> {
    try {
      throwIfCancelled(options.signal);
      const content = await this.options.publication.readWorkingTreeReviewFile(
        request,
        options,
      );
      throwIfCancelled(options.signal);
      return { status: 'success', value: content };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async acceptRequest(
    request: CollabAcceptRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabAcceptOutcome>> {
    try {
      throwIfCancelled(options.signal);
      const coordination = await this.options.publication.readCoordinationSnapshot(
        request.projectId,
        options,
      );
      if (
        coordination.source !== 'online'
        || coordination.stale
        || coordination.syncState.status !== 'synchronized'
      ) {
        throw new CollabError({
          code: 'authority-not-synchronized',
          recoveryActions: ['retry'],
        });
      }
      const snapshot = coordination.snapshot;
      if (snapshot.currentMember.role !== 'manager') {
        throw new CollabError({ code: 'authorization-denied' });
      }
      const outcome = await this.options.publication.acceptRequest(
        request,
        options,
        mutationIntentKey('accept', request.intentId),
      );
      throwIfCancelled(options.signal);
      this.#throwIfDisposed();
      this.scheduleAcceptedMainSynchronization(request.projectId);
      return { status: 'success', value: outcome };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async removeMember(
    request: CollabRemoveMemberRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    try {
      throwIfCancelled(options.signal);
      await this.options.membership.removeMember(request, options);
      await this.#refreshProjects();
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async leaveProject(
    request: CollabLeaveProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    try {
      throwIfCancelled(options.signal);
      await this.options.localExit.leaveProject(request, options);
      await this.#refreshProjects();
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabManagerResponsibilityOfferSummary>> {
    return this.#runMembershipMutation(
      membership => membership.createManagerResponsibilityOffer(request, options),
    );
  }

  async cancelManagerResponsibilityOffer(
    request: CollabCancelManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabManagerResponsibilityOfferSummary>> {
    return this.#runMembershipMutation(
      membership => membership.cancelManagerResponsibilityOffer(request, options),
    );
  }

  async promoteManager(
    request: CollabPromoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    try {
      throwIfCancelled(options.signal);
      await this.options.membership.promoteManager(request, options);
      await this.#refreshProjects();
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  async demoteManager(
    request: CollabDemoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    try {
      throwIfCancelled(options.signal);
      await this.options.membership.demoteManager(request, options);
      await this.#refreshProjects();
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

  createHostTransfer(
    request: CollabCreateHostTransferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.hostTransfer,
      port => port.createHostTransfer(request, options),
    );
  }

  acceptHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.hostTransfer,
      port => port.acceptHostTransfer(request, options),
    );
  }

  declineHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.hostTransfer,
      port => port.declineHostTransfer(request, options),
    );
  }

  cancelHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.hostTransfer,
      port => port.cancelHostTransfer(request, options),
    );
  }

  retireProject(
    request: CollabRetireProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.retirement,
      port => port.retireProject(request, options),
    );
  }

  finalizeRetiredProject(
    request: CollabFinalizeRetiredProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.retirement,
      port => port.finalizeRetiredProject(request, options),
    );
  }

  retryProjectCleanup(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<void>> {
    return this.#runLifecycleMutation(
      this.options.retirement,
      port => port.retryProjectCleanup(projectId, options),
    );
  }

  restoreLifecycle(): Promise<void> {
    if (this.#lifecycleRecoveryPromise) return this.#lifecycleRecoveryPromise;
    const controller = new AbortController();
    this.#lifecycleRecoveryController = controller;
    const recovery = (async () => {
      try {
        await this.options.lifecycleRecovery.resume({ signal: controller.signal });
        await this.#refreshProjects();
      } finally {
        controller.abort();
        if (this.#lifecycleRecoveryController === controller) {
          this.#lifecycleRecoveryController = null;
        }
      }
    })();
    this.#lifecycleRecoveryPromise = recovery;
    const clearRecovery = () => {
      if (this.#lifecycleRecoveryPromise === recovery) this.#lifecycleRecoveryPromise = null;
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }

  async refreshLifecycleProjection(): Promise<void> {
    await this.#refreshProjects();
  }

  abortProjectBackgroundWork(projectId: CollabProjectId): void {
    this.options.publication.abortProjectBackgroundWork(projectId);
  }

  subscribe(listener: CollabFeatureStateListener): CollabFeatureSubscription {
    if (this.#closing || this.disposed) return { dispose: () => undefined };
    this.listeners.add(listener);
    try {
      listener(this.#stateValue);
    } catch {
      // Presentation subscribers cannot invalidate application state.
    }
    return { dispose: () => this.listeners.delete(listener) };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.operationAdmission.beginClose();
    this.#activeOperationController?.abort();
    this.#lifecycleRecoveryController?.abort();
    const lifecycleRecoveryDrain = this.#lifecycleRecoveryPromise?.catch(() => undefined)
      ?? Promise.resolve();
    let lifecycleRecoveryClose: Promise<void>;
    try {
      lifecycleRecoveryClose = Promise.resolve(this.options.lifecycleRecovery.close())
        .catch(() => undefined);
    } catch {
      lifecycleRecoveryClose = Promise.resolve();
    }
    const close = (async () => {
      await this.operationAdmission.drain();
      await lifecycleRecoveryDrain;
      await this.options.cloudBootstrap.close();
      await lifecycleRecoveryClose;
      await Promise.resolve()
        .then(() => this.options.retirement.close())
        .catch(() => undefined);
      await Promise.resolve()
        .then(() => this.options.hostTransfer.close())
        .catch(() => undefined);
      this.disposed = true;
      this.#publicationSubscription.dispose();
      try {
        await this.options.publication.close();
      } finally {
        this.listeners.clear();
      }
    })();
    this.#closePromise = close;
    return close;
  }

   async #initializeUnlocked(
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabFeatureState>> {
    this.#publishState({ ...this.#stateValue, error: undefined, lifecycle: 'initializing' });
    try {
      this.#throwIfDisposed();
      throwIfCancelled(options.signal);
      const gitFoundation = this.foundation.requireGitFoundation().then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ reason, status: 'rejected' as const }),
      );
      const projects = await this.#refreshProjects();
      const gitFoundationResult = await gitFoundation;
      this.#throwIfDisposed();
      throwIfCancelled(options.signal);
      const selected = projects.find(project => project.id === this.#stateValue.selectedProjectId);
      if (
        gitFoundationResult.status === 'rejected'
        && selected?.lifecycle !== 'retired'
      ) throw gitFoundationResult.reason;
      if (
        selected
        && selected.lifecycle !== 'retired'
        && selected.health === 'healthy'
      ) {
        this.scheduleAcceptedMainSynchronization(selected.id);
      }
      this.#publishState({ ...this.#stateValue, error: undefined, lifecycle: 'ready' });
      return { status: 'success', value: this.#stateValue };
    } catch (error) {
      const collabError = error instanceof CollabError
        ? error
        : operationError('collab-initialize-failed');
      if (collabError.code === 'cancelled') {
        this.#publishState({ ...this.#stateValue, lifecycle: 'uninitialized' });
        return { durableProgress: false, status: 'cancelled' };
      }
      this.#publishState({
        ...this.#stateValue,
        error: collabError,
        lifecycle: 'failed',
      });
      return { error: collabError, status: 'failure' };
    }
  }

  private scheduleAcceptedMainSynchronization(projectId: CollabProjectId): void {
    if (this.#closing || this.disposed) return;
    this.options.publication.scheduleAcceptedMainSynchronization(projectId);
  }

   #waitForBackgroundTask(task: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return task;
    if (signal.aborted) return Promise.reject(new CollabError({ code: 'cancelled' }));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new CollabError({ code: 'cancelled' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void task.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  private beginProjectInspection(projectId: CollabProjectId): CollabProjectInspectionLease {
    return this.options.publication.beginProjectInspection(projectId);
  }

   async #refreshProjects(
    options: { readonly publish?: boolean } = {},
  ): Promise<readonly CollabLocalProjectSummary[]> {
    const generation = ++this.#refreshGeneration;
    const projection = await this.#readProjectProjection();
    if (
      options.publish !== false
      && generation === this.#refreshGeneration
      && this.#activeProjectSelections === 0
    ) {
      this.#publishState({
        ...this.#stateValue,
        projects: projection.projects,
        selectedProjectId: projection.selectedProjectId,
      });
    }
    return projection.projects;
  }

   async #readProjectProjection(): Promise<CollabProjectProjection> {
    const index = await this.foundation.local.projects.loadIndex();
    const projects = await Promise.all(index.projects.map(async project => {
      const [membership, pending, workingCopyHealthy] = await Promise.all([
        this.foundation.local.projects.loadMembership(project.id).catch(error => {
          if (isUnsupportedLocalMembership(error)) return null;
          throw error;
        }),
        this.foundation.local.projects.loadProjectDocument(
          project.id,
          'pending-operation',
          decodeCollabPendingProjectOperation,
        ),
        this.#hasWorkingCopy(project.workspacePath),
      ]);
      return this.#projectSummary(project, membership, pending !== null, workingCopyHealthy);
    }));
    return { projects, selectedProjectId: index.selectedProjectId };
  }

   async #hasWorkingCopy(workspacePath: string): Promise<boolean> {
    try {
      const absolutePath = await this.foundation.local.workspace.resolveManagedProjectPath(
        workspacePath,
      );
      const gitDirectory = path.join(absolutePath, '.git');
      const [workingCopyStat, gitDirectoryStat] = await Promise.all([
        lstat(absolutePath),
        lstat(gitDirectory),
      ]);
      return workingCopyStat.isDirectory()
        && !workingCopyStat.isSymbolicLink()
        && gitDirectoryStat.isDirectory()
        && !gitDirectoryStat.isSymbolicLink();
    } catch {
      return false;
    }
  }

   async #projectSummary(
    project: CollabLocalProjectIndex['projects'][number],
    membership: CollabLocalMembershipRecord | null,
    pending: boolean,
    workingCopyExists: boolean,
  ): Promise<CollabLocalProjectSummary> {
    const lifecycle = project.lifecycle ?? membership?.lifecycle;
    const effectiveLifecycle = lifecycle ?? 'active';
    const lanMembership = membership && isCollabLocalLanMembership(membership)
      ? membership
      : null;
    const ownsAuthority = lanMembership?.hostOwnership.ownsAuthority === true;
    let installationInspectionFailed = false;
    let inspectedInstallationStatus: CollabAuthorityInstallationStatus = 'absent';
    if (effectiveLifecycle !== 'retired' && ownsAuthority) {
      try {
        inspectedInstallationStatus = await this.options.hostInstallation.inspect(project.id);
      } catch {
        installationInspectionFailed = true;
      }
    }
    const hostInstallationStatus = inspectedInstallationStatus === 'absent'
      ? 'not-host'
      : inspectedInstallationStatus;
    const hostStatus = effectiveLifecycle === 'retired'
      ? 'not-host'
      : hostInstallationStatus === 'hosted-here'
      ? this.options.lanHost.getProjectState(project.id).status
      : hostInstallationStatus === 'legacy-unbound'
        ? 'stopped'
      : 'not-host';
    return {
      authorityKind: project.authorityKind,
      connectionStatus: effectiveLifecycle === 'retired'
        ? 'offline'
        : hostStatus === 'running'
        ? 'connected'
        : hostStatus === 'needs-attention'
          ? 'needs-attention'
          : hostInstallationStatus === 'hosted-here'
            || hostInstallationStatus === 'legacy-unbound'
          ? 'host-stopped'
          : membership?.authority.kind === 'cloud'
            ? 'connected'
            : lanMembership?.authority.endpoint
            ? 'connected'
            : 'offline',
      health: project.cleanupStatus === 'failed' || installationInspectionFailed
        ? 'needs-attention'
        : effectiveLifecycle === 'retired'
          ? 'healthy'
          : pending
        ? 'needs-attention'
        : workingCopyExists && membership
          ? 'healthy'
          : workingCopyExists
            ? 'needs-attention'
            : 'missing',
      hostStatus,
      hostInstallationStatus,
      id: project.id,
      name: project.name,
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(project.cleanupStatus === undefined
        ? {}
        : { cleanupStatus: project.cleanupStatus }),
      ...(project.retiredAt === undefined ? {} : { retiredAt: project.retiredAt }),
      ...(membership ? { role: membership.member.role } : {}),
      workspacePath: project.workspacePath,
    };
  }

   async #refreshAfterMutation<T>(result: CollabResult<T>): Promise<void> {
    if (result.status === 'success' || result.status === 'recovery-required') {
      await this.#refreshProjects().catch(error => {
        this.#publishState({
          ...this.#stateValue,
          error: error instanceof CollabError
            ? error
            : operationError('collab-project-refresh-failed'),
        });
      });
    }
  }

   async #runMembershipMutation<T>(
    mutation: (membership: CollabMembershipPort) => Promise<T>,
  ): Promise<CollabResult<T>> {
    try {
      const value = await mutation(this.options.membership);
      await this.#refreshProjects();
      return { status: 'success', value };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

   async #runLifecycleMutation<Port>(
    port: Port,
    mutation: (port: Port) => Promise<void>,
  ): Promise<CollabResult<void>> {
    try {
      await mutation(port);
      await this.#refreshProjects();
      return { status: 'success', value: undefined };
    } catch (error) {
      return this.#failureResult(error);
    }
  }

   async #findPendingOperation(
    operationId: CollabOperationId,
  ): Promise<CollabPendingProjectOperation | null> {
    const projectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    let match: CollabPendingProjectOperation | null = null;
    for (const projectId of projectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending?.record.operationId === operationId) {
        if (match) throw operationError('pending-operation-duplicate');
        match = pending;
      }
    }
    return match;
  }

   #failureResult<T>(error: unknown): CollabResult<T> {
    const collabError = error instanceof CollabError
      ? error
      : operationError('collab-operation-failed');
    return collabError.code === 'cancelled'
      ? { durableProgress: false, status: 'cancelled' }
      : { error: collabError, status: 'failure' };
  }

   #publishState(state: CollabFeatureState): void {
    if (this.disposed) return;
    this.#stateValue = cloneState(state);
    for (const listener of this.listeners) {
      try {
        listener(this.#stateValue);
      } catch {
        // Presentation subscribers cannot invalidate application state.
      }
    }
  }

   #throwIfDisposed(): void {
    if (this.#closing || this.disposed) {
      throw new CollabError({
        code: 'cancelled',
        safeContext: { reason: 'collab-feature-closing' },
      });
    }
  }

}

export class CollabFeatureService implements CollabFeaturePort {
  readonly boundedQueries: CollabBoundedQueryPort;
  private readonly cloudBootstrap: CollabCloudBootstrapPort;
   readonly #operationAdmission = new ProjectOperationAdmission();
  private readonly core: CollabFeatureServiceCore;

  constructor(
    foundation: CollabFeatureFoundationPort,
    projectSetup: CollabProjectSetupPort,
    options: CollabFeatureServiceOptions,
  ) {
    this.cloudBootstrap = options.cloudBootstrap;
    this.core = new CollabFeatureServiceCore(
      foundation,
      projectSetup,
      options,
      this.#operationAdmission,
    );
    this.boundedQueries = Object.freeze({
      listRequestComments: (
        projectId: CollabProjectId,
        requestId: CollabRequestId,
        query?: { readonly cursor?: string; readonly limit?: number },
        operationOptions?: CollabOperationOptions,
      ) => this.project(
        () => projectId,
        'active',
        () => this.core.listRequestComments(projectId, requestId, query, operationOptions),
      ),
      listTicketAcceptedRelations: (
        projectId: CollabProjectId,
        ticketId: string,
        query?: { readonly cursor?: string; readonly limit?: number },
        operationOptions?: CollabOperationOptions,
      ) => this.project(
        () => projectId,
        'active',
        () => this.core.listTicketAcceptedRelations(projectId, ticketId, query, operationOptions),
      ),
      listTicketComments: (
        projectId: CollabProjectId,
        ticketId: string,
        query?: { readonly cursor?: string; readonly limit?: number },
        operationOptions?: CollabOperationOptions,
      ) => this.project(
        () => projectId,
        'active',
        () => this.core.listTicketComments(projectId, ticketId, query, operationOptions),
      ),
      prepareReview: (
        projectId: CollabProjectId,
        requestId: CollabRequestId,
        operationOptions?: CollabOperationOptions,
      ) => this.project(
        () => projectId,
        'active',
        () => this.core.prepareReviewPage(projectId, requestId, operationOptions),
      ),
      readTicket: (
        projectId: CollabProjectId,
        ticketId: string,
        operationOptions?: CollabOperationOptions,
      ) => this.project(
        () => projectId,
        'active',
        () => this.core.readTicketPage(projectId, ticketId, operationOptions),
      ),
    });
  }

  get state(): CollabFeatureState {
    return this.core.state;
  }

  initialize: CollabFeaturePort['initialize'] = (...args) => (
    this.runGlobal(() => this.core.initialize(...args))
  );
  listProjects: CollabFeaturePort['listProjects'] = (...args) => (
    this.runGlobal(() => this.core.listProjects(...args))
  );
  readProjectSelection: CollabFeaturePort['readProjectSelection'] = (...args) => (
    this.runGlobal(() => this.core.readProjectSelection(...args))
  );
  selectProject: CollabFeaturePort['selectProject'] = (...args) => (
    this.project(() => args[0], 'retired-local', () => this.core.selectProject(...args))
  );
  inspectProject: CollabFeaturePort['inspectProject'] = (...args) => (
    this.project(() => args[0], 'retired-local', () => this.core.inspectProject(...args))
  );
  createProject: CollabFeaturePort['createProject'] = (...args) => (
    this.runGlobal(() => this.core.createProject(...args))
  );
  joinProject: CollabFeaturePort['joinProject'] = (...args) => (
    this.runGlobal(() => this.core.joinProject(...args))
  );
  reconnectProject: CollabFeaturePort['reconnectProject'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.reconnectProject(...args))
  );
  resumeSetup: CollabFeaturePort['resumeSetup'] = (...args) => (
    this.runGlobal(() => this.core.resumeSetup(...args))
  );
  readSnapshot: CollabFeaturePort['readSnapshot'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.readSnapshot(...args))
  );
  readPublishDescription: CollabFeaturePort['readPublishDescription'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.readPublishDescription(...args))
  );
  publish: CollabFeaturePort['publish'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.publish(...args))
  );
  confirmPublish: CollabFeaturePort['confirmPublish'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.confirmPublish(...args))
  );
  prepareWorkingTreeReview: CollabFeaturePort['prepareWorkingTreeReview'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.prepareWorkingTreeReview(...args))
  );
  readWorkingTreeReviewFile: CollabFeaturePort['readWorkingTreeReviewFile'] = (...args) => (
    this.project(
      () => args[0].projectId,
      'active',
      () => this.core.readWorkingTreeReviewFile(...args),
    )
  );
  readConflict: CollabFeaturePort['readConflict'] = (...args) => (
    this.runGlobal(() => this.core.readConflict(...args))
  );
  readConflictFile: CollabFeaturePort['readConflictFile'] = (...args) => (
    this.runGlobal(() => this.core.readConflictFile(...args))
  );
  createInvitation: CollabFeaturePort['createInvitation'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.createInvitation(...args))
  );
  revokeInvitation: CollabFeaturePort['revokeInvitation'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.revokeInvitation(...args))
  );
  claimLegacyHostInstallation: CollabFeaturePort[
    'claimLegacyHostInstallation'
  ] = (...args) => (
    this.project(
      () => args[0],
      'active',
      () => this.core.claimLegacyHostInstallation(...args),
    )
  );
  startHost: CollabFeaturePort['startHost'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.startHost(...args))
  );
  stopHost: CollabFeaturePort['stopHost'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.stopHost(...args))
  );
  prepareReview: CollabFeaturePort['prepareReview'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.prepareReview(...args))
  );
  preparePublicationReview: CollabFeaturePort['preparePublicationReview'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.preparePublicationReview(...args))
  );
  readReviewFile: CollabFeaturePort['readReviewFile'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.readReviewFile(...args))
  );
  readPublicationReviewFile: CollabFeaturePort['readPublicationReviewFile'] = (...args) => (
    this.project(
      () => args[0].projectId,
      'active',
      () => this.core.readPublicationReviewFile(...args),
    )
  );
  addComment: CollabFeaturePort['addComment'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.addComment(...args))
  );
  listTickets: CollabFeaturePort['listTickets'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.listTickets(...args))
  );
  readTicket: CollabFeaturePort['readTicket'] = (...args) => (
    this.project(() => args[0], 'active', () => this.core.readTicket(...args))
  );
  createTicket: CollabFeaturePort['createTicket'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.createTicket(...args))
  );
  updateTicketContent: CollabFeaturePort['updateTicketContent'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.updateTicketContent(...args))
  );
  addTicketComment: CollabFeaturePort['addTicketComment'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.addTicketComment(...args))
  );
  closeTicket: CollabFeaturePort['closeTicket'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.closeTicket(...args))
  );
  reopenTicket: CollabFeaturePort['reopenTicket'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.reopenTicket(...args))
  );
  updateRequestMetadata: CollabFeaturePort['updateRequestMetadata'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.updateRequestMetadata(...args))
  );
  acceptRequest: CollabFeaturePort['acceptRequest'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.acceptRequest(...args))
  );
  removeMember: CollabFeaturePort['removeMember'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.removeMember(...args))
  );
  leaveProject: CollabFeaturePort['leaveProject'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.leaveProject(...args))
  );
  createManagerResponsibilityOffer: CollabFeaturePort[
    'createManagerResponsibilityOffer'
  ] = (...args) => this.project(
    () => args[0].projectId,
    'active',
    () => this.core.createManagerResponsibilityOffer(...args),
  );
  cancelManagerResponsibilityOffer: CollabFeaturePort[
    'cancelManagerResponsibilityOffer'
  ] = (...args) => this.project(
    () => args[0].projectId,
    'active',
    () => this.core.cancelManagerResponsibilityOffer(...args),
  );
  promoteManager: CollabFeaturePort['promoteManager'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.promoteManager(...args))
  );
  demoteManager: CollabFeaturePort['demoteManager'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.demoteManager(...args))
  );
  createHostTransfer: CollabFeaturePort['createHostTransfer'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.createHostTransfer(...args))
  );
  acceptHostTransfer: CollabFeaturePort['acceptHostTransfer'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.acceptHostTransfer(...args))
  );
  declineHostTransfer: CollabFeaturePort['declineHostTransfer'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.declineHostTransfer(...args))
  );
  cancelHostTransfer: CollabFeaturePort['cancelHostTransfer'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.cancelHostTransfer(...args))
  );
  retireProject: CollabFeaturePort['retireProject'] = (...args) => (
    this.project(() => args[0].projectId, 'active', () => this.core.retireProject(...args))
  );
  finalizeRetiredProject: CollabFeaturePort['finalizeRetiredProject'] = (...args) => (
    this.project(
      () => args[0].projectId,
      'retired-local',
      () => this.core.finalizeRetiredProject(...args),
    )
  );
  retryProjectCleanup: CollabFeaturePort['retryProjectCleanup'] = (...args) => (
    this.project(
      () => args[0],
      'retired-local',
      () => this.core.retryProjectCleanup(...args),
    )
  );
  subscribe: CollabFeaturePort['subscribe'] = (...args) => this.core.subscribe(...args);

  getPendingSetupOperationId(projectId: CollabProjectId): Promise<CollabOperationId | null> {
    return this.runGlobal(() => this.core.getPendingSetupOperationId(projectId));
  }

  listPendingSetupOperationIds(): Promise<readonly CollabOperationId[]> {
    return this.runGlobal(() => this.core.listPendingSetupOperationIds());
  }

  restoreHosts(): Promise<void> {
    return this.runGlobal(() => this.core.restoreHosts());
  }

  restoreLifecycle(): Promise<void> {
    // Lifecycle recovery owns its own cancellation and may need to drain the
    // admitted Project operations while replacing an authority binding. Do
    // not register the recovery promise in that same admission set.
    return this.#operationAdmission.runLifecycleRecovery(() => this.core.restoreLifecycle());
  }

  refreshLifecycleProjection(): Promise<void> {
    return this.runGlobal(() => this.core.refreshLifecycleProjection());
  }

  closeProjectAdmission(projectId: CollabProjectId): void {
    this.#operationAdmission.closeProject(projectId);
    this.core.abortProjectBackgroundWork(projectId);
  }

  suspendProjectAdmission(projectId: CollabProjectId): ProjectOperationSuspension {
    const suspension = this.#operationAdmission.suspendProject(projectId);
    this.core.abortProjectBackgroundWork(projectId);
    return suspension;
  }

  resumeProjectAdmission(
    suspension: ProjectOperationSuspension,
  ): boolean {
    return this.#operationAdmission.resumeProject(suspension);
  }

  drainAdmittedOperations(): Promise<void> {
    return this.#operationAdmission.drain();
  }

  recoverPendingCloudBootstraps(): Promise<void> {
    return this.cloudBootstrap.recoverPending();
  }

  prepareCloudBootstrapLocalRecovery(): Promise<void> {
    return this.cloudBootstrap.prepareLocalRecovery();
  }

  startCloudBootstrapFormerHost(
    input: StartCloudBootstrapServiceInput,
  ): Promise<CloudBootstrapTransitionRecord> {
    return this.cloudBootstrap.startFormerHost(input);
  }

  submitCloudBootstrapParticipant(
    input: SubmitCloudBootstrapServiceParticipantInput,
  ): Promise<CloudBootstrapTransitionRecord> {
    return this.cloudBootstrap.submitParticipant(input);
  }

  cancelCloudBootstrap(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord> {
    return this.cloudBootstrap.cancel(projectId);
  }

  close(): Promise<void> {
    return this.core.close();
  }

  private runGlobal<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operationAdmission.runGlobal(operation);
  }

  private project<T>(
    resolveProjectId: () => CollabProjectId,
    policy: ProjectOperationPolicy,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#operationAdmission.runProject(resolveProjectId, policy, operation);
  }
}
