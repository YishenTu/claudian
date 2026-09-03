import { randomUUID } from 'node:crypto';

import { type CollabManagerResponsibilityOffer, type CollabMemberId, type CollabProjectId, type CollabProjectMembershipOperationMap } from '@claudian-collab/protocol';

import { type CollabLocalProjectRepository, isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import type {
  CollabProjectLifecycleAdmission,
  CollabProjectLifecycleAuthorityAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import { type CloudManagementIntent, type CloudManagementMutation, decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import type {
  CollabMembershipManagerReceiptPort,
  CollabMembershipPendingLeavePort,
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { encodeCloudMembershipClaimInvitation, encodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import type {
  CloudMembershipBinding,
  CollabAuthorityMembershipRouterPort,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type {
  CollabCompleteManagementOperationRequest,
  CollabImportedMemberClaimRequest,
  CollabInvitationSummaryView,
  CollabManagementOperationView,
  CollabManagerResponsibilityOfferSummary,
  CollabMemberSummaryView,
  CollabProjectSnapshot,
  CollabResult,
  CollabRevokeInvitationRequest,
} from '@/core/collab';
import { type CollabCancelManagerResponsibilityOfferRequest, type CollabCoordinationSnapshot, type CollabCreateManagerResponsibilityOfferRequest, type CollabDemoteManagerRequest, type CollabInvitationView, type CollabOperationOptions, type CollabPromoteManagerRequest, type CollabRemoveMemberRequest, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Carries only the owning operation's safe recovery identity across the feature seam. */
export class CollabMembershipOutcomeError extends Error {
  constructor(readonly result: Extract<CollabResult<never>, { status: 'recovery-required' | 'stale' }>) {
    super('Cloud management did not complete');
  }
}

export interface CollabMembershipSnapshotPort {
  readAuthoritySnapshot(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabCoordinationSnapshot>;
  readCoordinationSnapshot(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabCoordinationSnapshot>;
}

export interface CollabMembershipServiceOptions {
  readonly createIdempotencyKey?: (kind: string) => string;
}

export interface CollabMembershipSafetyContext {
  readonly cloudManagementAdmission: CollabProjectLifecycleAuthorityAdmission;
  readonly managerLeaveCloudManagementAdmission: CollabProjectLifecycleAuthorityAdmission;
  readonly projects: CollabLocalProjectRepository;
  readonly managerResponsibilityAdmission: CollabProjectLifecycleAdmission;
  readonly managerResponsibilityOperations: ManagerResponsibilityOperationCoordinator;
  readonly managerReceipts: CollabMembershipManagerReceiptPort;
  readonly pendingLeaves: CollabMembershipPendingLeavePort;
}

export class CollabMembershipService {
  private readonly lanManagementIntents = new Map<CollabProjectId, {
    readonly identity: string;
    readonly key: string;
  }>();
  private readonly managementQueues = new Map<CollabProjectId, SerialTaskQueue>();
  private readonly createIdempotencyKey: NonNullable<
    CollabMembershipServiceOptions['createIdempotencyKey']
  >;
  constructor(
    private readonly control: CollabAuthorityMembershipRouterPort,
    private readonly snapshots: CollabMembershipSnapshotPort,
    options: CollabMembershipServiceOptions = {},
    private readonly safety: CollabMembershipSafetyContext,
  ) {
    this.createIdempotencyKey = options.createIdempotencyKey ?? (kind => (
      `${kind}-${randomUUID().replaceAll('-', '')}`
    ));
  }

  async createInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabInvitationView> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.runCloudManagementMutation(
        projectId,
        options,
        () => this.createCloudInvitation(projectId, options),
      );
    }
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    return this.control.membership('createInvitation', {
      idempotencyKey: this.createIdempotencyKey('create-invitation'),
      projectId,
    }, options);
  }

  private async createCloudInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<CollabInvitationView> {
    let intent = await this.loadCloudIntent(projectId);
    if (intent && intent.operation !== 'createProjectInvitation') throw managementPending();
    if (!intent) {
      const { binding, members } = await this.readCloudManagerMembers(projectId, options);
      intent = await this.prepareCloudIntent(binding, 'createProjectInvitation', {
        expectedManagerSetGeneration: members.managerSetGeneration,
        idempotencyKey: this.createIdempotencyKey('create-invitation'), projectId,
      });
    }
    await this.executeCloudIntent(intent, options);
    intent = await this.loadCloudIntent(projectId);
    if (
      intent?.operation !== 'createProjectInvitation'
      || !intent.response
      || retainedSecretExpired(intent.response)
    ) throw new CollabError({ code: 'invitation-expired' });
    return { encodedInvitation: encodeCloudProjectInvitation({ invitation: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
  }

  private async executeCloudIntent(intent: CloudManagementIntent, options: CollabOperationOptions): Promise<void> {
    if (intent.phase !== 'result-retained') {
      intent = { ...intent, phase: 'submitted', updatedAt: new Date().toISOString() };
      await this.saveCloudIntent(intent);
      let response;
      try {
        response = await this.control.cloudMembership(intent.operation, intent.request, intent, options);
      } catch (error) {
        if (error instanceof CloudAuthorityRejection) {
          // A completed rejection cannot prove whether the exact idempotent
          // mutation committed. Keep the frozen request until replay recovers
          // its result. These authenticated reads classify a synchronized
          // stale outcome but are not operation-specific negative proof.
          await this.readCloudBinding(intent.projectId, options);
          const members = await this.control.cloudMembership('listProjectMembers', { projectId: intent.projectId }, intent, options);
          if (members.projectId !== intent.projectId || !members.members.some(member => member.memberId === intent.memberId)) {
            throw new CollabError({ code: 'authority-integrity-error' });
          }
          if (error.code === 'authority-not-synchronized') {
            throw new CollabMembershipOutcomeError({
              status: 'stale',
              staleKind: 'authority-sync',
              error,
            });
          }
        }
        throw error;
      }
      intent = decodeCloudManagementIntent({ ...intent, phase: 'result-retained', response, updatedAt: new Date().toISOString() });
      await this.saveCloudIntent(intent);
    }
  }

  reissueMemberClaim(request: CollabImportedMemberClaimRequest, options: CollabOperationOptions = {}): Promise<CollabInvitationView> {
    return this.runCloudManagementMutation(request.projectId, options, async () => {
      let intent = await this.loadCloudIntent(request.projectId);
      if (intent && (intent.operation !== 'reissueTransferredMembershipClaim' || intent.request.memberId !== request.memberId)) throw managementPending();
      if (!intent) {
        intent = await this.prepareCloudMemberClaim('reissueTransferredMembershipClaim', request, options);
      }
      await this.executeCloudIntent(intent, options);
      intent = await this.loadCloudIntent(request.projectId);
      if (
        intent?.operation !== 'reissueTransferredMembershipClaim'
        || !intent.response
        || retainedSecretExpired(intent.response)
      ) throw new CollabError({ code: 'invitation-expired' });
      return { encodedInvitation: encodeCloudMembershipClaimInvitation({ claim: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
    });
  }

  revokeMemberClaim(request: CollabImportedMemberClaimRequest, options: CollabOperationOptions = {}): Promise<void> {
    return this.runCloudManagementMutation(request.projectId, options, async () => {
      let intent = await this.loadCloudIntent(request.projectId);
      if (intent && (intent.operation !== 'revokeTransferredMembershipClaim' || intent.request.memberId !== request.memberId)) throw managementPending();
      if (!intent) intent = await this.prepareCloudMemberClaim('revokeTransferredMembershipClaim', request, options);
      await this.executeCloudIntent(intent, options);
      await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
    });
  }

  private async prepareCloudMemberClaim(operation: 'reissueTransferredMembershipClaim' | 'revokeTransferredMembershipClaim', request: CollabImportedMemberClaimRequest, options: CollabOperationOptions): Promise<CloudManagementIntent> {
    const { binding, members } = await this.readCloudManagerMembers(request.projectId, options);
    const target = members.members.find(member => member.memberId === request.memberId);
    if (!target || target.bindingState !== 'unbound' || target.importedClaimGeneration === null) {
      throw new CollabError({ code: 'authorization-denied' });
    }
    return this.prepareCloudIntent(binding, operation, {
      expectedManagerSetGeneration: members.managerSetGeneration, expectedMembershipRevision: target.membershipRevision,
      expectedClaimGeneration: target.importedClaimGeneration, idempotencyKey: this.createIdempotencyKey(operation),
      memberId: request.memberId, projectId: request.projectId,
    });
  }

  private async readCloudBinding(projectId: CollabProjectId, options: CollabOperationOptions) {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalCloudMembership(membership)) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'cloud-membership-required' } });
    }
    const binding = {
      authorityGeneration: membership.authority.authorityGeneration,
      memberId: membership.member.id, projectId, serverUrl: membership.authority.serverUrl,
    };
    const projection = await this.snapshots.readAuthoritySnapshot(projectId, options);
    const snapshot = projection.snapshot;
    if (projection.source !== 'online' || projection.stale || snapshot.project.authorityKind !== 'cloud'
      || snapshot.project.authorityGeneration !== binding.authorityGeneration || snapshot.currentMember.id !== binding.memberId) {
      throw new CollabError({ code: 'authority-integrity-error', safeContext: { reason: 'cloud-membership-read-mismatch' } });
    }
    return { binding, snapshot };
  }

  async listInvitations(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabInvitationSummaryView[]> {
    const { binding } = await this.readCloudBinding(projectId, options);
    const response = await this.control.cloudMembership('listProjectInvitations', { projectId }, binding, options);
    if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
    return response.invitations.map(({ createdAt, expiresAt, invitationId, state }) => ({ createdAt, expiresAt, invitationId, state }));
  }

  async listMembers(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabMemberSummaryView[]> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      const { binding } = await this.readCloudBinding(projectId, options);
      const response = await this.control.cloudMembership('listProjectMembers', { projectId }, binding, options);
      if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
      return response.members.map(member => ({
        memberId: member.memberId, displayName: member.displayName, role: member.role,
        importedClaim: member.importedClaimState === 'not-applicable' ? null : { state: member.importedClaimState, bindingState: member.bindingState },
      }));
    }
    const projection = await this.snapshots.readCoordinationSnapshot(projectId, options);
    if (projection.source !== 'online' || projection.stale) throw new CollabError({ code: 'offline' });
    return projection.snapshot.members.map(member => ({ memberId: member.id, displayName: member.displayName, role: member.role, importedClaim: null }));
  }

  async listManagerResponsibilityOffers(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabManagerResponsibilityOfferSummary[]> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      const { binding } = await this.readCloudBinding(projectId, options);
      const response = await this.control.cloudMembership('listCurrentManagerResponsibilityOffers', { projectId }, binding, options);
      if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
      return response.offers.map(cloudManagerOfferSummary);
    }
    const projection = await this.snapshots.readCoordinationSnapshot(projectId, options);
    if (projection.source !== 'online' || projection.stale) throw new CollabError({ code: 'offline' });
    const offer = isCollabLanProjectSnapshot(projection.snapshot) ? projection.snapshot.managerResponsibilityOffer : null;
    return offer ? [offer] : [];
  }

  private saveCloudIntent(intent: CloudManagementIntent): Promise<void> {
    return this.safety.projects.saveProjectDocument(intent.projectId, 'cloud-management-intent', decodeCloudManagementIntent(intent));
  }

  private async prepareCloudIntent<Operation extends CloudManagementMutation>(
    binding: CloudMembershipBinding,
    operation: Operation,
    request: CollabProjectMembershipOperationMap[Operation]['request'],
  ): Promise<CloudManagementIntent> {
    const now = new Date().toISOString();
    const intent = decodeCloudManagementIntent({
      ...binding, completionId: randomUUID(), createdAt: now, updatedAt: now, kind: 'cloud-management-intent', operation,
      phase: 'prepared', request, response: null, schemaVersion: 1,
    });
    await this.saveCloudIntent(intent);
    return intent;
  }

  private async readCloudManagerMembers(projectId: CollabProjectId, options: CollabOperationOptions) {
    const { binding, snapshot } = await this.readCloudBinding(projectId, options);
    if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
    const members = await this.control.cloudMembership('listProjectMembers', { projectId }, binding, options);
    if (members.projectId !== projectId || !members.members.some(member => member.memberId === binding.memberId && member.role === 'manager')) {
      throw new CollabError({ code: 'authorization-denied' });
    }
    return { binding, members };
  }

  private async loadCloudIntent(projectId: CollabProjectId): Promise<CloudManagementIntent | null> {
    const intent = await this.safety.projects.loadProjectDocument(projectId, 'cloud-management-intent', decodeCloudManagementIntent);
    if (!intent) return null;
    const membership = await this.safety.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalCloudMembership(membership)
      || intent.serverUrl !== membership.authority.serverUrl || intent.memberId !== membership.member.id
      || intent.authorityGeneration !== membership.authority.authorityGeneration) {
      throw new CollabError({ code: 'authority-integrity-error', safeContext: { reason: 'cloud-management-binding-mismatch' } });
    }
    return intent;
  }

  readManagementOperation(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<CollabManagementOperationView | null> {
    return this.runManagement(projectId, async () => {
      const intent = await this.loadCloudIntent(projectId);
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      if (!intent) return null;
      return managementOperationView(intent);
    });
  }

  async resumeManagementOperation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagementOperationView> {
    const selectedIntent = await this.loadCloudIntent(projectId);
    if (!selectedIntent) throw new CollabError({ code: 'project-not-found' });
    const admission = this.cloudManagementAdmissionFor(selectedIntent);
    return admission(projectId, () => this.runSelectedCloudMutation(
      projectId,
      options,
      selectedIntent,
      async selected => {
        let intent: CloudManagementIntent | null = selected;
        await this.executeCloudIntent(intent, options);
        intent = await this.loadCloudIntent(projectId);
        if (!intent || intent.phase !== 'result-retained') {
          throw new CollabError({
            code: 'durable-progress-recovery-required',
            recoveryActions: ['retry'],
            safeContext: { reason: 'cloud-management-result-not-retained' },
          });
        }
        return managementOperationView(intent);
      },
    ));
  }

  async completeManagementOperation(request: CollabCompleteManagementOperationRequest, options: CollabOperationOptions = {}): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (!membership || !isCollabLocalCloudMembership(membership)) {
      return this.runManagement(request.projectId, async () => {
        this.lanManagementIntents.delete(request.projectId);
      });
    }
    const selectedIntent = await this.loadCloudIntent(request.projectId);
    if (!selectedIntent) return;
    const admission = this.cloudManagementAdmissionFor(selectedIntent);
    return admission(
      request.projectId,
      () => this.runManagement(request.projectId, async () => {
        const intent = await this.loadCloudIntent(request.projectId);
        if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
        this.assertSelectedCloudIntent(selectedIntent, intent);
        if (request.completionId !== intent.completionId) {
          throw new CollabError({
            code: 'operation-failed',
            safeContext: { reason: 'cloud-management-completion-mismatch' },
          });
        }
        if (intent.phase !== 'result-retained') {
          throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'cloud-management-result-not-settled' } });
        }
        await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
      }),
    );
  }

  private runManagement<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    let queue = this.managementQueues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.managementQueues.set(projectId, queue);
    }
    const result = queue.run(operation);
    const drained = queue.drain();
    void drained.then(() => {
      if (queue.drain() === drained) this.managementQueues.delete(projectId);
    });
    return result;
  }

  private runCloudMutation<T>(projectId: CollabProjectId, options: CollabOperationOptions, operation: () => Promise<T>): Promise<T> {
    return this.runManagement(projectId, async () => {
      try {
        if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
        return await operation();
      }
      catch (error) {
        // A failed atomic write may already have renamed the private record. Read the
        // owning document before classifying cancellation or a disconnected reply.
        const intent = await this.loadCloudIntent(projectId);
        if (!intent) throw error;
        throw new CollabMembershipOutcomeError({
          status: 'recovery-required', durableProgress: true, durablePhase: 'committed', operationId: projectId,
          error: error instanceof CollabError ? error : new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['retry'] }),
        });
      }
    });
  }

  private runSelectedCloudMutation<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    selectedIntent: CloudManagementIntent,
    operation: (intent: CloudManagementIntent) => Promise<T>,
  ): Promise<T> {
    return this.runManagement(projectId, async () => {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const intent = await this.loadCloudIntent(projectId);
      this.assertSelectedCloudIntent(selectedIntent, intent);
      try {
        return await operation(intent);
      } catch (error) {
        const retainedIntent = await this.loadCloudIntent(projectId);
        if (!retainedIntent) throw error;
        throw new CollabMembershipOutcomeError({
          status: 'recovery-required', durableProgress: true, durablePhase: 'committed', operationId: projectId,
          error: error instanceof CollabError ? error : new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['retry'] }),
        });
      }
    });
  }

  private cloudManagementAdmissionFor(
    intent: CloudManagementIntent,
  ): CollabProjectLifecycleAuthorityAdmission {
    return isManagerLeaveCloudManagementIntent(intent)
      ? this.safety.managerLeaveCloudManagementAdmission
      : this.safety.cloudManagementAdmission;
  }

  private assertSelectedCloudIntent(
    selectedIntent: CloudManagementIntent,
    currentIntent: CloudManagementIntent | null,
  ): asserts currentIntent is CloudManagementIntent {
    if (
      !currentIntent
      || currentIntent.completionId !== selectedIntent.completionId
      || isManagerLeaveCloudManagementIntent(currentIntent)
        !== isManagerLeaveCloudManagementIntent(selectedIntent)
    ) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry'],
        safeContext: { reason: 'cloud-management-intent-changed' },
      });
    }
  }

  private runCloudManagementMutation<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.safety.cloudManagementAdmission(
      projectId,
      () => this.runCloudMutation(projectId, options, operation),
    );
  }

  private runLanManagement<T>(
    projectId: CollabProjectId,
    identity: string,
    kind: string,
    options: CollabOperationOptions,
    operation: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    return this.runManagement(projectId, async () => {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      let intent = this.lanManagementIntents.get(projectId);
      if (intent && intent.identity !== identity) throw managementPending('lan-management-operation-pending');
      if (!intent) {
        intent = { identity, key: this.createIdempotencyKey(kind) };
        this.lanManagementIntents.set(projectId, intent);
      }
      const result = await operation(intent.key);
      if (this.lanManagementIntents.get(projectId) === intent) {
        this.lanManagementIntents.delete(projectId);
      }
      return result;
    });
  }

  async revokeInvitation(
    request: CollabRevokeInvitationRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const projectId = typeof request === 'string' ? request : request.projectId;
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      if (typeof request === 'string') throw new CollabError({ code: 'invitation-invalid' });
      return this.runCloudManagementMutation(projectId, options, async () => {
        let intent = await this.loadCloudIntent(projectId);
        if (intent && (intent.operation !== 'revokeProjectInvitation' || intent.request.invitationId !== request.invitationId)) throw managementPending();
        if (!intent) {
          const { binding, snapshot } = await this.readCloudBinding(projectId, options);
          if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
          const invitations = await this.control.cloudMembership('listProjectInvitations', { projectId }, binding, options);
          if (invitations.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
          const invitation = invitations.invitations.find(candidate => candidate.invitationId === request.invitationId);
          if (!invitation) throw new CollabError({ code: 'invitation-invalid' });
          intent = await this.prepareCloudIntent(binding, 'revokeProjectInvitation', {
            expectedInvitationRevision: invitation.revision, expectedManagerSetGeneration: invitations.managerSetGeneration,
            idempotencyKey: this.createIdempotencyKey('revoke-invitation'), invitationId: request.invitationId, projectId,
          });
        }
        await this.executeCloudIntent(intent, options);
        await this.safety.projects.removeProjectDocument(projectId, 'cloud-management-intent');
      });
    }
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    if (typeof request !== 'string') throw new CollabError({ code: 'invitation-invalid' });
    await this.control.membership('revokeInvitation', {
      idempotencyKey: this.createIdempotencyKey('revoke-invitation'),
      projectId,
    }, options);
  }

  async promoteManager(
    request: CollabPromoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    await this.safety.managerResponsibilityAdmission(request.projectId, async () => {
      const membership = await this.safety.projects.loadMembership(request.projectId);
      if (membership && isCollabLocalCloudMembership(membership)) {
        return this.runCloudMutation(request.projectId, options, async () => {
          let intent = await this.loadCloudIntent(request.projectId);
          if (intent && (intent.operation !== 'promoteManager' || intent.request.targetMemberId !== request.targetMemberId
            || intent.request.managerResponsibilityOfferId !== request.managerResponsibilityOfferId)) throw managementPending();
          if (!intent) {
            const { binding, members } = await this.readCloudManagerMembers(request.projectId, options);
            const target = members.members.find(member => member.memberId === request.targetMemberId);
            const { offer } = await this.control.cloudMembership('getManagerResponsibilityOffer', { projectId: request.projectId, offerId: request.managerResponsibilityOfferId }, binding, options);
            if (!target || target.role !== 'member' || offer.offerId !== request.managerResponsibilityOfferId
              || offer.targetMemberId !== request.targetMemberId || offer.sourceManagerMemberId !== binding.memberId
              || offer.purpose !== 'manager-promotion' || offer.state !== 'acknowledged') {
              throw new CollabError({ code: 'authority-not-synchronized' });
            }
            intent = await this.prepareCloudIntent(binding, 'promoteManager', {
              expectedManagerSetGeneration: members.managerSetGeneration, expectedTargetMembershipRevision: target.membershipRevision,
              expectedOfferRevision: offer.revision, managerResponsibilityOfferId: offer.offerId,
              idempotencyKey: this.createIdempotencyKey('promote-manager'), targetMemberId: request.targetMemberId, projectId: request.projectId,
            });
          }
          await this.executeCloudIntent(intent, options);
          await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
        });
      }
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      await this.runLanManagement(
        request.projectId,
        `promote:${request.targetMemberId}:${request.managerResponsibilityOfferId}`,
        'promote-manager',
        options,
        idempotencyKey => this.control.membership('promoteManager', {
          idempotencyKey,
          managerResponsibilityOfferId: request.managerResponsibilityOfferId,
          projectId: request.projectId,
          targetMemberId: request.targetMemberId,
        }, options),
      );
    });
    await this.refreshProjection(request.projectId, options);
  }

  async demoteManager(
    request: CollabDemoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.changeCloudMember('demoteManager', request.projectId, request.targetMemberId, options);
    }
    await this.runLanManagement(
      request.projectId,
      `demote:${request.targetMemberId}`,
      'demote-manager',
      options,
      idempotencyKey => this.control.membership('demoteManager', {
        idempotencyKey,
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      }, options),
    );
    await this.refreshProjection(request.projectId, options);
  }

  private async changeCloudMember(operation: 'demoteManager' | 'removeMember', projectId: CollabProjectId, targetMemberId: CollabMemberId, options: CollabOperationOptions): Promise<void> {
      await this.runCloudManagementMutation(projectId, options, async () => {
        let intent = await this.loadCloudIntent(projectId);
        if (intent && (intent.operation !== operation || intent.request.targetMemberId !== targetMemberId)) throw managementPending();
        if (!intent) {
          const { binding, members } = await this.readCloudManagerMembers(projectId, options);
          const target = members.members.find(member => member.memberId === targetMemberId);
          if (!target || (operation === 'demoteManager' && target.role !== 'manager')) throw new CollabError({ code: 'authority-not-synchronized' });
          intent = await this.prepareCloudIntent(binding, operation, {
            expectedManagerSetGeneration: members.managerSetGeneration, expectedTargetMembershipRevision: target.membershipRevision,
            idempotencyKey: this.createIdempotencyKey(operation === 'demoteManager' ? 'demote-manager' : 'remove-member'), targetMemberId, projectId,
          });
        }
        await this.executeCloudIntent(intent, options);
        await this.safety.projects.removeProjectDocument(projectId, 'cloud-management-intent');
      });
      await this.refreshProjection(projectId, options);
  }

  async removeMember(
    request: CollabRemoveMemberRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.changeCloudMember('removeMember', request.projectId, request.memberId, options);
    }
    await this.runLanManagement(
      request.projectId,
      `remove:${request.memberId}`,
      'remove-member',
      options,
      idempotencyKey => this.control.membership('removeMember', {
        idempotencyKey,
        memberId: request.memberId,
        projectId: request.projectId,
      }, options),
    );
    await this.refreshProjection(request.projectId, options);
  }

  async createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.runCloudMutation(request.projectId, options, async () => {
        let intent = await this.loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'createManagerResponsibilityOffer' || intent.request.targetMemberId !== request.targetMemberId || intent.request.purpose !== request.purpose)) throw managementPending();
        if (!intent) {
          const { binding, members } = await this.readCloudManagerMembers(request.projectId, options);
          const target = members.members.find(member => member.memberId === request.targetMemberId);
          if (!target || target.role !== 'member') throw new CollabError({ code: 'authority-not-synchronized' });
          intent = await this.prepareCloudIntent(binding, 'createManagerResponsibilityOffer', {
            expectedManagerSetGeneration: members.managerSetGeneration, expectedTargetMembershipRevision: target.membershipRevision,
            idempotencyKey: this.createIdempotencyKey('manager-offer'), projectId: request.projectId, purpose: request.purpose, targetMemberId: request.targetMemberId,
          });
        }
        await this.executeCloudIntent(intent, options);
        intent = await this.loadCloudIntent(request.projectId);
        if (intent?.operation !== 'createManagerResponsibilityOffer' || !intent.response) throw new CollabError({ code: 'authority-integrity-error' });
        const summary = cloudManagerOfferSummary(intent.response.offer);
        await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
        return summary;
      });
    }
    return this.runLanManagement(
      request.projectId,
      `offer:${request.purpose}:${request.targetMemberId}`,
      'manager-responsibility-offer',
      options,
      idempotencyKey => this.control.membership('createManagerResponsibilityOffer', {
        idempotencyKey,
        projectId: request.projectId,
        purpose: request.purpose,
        targetMemberId: request.targetMemberId,
      }, options),
    );
  }

  reconcileManagerResponsibilitySnapshot(
    snapshot: CollabProjectSnapshot,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    return this.safety.managerResponsibilityOperations.reconcileSnapshot(snapshot, {
      projects: this.safety.projects,
      control: this.control,
      managerReceipts: this.safety.managerReceipts,
      pendingLeaves: this.safety.pendingLeaves,
    }, options);
  }

  async cancelManagerResponsibilityOffer(
    request: CollabCancelManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.runCloudMutation(request.projectId, options, async () => {
        let intent = await this.loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'cancelManagerResponsibilityOffer' || intent.request.offerId !== request.offerId)) throw managementPending();
        if (!intent) {
          const { binding, snapshot } = await this.readCloudBinding(request.projectId, options);
          if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
          const { offer } = await this.control.cloudMembership('getManagerResponsibilityOffer', { projectId: request.projectId, offerId: request.offerId }, binding, options);
          if (offer.offerId !== request.offerId || offer.sourceManagerMemberId !== binding.memberId) throw new CollabError({ code: 'authority-integrity-error' });
          intent = await this.prepareCloudIntent(binding, 'cancelManagerResponsibilityOffer', {
            expectedOfferRevision: offer.revision, idempotencyKey: this.createIdempotencyKey('cancel-manager-offer'),
            offerId: request.offerId, projectId: request.projectId,
          });
        }
        await this.executeCloudIntent(intent, options);
        intent = await this.loadCloudIntent(request.projectId);
        if (intent?.operation !== 'cancelManagerResponsibilityOffer' || !intent.response) throw new CollabError({ code: 'authority-integrity-error' });
        const summary = cloudManagerOfferSummary(intent.response.offer);
        await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
        return summary;
      });
    }
    return this.control.membership('cancelManagerResponsibilityOffer', {
      idempotencyKey: `manager-cancel-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
  }

  private async refreshProjection(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.snapshots.readCoordinationSnapshot(projectId, options).catch(() => undefined);
  }

}

function managementPending(reason = 'cloud-management-operation-pending'): CollabError {
  return new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['retry'], safeContext: { reason } });
}

function isManagerLeaveCloudManagementIntent(
  intent: CloudManagementIntent,
): intent is Extract<CloudManagementIntent, { operation: 'createManagerResponsibilityOffer' }> {
  return intent.operation === 'createManagerResponsibilityOffer'
    && intent.request.purpose === 'manager-leave';
}

function cloudManagerOfferSummary(offer: CollabManagerResponsibilityOffer): CollabManagerResponsibilityOfferSummary {
  return {
    offerId: offer.offerId, purpose: offer.purpose, sourceManagerMemberId: offer.sourceManagerMemberId,
    targetMemberId: offer.targetMemberId, status: offer.state, offeredAt: offer.offeredAt, expiresAt: offer.expiresAt,
    ...(offer.acknowledgedAt ? { acknowledgedAt: offer.acknowledgedAt } : {}),
  };
}

function retainedInvitation(intent: CloudManagementIntent): CollabInvitationView | null {
  if (intent.operation === 'createProjectInvitation' && intent.response) {
    if (retainedSecretExpired(intent.response)) return null;
    return { encodedInvitation: encodeCloudProjectInvitation({ invitation: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
  }
  if (intent.operation === 'reissueTransferredMembershipClaim' && intent.response) {
    if (retainedSecretExpired(intent.response)) return null;
    return { encodedInvitation: encodeCloudMembershipClaimInvitation({ claim: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
  }
  return null;
}

function retainedSecretExpired(response: {
  readonly expiresAt: string;
  readonly secretReplayExpiresAt: string;
}): boolean {
  return Date.now() >= Date.parse(retainedSecretAvailableUntil(response));
}

function retainedSecretAvailableUntil(response: {
  readonly expiresAt: string;
  readonly secretReplayExpiresAt: string;
}): string {
  return Date.parse(response.expiresAt) <= Date.parse(response.secretReplayExpiresAt)
    ? response.expiresAt
    : response.secretReplayExpiresAt;
}

function managementSecretAvailableUntil(
  intent: CloudManagementIntent,
): string | null {
  if (
    (intent.operation === 'createProjectInvitation'
      || intent.operation === 'reissueTransferredMembershipClaim')
    && intent.response
  ) return retainedSecretAvailableUntil(intent.response);
  return null;
}

function managementOperationView(
  intent: CloudManagementIntent,
): CollabManagementOperationView {
  return {
    action: ({
      createProjectInvitation: 'create-invitation',
      revokeProjectInvitation: 'revoke-invitation',
      demoteManager: 'demote-manager',
      removeMember: 'remove-member',
      createManagerResponsibilityOffer: 'create-manager-offer',
      cancelManagerResponsibilityOffer: 'cancel-manager-offer',
      promoteManager: 'promote-manager',
      reissueTransferredMembershipClaim: 'reissue-member-claim',
      revokeTransferredMembershipClaim: 'revoke-member-claim',
    } as const)[intent.operation],
    completionId: intent.completionId,
    invitation: retainedInvitation(intent),
    secretAvailableUntil: managementSecretAvailableUntil(intent),
    status: intent.phase === 'result-retained' ? 'result-retained' : 'pending',
  };
}
