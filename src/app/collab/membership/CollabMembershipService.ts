import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { type CollabManagerResponsibilityOffer, type CollabMemberId, type CollabProjectId, type CollabProjectMembershipOperationMap } from '@claudian-collab/protocol';

import { type CollabLocalLANMembershipRecord,type CollabLocalProjectRepository, isCollabLocalCloudMembership, isCollabLocalLANMembership } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabProjectLifecycleRecoveryLinkAdmission } from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import type {
  CollabImportedClaimManagementIdentity,
  CollabProjectLifecycleAdmission,
  CollabProjectLifecycleAuthorityAdmission,
  CollabProjectLifecycleImportedClaimAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import { type CloudManagementIntent, type CloudManagementMutation, decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import { InvitationOperation } from '@/app/collab/membership/InvitationOperation';
import type {
  CollabMembershipManagerReceiptPort,
  CollabMembershipPendingLeavePort,
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { encodeCloudMembershipClaimInvitation, encodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { encodeLANMembershipClaimInvitation } from '@/app/collab/project/LANMembershipClaimInvitation';
import { encodeProjectRecoveryInvitation } from '@/app/collab/project/ProjectRecoveryInvitation';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import type { CloudMembershipOperationMap } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
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
  CollabOpenInvitationRequest,
  CollabProjectCapabilities,
  CollabProjectSnapshot,
  CollabResult,
  CollabRevokeInvitationRequest,
} from '@/core/collab';
import { type CollabCancelManagerResponsibilityOfferRequest, type CollabCoordinationSnapshot, type CollabCreateManagerResponsibilityOfferRequest, type CollabDemoteManagerRequest, type CollabInvitationView, type CollabOperationOptions, type CollabPromoteManagerRequest, type CollabRemoveMemberRequest, isCollabLANProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Carries only the owning operation's safe recovery identity across the feature seam. */
export class CollabMembershipOutcomeError extends Error {
  constructor(readonly result: Extract<CollabResult<never>, { status: 'recovery-required' | 'stale' }>) {
    super('Cloud management did not complete');
  }
}

export interface CollabMembershipSnapshotPort {
  readProjectCapabilities?(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabProjectCapabilities>;
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
  readonly recoveryLinkCloudManagementAdmission?: CollabProjectLifecycleRecoveryLinkAdmission;
  readonly cloudManagementAdmission: CollabProjectLifecycleAuthorityAdmission;
  readonly importedClaimCloudManagementAdmission: CollabProjectLifecycleImportedClaimAdmission;
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
    claim?: {
      readonly binding: CollabLocalLANMembershipRecord;
      readonly request: CollabProjectMembershipOperationMap['reissueTransferredMembershipClaim']['request'];
      readonly completionId: string;
      result: CollabProjectMembershipOperationMap['reissueTransferredMembershipClaim']['response'] | null;
    };
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

  openInvitation(request: CollabOpenInvitationRequest): InvitationOperation {
    const { projectId, intent } = request;
    let lanKey: string | undefined;
    return new InvitationOperation({
      readBinding: async () => {
        const membership = await this.safety.projects.loadMembership(projectId);
        if (!membership) throw new CollabError({ code: 'project-not-found' });
        return {
          kind: membership.authority.kind,
          identity: JSON.stringify([
            membership.member.id, membership.authority.kind, membership.authority.authorityGeneration,
            isCollabLocalCloudMembership(membership)
              ? membership.authority.serverUrl : membership.authority.hostCaFingerprint,
          ]),
        };
      },
      createLan: async options => {
        if (request.purpose !== 'recovery') return this.control.membership('createInvitation', {
          projectId, idempotencyKey: lanKey ??= this.createIdempotencyKey('create-invitation'),
        }, options);
        const membership = await this.safety.projects.loadMembership(projectId);
        if (!membership || !isCollabLocalLANMembership(membership)) throw new CollabError({ code: 'project-not-found' });
        const { endpoint, hostCaCertificatePem, hostCaFingerprint, authorityGeneration } = membership.authority;
        if (!endpoint || !hostCaCertificatePem || !hostCaFingerprint) throw new CollabError({ code: 'authority-integrity-error' });
        const link = await this.control.membership('createProjectRecoveryLink', {
          projectId, expectedAuthorityGeneration: authorityGeneration,
          idempotencyKey: lanKey ??= this.createIdempotencyKey('create-recovery-link'),
        }, options);
        return { encodedInvitation: encodeProjectRecoveryInvitation({ link, target: { kind: 'lan', endpoint,
          caCertificatePem: hostCaCertificatePem, caFingerprint: hostCaFingerprint } }), expiresAt: link.expiresAt };
      },
      createCloud: select => request.purpose === 'recovery'
        ? this.#runCloudRecoveryLinkMutation(projectId, () => this.#createCloudRecoveryLink(projectId, select))
        : this.#runCloudManagementMutation(projectId, {}, () => this.#createCloudInvitation(projectId, {}, select)),
      readManagement: options => this.readManagementOperation(projectId, options),
      resumeManagement: completionId => this.#resumeManagementOperation(projectId, {}, completionId),
      completeManagement: completionId => this.completeManagementOperation({ projectId, completionId }),
    }, intent, request.purpose === 'recovery' ? 'create-recovery-link' : 'create-invitation');
  }

  async #runCloudRecoveryLinkMutation<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    const binding = await this.#loadCloudMembershipBinding(projectId);
    return this.#recoveryLinkAdmission(binding)(projectId, () => this.#runCloudMutation(projectId, {}, operation));
  }

  #recoveryLinkAdmission(binding: Pick<CloudMembershipBinding, 'authorityGeneration' | 'memberId'>): CollabProjectLifecycleAuthorityAdmission {
    const admission = this.safety.recoveryLinkCloudManagementAdmission;
    return admission ? (projectId, operation) => admission(projectId,
      { actorMemberId: binding.memberId, authorityGeneration: binding.authorityGeneration }, operation) : this.safety.cloudManagementAdmission;
  }

  async #createCloudRecoveryLink(projectId: CollabProjectId, select: (completionId: string) => void): Promise<CollabInvitationView> {
    let intent = await this.#loadCloudIntent(projectId);
    if (intent && intent.operation !== 'createProjectRecoveryLink') throw managementPending();
    if (!intent) {
      const { binding } = await this.#readCloudManagerMembers(projectId, {});
      intent = await this.#prepareCloudIntent(binding, 'createProjectRecoveryLink', {
        projectId, expectedAuthorityGeneration: binding.authorityGeneration,
        idempotencyKey: this.createIdempotencyKey('create-recovery-link'),
      }, select);
    } else select(intent.completionId);
    await this.#executeCloudIntent(intent, {});
    intent = await this.#loadCloudIntent(projectId);
    if (!intent || intent.operation !== 'createProjectRecoveryLink') throw managementPending();
    const invitation = retainedInvitation(intent);
    if (!invitation) throw new CollabError({ code: 'invitation-expired' });
    return invitation;
  }

  async createInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabInvitationView> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.#runCloudManagementMutation(
        projectId,
        options,
        () => this.#createCloudInvitation(projectId, options),
      );
    }
    if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    return this.control.membership('createInvitation', {
      idempotencyKey: this.createIdempotencyKey('create-invitation'),
      projectId,
    }, options);
  }

  async #createCloudInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    select?: (completionId: string) => void,
  ): Promise<CollabInvitationView> {
    let intent = await this.#loadCloudIntent(projectId);
    if (intent && intent.operation !== 'createProjectInvitation') throw managementPending();
    if (!intent) {
      const { binding, members } = await this.#readCloudManagerMembers(projectId, options);
      intent = await this.#prepareCloudIntent(binding, 'createProjectInvitation', {
        expectedManagerSetGeneration: members.managerSetGeneration,
        idempotencyKey: this.createIdempotencyKey('create-invitation'), projectId,
      }, select);
    } else {
      select?.(intent.completionId);
    }
    await this.#executeCloudIntent(intent, options);
    intent = await this.#loadCloudIntent(projectId);
    if (
      intent?.operation !== 'createProjectInvitation'
      || !intent.response
      || retainedSecretExpired(intent.response)
    ) throw new CollabError({ code: 'invitation-expired' });
    return { encodedInvitation: encodeCloudProjectInvitation({ invitation: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
  }

  async #executeCloudIntent(intent: CloudManagementIntent, options: CollabOperationOptions): Promise<void> {
    if (intent.phase !== 'result-retained') {
      intent = { ...intent, phase: 'submitted', updatedAt: new Date().toISOString() };
      await this.#saveCloudIntent(intent);
      let response;
      try {
        response = await this.control.cloudMembership(intent.operation, intent.request, intent, options);
      } catch (error) {
        if (error instanceof CloudAuthorityRejection && error.mutationOutcome === 'rejected') {
          if (!isDeepStrictEqual(await this.#loadCloudIntent(intent.projectId), intent)) {
            throw managementPending('cloud-management-intent-changed');
          }
          await this.safety.projects.removeProjectDocument(intent.projectId, 'cloud-management-intent');
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
      await this.#saveCloudIntent(intent);
    }
  }

  async reissueMemberClaim(request: CollabImportedMemberClaimRequest, options: CollabOperationOptions = {}): Promise<CollabInvitationView> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalLANMembership(membership)) {
      return this.#runManagement(request.projectId, async () => {
        await this.#reissueLanMemberClaim(request, options);
        const invitation = this.#lanClaimView(request.projectId)?.invitation;
        if (!invitation) throw new CollabError({ code: 'invitation-expired' });
        return invitation;
      });
    }
    return this.#runCloudImportedClaimManagementMutation(
      request.projectId,
      request.memberId,
      options,
      async identity => {
        let intent = await this.#loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'reissueTransferredMembershipClaim' || intent.request.memberId !== request.memberId)) throw managementPending();
        if (!intent) {
          intent = await this.#prepareCloudMemberClaim(
            'reissueTransferredMembershipClaim',
            request,
            identity,
            options,
          );
        }
        this.#assertImportedClaimManagementIdentity(intent, identity);
        await this.#executeCloudIntent(intent, options);
        intent = await this.#loadCloudIntent(request.projectId);
        if (
          intent?.operation !== 'reissueTransferredMembershipClaim'
          || !intent.response
          || retainedSecretExpired(intent.response)
        ) throw new CollabError({ code: 'invitation-expired' });
        return { encodedInvitation: encodeCloudMembershipClaimInvitation({ claim: intent.response, serverUrl: intent.serverUrl }), expiresAt: intent.response.expiresAt };
      },
    );
  }

  async #reissueLanMemberClaim(request: CollabImportedMemberClaimRequest, options: CollabOperationOptions): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (!membership || !isCollabLocalLANMembership(membership) || membership.authority.authorityGeneration < 2) throw new CollabError({ code: 'authorization-denied' });
    const identity = `reissue-member-claim:${request.memberId}`;
    let intent = this.lanManagementIntents.get(request.projectId);
    if (intent && intent.identity !== identity) throw managementPending('lan-management-operation-pending');
    if (!intent) {
      const members = await this.control.membership('listProjectMembers', { projectId: request.projectId }, options);
      const member = members.members.find(member => member.memberId === request.memberId);
      if (!member || member.bindingState !== 'unbound' || member.importedClaimGeneration === null) throw new CollabError({ code: 'authorization-denied' });
      const key = this.createIdempotencyKey('reissue-member-claim');
      intent = { identity, key, claim: { binding: membership, completionId: randomUUID(), result: null,
        request: { projectId: request.projectId, memberId: request.memberId, idempotencyKey: key,
          expectedClaimGeneration: member.importedClaimGeneration, expectedManagerSetGeneration: members.managerSetGeneration,
          expectedMembershipRevision: member.membershipRevision } } };
      this.lanManagementIntents.set(request.projectId, intent);
    }
    const claim = intent.claim;
    if (!claim || !isDeepStrictEqual(claim.binding.authority, membership.authority) || claim.binding.member.id !== membership.member.id) throw managementPending('lan-management-binding-changed');
    if (!claim.result) {
      const result = await this.control.membership('reissueTransferredMembershipClaim', claim.request, options);
      if (result.targetAuthorityGeneration !== membership.authority.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
      claim.result = result;
    }
  }

  #lanClaimView(projectId: CollabProjectId): CollabManagementOperationView | null {
    const claim = this.lanManagementIntents.get(projectId)?.claim;
    if (!claim) return null;
    const result = claim.result;
    const authority = claim.binding.authority;
    const available = result && !retainedSecretExpired(result);
    return {
      action: 'reissue-member-claim', completionId: claim.completionId,
      status: result ? 'result-retained' : 'pending', secretAvailableUntil: result?.secretReplayExpiresAt ?? null,
      invitation: available && authority.hostCaCertificatePem && authority.hostCaFingerprint && authority.endpoint
        ? { encodedInvitation: encodeLANMembershipClaimInvitation({ claim: result, targetHost: {
          caCertificatePem: authority.hostCaCertificatePem, caFingerprint: authority.hostCaFingerprint, endpoint: authority.endpoint,
        } }), expiresAt: result.expiresAt } : null,
    };
  }

  revokeMemberClaim(request: CollabImportedMemberClaimRequest, options: CollabOperationOptions = {}): Promise<void> {
    return this.#runCloudImportedClaimManagementMutation(
      request.projectId,
      request.memberId,
      options,
      async identity => {
        let intent = await this.#loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'revokeTransferredMembershipClaim' || intent.request.memberId !== request.memberId)) throw managementPending();
        if (!intent) {
          intent = await this.#prepareCloudMemberClaim(
            'revokeTransferredMembershipClaim',
            request,
            identity,
            options,
          );
        }
        this.#assertImportedClaimManagementIdentity(intent, identity);
        await this.#executeCloudIntent(intent, options);
        await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
      },
    );
  }

  async #prepareCloudMemberClaim(
    operation: 'reissueTransferredMembershipClaim' | 'revokeTransferredMembershipClaim',
    request: CollabImportedMemberClaimRequest,
    identity: CollabImportedClaimManagementIdentity,
    options: CollabOperationOptions,
  ): Promise<CloudManagementIntent> {
    const { binding, members } = await this.#readCloudManagerMembers(request.projectId, options);
    this.#assertImportedClaimManagementIdentity(binding, identity, request.memberId);
    const target = members.members.find(member => member.memberId === request.memberId);
    if (!target || target.bindingState !== 'unbound' || target.importedClaimGeneration === null) {
      throw new CollabError({ code: 'authorization-denied' });
    }
    return this.#prepareCloudIntent(binding, operation, {
      expectedManagerSetGeneration: members.managerSetGeneration, expectedMembershipRevision: target.membershipRevision,
      expectedClaimGeneration: target.importedClaimGeneration, idempotencyKey: this.createIdempotencyKey(operation),
      memberId: request.memberId, projectId: request.projectId,
    });
  }

  async #readCloudBinding(projectId: CollabProjectId, options: CollabOperationOptions) {
    const binding = await this.#loadCloudMembershipBinding(projectId);
    const projection = await this.snapshots.readAuthoritySnapshot(projectId, options);
    const snapshot = projection.snapshot;
    if (projection.source !== 'online' || projection.stale || snapshot.project.authorityKind !== 'cloud'
      || snapshot.project.authorityGeneration !== binding.authorityGeneration || snapshot.currentMember.id !== binding.memberId) {
      throw new CollabError({ code: 'authority-integrity-error', safeContext: { reason: 'cloud-membership-read-mismatch' } });
    }
    return { binding, snapshot };
  }

  async #loadCloudMembershipBinding(
    projectId: CollabProjectId,
  ): Promise<CloudMembershipBinding> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalCloudMembership(membership)) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'cloud-membership-required' } });
    }
    return {
      authorityGeneration: membership.authority.authorityGeneration,
      memberId: membership.member.id,
      projectId,
      serverUrl: membership.authority.serverUrl,
    };
  }

  async listInvitations(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabInvitationSummaryView[]> {
    const { binding } = await this.#readCloudBinding(projectId, options);
    const response = await this.control.cloudMembership('listProjectInvitations', { projectId }, binding, options);
    if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
    return response.invitations.map(({ createdAt, expiresAt, invitationId, state }) => ({ createdAt, expiresAt, invitationId, state }));
  }

  async listMembers(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabMemberSummaryView[]> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      const { binding } = await this.#readCloudBinding(projectId, options);
      const response = await this.control.cloudMembership('listProjectMembers', { projectId }, binding, options);
      if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
      return response.members.map(member => ({
        memberId: member.memberId, displayName: member.displayName, role: member.role,
        importedClaim: member.importedClaimState === 'not-applicable' ? null : { state: member.importedClaimState, bindingState: member.bindingState },
      }));
    }
    const projection = await this.snapshots.readCoordinationSnapshot(projectId, options);
    if (projection.source !== 'online' || projection.stale) throw new CollabError({ code: 'offline' });
    if (membership && isCollabLocalLANMembership(membership) && membership.authority.authorityGeneration > 1
      && (await this.snapshots.readProjectCapabilities?.(projectId, options))?.importedMemberClaims) {
      const response = await this.control.membership('listProjectMembers', { projectId }, options);
      return response.members.map(member => ({ memberId: member.memberId, displayName: member.displayName, role: member.role,
        importedClaim: member.importedClaimState === 'not-applicable' ? null : { state: member.importedClaimState, bindingState: member.bindingState } }));
    }
    return projection.snapshot.members.map(member => ({ memberId: member.id, displayName: member.displayName, role: member.role, importedClaim: null }));
  }

  async listManagerResponsibilityOffers(projectId: CollabProjectId, options: CollabOperationOptions = {}): Promise<readonly CollabManagerResponsibilityOfferSummary[]> {
    const membership = await this.safety.projects.loadMembership(projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      const { binding } = await this.#readCloudBinding(projectId, options);
      const response = await this.control.cloudMembership('listCurrentManagerResponsibilityOffers', { projectId }, binding, options);
      if (response.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
      return response.offers.map(cloudManagerOfferSummary);
    }
    const projection = await this.snapshots.readCoordinationSnapshot(projectId, options);
    if (projection.source !== 'online' || projection.stale) throw new CollabError({ code: 'offline' });
    const offer = isCollabLANProjectSnapshot(projection.snapshot) ? projection.snapshot.managerResponsibilityOffer : null;
    return offer ? [offer] : [];
  }

  #saveCloudIntent(intent: CloudManagementIntent): Promise<void> {
    return this.safety.projects.saveProjectDocument(intent.projectId, 'cloud-management-intent', decodeCloudManagementIntent(intent));
  }

  async #prepareCloudIntent<Operation extends CloudManagementMutation>(
    binding: CloudMembershipBinding,
    operation: Operation,
    request: CloudMembershipOperationMap[Operation]['request'],
    select?: (completionId: string) => void,
  ): Promise<CloudManagementIntent> {
    const now = new Date().toISOString();
    const intent = decodeCloudManagementIntent({
      ...binding, completionId: randomUUID(), createdAt: now, updatedAt: now, kind: 'cloud-management-intent', operation,
      phase: 'prepared', request, response: null, schemaVersion: 1,
    });
    // Capture identity before a durable write whose acknowledgement can be lost.
    select?.(intent.completionId);
    await this.#saveCloudIntent(intent);
    return intent;
  }

  async #readCloudManagerMembers(projectId: CollabProjectId, options: CollabOperationOptions) {
    const { binding, snapshot } = await this.#readCloudBinding(projectId, options);
    if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
    const members = await this.control.cloudMembership('listProjectMembers', { projectId }, binding, options);
    if (members.projectId !== projectId || !members.members.some(member => member.memberId === binding.memberId && member.role === 'manager')) {
      throw new CollabError({ code: 'authorization-denied' });
    }
    return { binding, members };
  }

  async #loadCloudIntent(projectId: CollabProjectId): Promise<CloudManagementIntent | null> {
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
    return this.#runManagement(projectId, async () => {
      const lanClaim = this.#lanClaimView(projectId);
      if (lanClaim) return lanClaim;
      const intent = await this.#loadCloudIntent(projectId);
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      if (!intent) return null;
      return managementOperationView(intent);
    });
  }

  resumeManagementOperation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagementOperationView> {
    if (this.lanManagementIntents.get(projectId)?.claim) {
      return this.#runManagement(projectId, async () => {
        const claim = this.lanManagementIntents.get(projectId)!.claim!;
        await this.#reissueLanMemberClaim({ projectId, memberId: claim.request.memberId }, options);
        return this.#lanClaimView(projectId)!;
      });
    }
    return this.#resumeManagementOperation(projectId, options);
  }

  async #resumeManagementOperation(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    completionId?: string,
  ): Promise<CollabManagementOperationView> {
    const selectedIntent = await this.#loadCloudIntent(projectId);
    if (!selectedIntent) throw new CollabError({ code: 'project-not-found' });
    if (completionId !== undefined && selectedIntent.completionId !== completionId) {
      throw managementPending('cloud-management-intent-changed');
    }
    const admission = this.#cloudManagementAdmissionFor(selectedIntent);
    return admission(projectId, () => this.#runSelectedCloudMutation(
      projectId,
      options,
      selectedIntent,
      async selected => {
        let intent: CloudManagementIntent | null = selected;
        await this.#executeCloudIntent(intent, options);
        intent = await this.#loadCloudIntent(projectId);
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
      return this.#runManagement(request.projectId, async () => {
        this.lanManagementIntents.delete(request.projectId);
      });
    }
    const selectedIntent = await this.#loadCloudIntent(request.projectId);
    if (!selectedIntent) return;
    const admission = this.#cloudManagementAdmissionFor(selectedIntent);
    return admission(
      request.projectId,
      () => this.#runManagement(request.projectId, async () => {
        const intent = await this.#loadCloudIntent(request.projectId);
        if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
        this.#assertSelectedCloudIntent(selectedIntent, intent);
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

  #runManagement<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
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

  #runCloudMutation<T>(projectId: CollabProjectId, options: CollabOperationOptions, operation: () => Promise<T>): Promise<T> {
    return this.#runManagement(projectId, async () => {
      try {
        if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
        return await operation();
      }
      catch (error) {
        // A failed atomic write may already have renamed the private record. Read the
        // owning document before classifying cancellation or a disconnected reply.
        const intent = await this.#loadCloudIntent(projectId);
        if (!intent) throw error;
        throw new CollabMembershipOutcomeError({
          status: 'recovery-required', durableProgress: true, durablePhase: 'committed', operationId: projectId,
          error: error instanceof CollabError ? error : new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['retry'] }),
        });
      }
    });
  }

  #runSelectedCloudMutation<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    selectedIntent: CloudManagementIntent,
    operation: (intent: CloudManagementIntent) => Promise<T>,
  ): Promise<T> {
    return this.#runManagement(projectId, async () => {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const intent = await this.#loadCloudIntent(projectId);
      this.#assertSelectedCloudIntent(selectedIntent, intent);
      try {
        return await operation(intent);
      } catch (error) {
        const retainedIntent = await this.#loadCloudIntent(projectId);
        if (!retainedIntent) throw error;
        throw new CollabMembershipOutcomeError({
          status: 'recovery-required', durableProgress: true, durablePhase: 'committed', operationId: projectId,
          error: error instanceof CollabError ? error : new CollabError({ code: 'durable-progress-recovery-required', recoveryActions: ['retry'] }),
        });
      }
    });
  }

  #cloudManagementAdmissionFor(
    intent: CloudManagementIntent,
  ): CollabProjectLifecycleAuthorityAdmission {
    if (intent.operation === 'createProjectRecoveryLink') return this.#recoveryLinkAdmission(intent);
    if (isManagerLeaveCloudManagementIntent(intent)) {
      return this.safety.managerLeaveCloudManagementAdmission;
    }
    if (isImportedClaimCloudManagementIntent(intent)) {
      return (projectId, operation) => this.safety.importedClaimCloudManagementAdmission(
        projectId,
        importedClaimManagementIdentity(intent, intent.request.memberId),
        operation,
      );
    }
    return this.safety.cloudManagementAdmission;
  }

  #assertSelectedCloudIntent(
    selectedIntent: CloudManagementIntent,
    currentIntent: CloudManagementIntent | null,
  ): asserts currentIntent is CloudManagementIntent {
    if (
      !currentIntent
      || currentIntent.completionId !== selectedIntent.completionId
      || currentIntent.operation !== selectedIntent.operation
      || currentIntent.authorityGeneration !== selectedIntent.authorityGeneration
      || currentIntent.memberId !== selectedIntent.memberId
      || currentIntent.serverUrl !== selectedIntent.serverUrl
      || isManagerLeaveCloudManagementIntent(currentIntent)
        !== isManagerLeaveCloudManagementIntent(selectedIntent)
      || (
        isImportedClaimCloudManagementIntent(currentIntent)
        && isImportedClaimCloudManagementIntent(selectedIntent)
        && currentIntent.request.memberId !== selectedIntent.request.memberId
      )
    ) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry'],
        safeContext: { reason: 'cloud-management-intent-changed' },
      });
    }
  }

  #runCloudManagementMutation<T>(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.safety.cloudManagementAdmission(
      projectId,
      () => this.#runCloudMutation(projectId, options, operation),
    );
  }

  async #runCloudImportedClaimManagementMutation<T>(
    projectId: CollabProjectId,
    memberId: CollabMemberId,
    options: CollabOperationOptions,
    operation: (identity: CollabImportedClaimManagementIdentity) => Promise<T>,
  ): Promise<T> {
    const binding = await this.#loadCloudMembershipBinding(projectId);
    const identity = importedClaimManagementIdentity(binding, memberId);
    return this.safety.importedClaimCloudManagementAdmission(
      projectId,
      identity,
      () => this.#runCloudMutation(projectId, options, () => operation(identity)),
    );
  }

  #assertImportedClaimManagementIdentity(
    binding: Pick<CloudMembershipBinding, 'authorityGeneration' | 'memberId'>,
    identity: CollabImportedClaimManagementIdentity,
    importedMemberId = identity.importedMemberId,
  ): void {
    if (
      binding.authorityGeneration !== identity.authorityGeneration
      || binding.memberId !== identity.actorMemberId
      || importedMemberId !== identity.importedMemberId
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-imported-claim-binding-changed' },
      });
    }
  }

  #runLanManagement<T>(
    projectId: CollabProjectId,
    identity: string,
    kind: string,
    options: CollabOperationOptions,
    operation: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    return this.#runManagement(projectId, async () => {
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
      return this.#runCloudManagementMutation(projectId, options, async () => {
        let intent = await this.#loadCloudIntent(projectId);
        if (intent && (intent.operation !== 'revokeProjectInvitation' || intent.request.invitationId !== request.invitationId)) throw managementPending();
        if (!intent) {
          const { binding, snapshot } = await this.#readCloudBinding(projectId, options);
          if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
          const invitations = await this.control.cloudMembership('listProjectInvitations', { projectId }, binding, options);
          if (invitations.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
          const invitation = invitations.invitations.find(candidate => candidate.invitationId === request.invitationId);
          if (!invitation) throw new CollabError({ code: 'invitation-invalid' });
          intent = await this.#prepareCloudIntent(binding, 'revokeProjectInvitation', {
            expectedInvitationRevision: invitation.revision, expectedManagerSetGeneration: invitations.managerSetGeneration,
            idempotencyKey: this.createIdempotencyKey('revoke-invitation'), invitationId: request.invitationId, projectId,
          });
        }
        await this.#executeCloudIntent(intent, options);
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
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.#changeCloudMember('promoteManager', request.projectId, request.targetMemberId, options);
    }
    await this.safety.managerResponsibilityAdmission(request.projectId, async () => {
      await this.#runLanManagement(
        request.projectId,
        `promote:${request.targetMemberId}:${request.managerResponsibilityOfferId ?? 'direct'}`,
        'promote-manager',
        options,
        idempotencyKey => this.control.membership('promoteManager', {
          idempotencyKey,
          ...(request.managerResponsibilityOfferId ? { managerResponsibilityOfferId: request.managerResponsibilityOfferId } : {}),
          projectId: request.projectId,
          targetMemberId: request.targetMemberId,
        }, options),
      );
    });
    await this.#refreshProjection(request.projectId, options);
  }

  async demoteManager(
    request: CollabDemoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.#changeCloudMember('demoteManager', request.projectId, request.targetMemberId, options);
    }
    await this.#runLanManagement(
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
    await this.#refreshProjection(request.projectId, options);
  }

  async #changeCloudMember(operation: 'promoteManager' | 'demoteManager' | 'removeMember', projectId: CollabProjectId, targetMemberId: CollabMemberId, options: CollabOperationOptions): Promise<void> {
      await this.#runCloudManagementMutation(projectId, options, async () => {
        let intent = await this.#loadCloudIntent(projectId);
        if (intent && (intent.operation !== operation || intent.request.targetMemberId !== targetMemberId)) throw managementPending();
        if (!intent) {
          const { binding, members } = await this.#readCloudManagerMembers(projectId, options);
          const target = members.members.find(member => member.memberId === targetMemberId);
          if (!target || (operation === 'demoteManager' && target.role !== 'manager')
            || (operation === 'promoteManager' && target.role !== 'member')) throw new CollabError({ code: 'authority-not-synchronized' });
          intent = await this.#prepareCloudIntent(binding, operation, {
            expectedManagerSetGeneration: members.managerSetGeneration, expectedTargetMembershipRevision: target.membershipRevision,
            idempotencyKey: this.createIdempotencyKey(operation === 'promoteManager' ? 'promote-manager' : operation === 'demoteManager' ? 'demote-manager' : 'remove-member'), targetMemberId, projectId,
          });
        }
        await this.#executeCloudIntent(intent, options);
        await this.safety.projects.removeProjectDocument(projectId, 'cloud-management-intent');
      });
      await this.#refreshProjection(projectId, options);
  }

  async removeMember(
    request: CollabRemoveMemberRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.#changeCloudMember('removeMember', request.projectId, request.memberId, options);
    }
    await this.#runLanManagement(
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
    await this.#refreshProjection(request.projectId, options);
  }

  async createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const membership = await this.safety.projects.loadMembership(request.projectId);
    if (membership && isCollabLocalCloudMembership(membership)) {
      return this.#runCloudMutation(request.projectId, options, async () => {
        let intent = await this.#loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'createManagerResponsibilityOffer' || intent.request.targetMemberId !== request.targetMemberId || intent.request.purpose !== request.purpose)) throw managementPending();
        if (!intent) {
          const { binding, members } = await this.#readCloudManagerMembers(request.projectId, options);
          const target = members.members.find(member => member.memberId === request.targetMemberId);
          if (!target || target.role !== 'member') throw new CollabError({ code: 'authority-not-synchronized' });
          intent = await this.#prepareCloudIntent(binding, 'createManagerResponsibilityOffer', {
            expectedManagerSetGeneration: members.managerSetGeneration, expectedTargetMembershipRevision: target.membershipRevision,
            idempotencyKey: this.createIdempotencyKey('manager-offer'), projectId: request.projectId, purpose: request.purpose, targetMemberId: request.targetMemberId,
          });
        }
        await this.#executeCloudIntent(intent, options);
        intent = await this.#loadCloudIntent(request.projectId);
        if (intent?.operation !== 'createManagerResponsibilityOffer' || !intent.response) throw new CollabError({ code: 'authority-integrity-error' });
        const summary = cloudManagerOfferSummary(intent.response.offer);
        await this.safety.projects.removeProjectDocument(request.projectId, 'cloud-management-intent');
        return summary;
      });
    }
    return this.#runLanManagement(
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
      return this.#runCloudMutation(request.projectId, options, async () => {
        let intent = await this.#loadCloudIntent(request.projectId);
        if (intent && (intent.operation !== 'cancelManagerResponsibilityOffer' || intent.request.offerId !== request.offerId)) throw managementPending();
        if (!intent) {
          const { binding, snapshot } = await this.#readCloudBinding(request.projectId, options);
          if (snapshot.currentMember.role !== 'manager') throw new CollabError({ code: 'authorization-denied' });
          const { offer } = await this.control.cloudMembership('getManagerResponsibilityOffer', { projectId: request.projectId, offerId: request.offerId }, binding, options);
          if (offer.offerId !== request.offerId || offer.sourceManagerMemberId !== binding.memberId) throw new CollabError({ code: 'authority-integrity-error' });
          intent = await this.#prepareCloudIntent(binding, 'cancelManagerResponsibilityOffer', {
            expectedOfferRevision: offer.revision, idempotencyKey: this.createIdempotencyKey('cancel-manager-offer'),
            offerId: request.offerId, projectId: request.projectId,
          });
        }
        await this.#executeCloudIntent(intent, options);
        intent = await this.#loadCloudIntent(request.projectId);
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

  async #refreshProjection(
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

function isImportedClaimCloudManagementIntent(
  intent: CloudManagementIntent,
): intent is Extract<CloudManagementIntent, {
  operation: 'reissueTransferredMembershipClaim' | 'revokeTransferredMembershipClaim';
}> {
  return intent.operation === 'reissueTransferredMembershipClaim'
    || intent.operation === 'revokeTransferredMembershipClaim';
}

function importedClaimManagementIdentity(
  binding: Pick<CloudMembershipBinding, 'authorityGeneration' | 'memberId'>,
  importedMemberId: CollabMemberId,
): CollabImportedClaimManagementIdentity {
  return {
    actorMemberId: binding.memberId,
    authorityGeneration: binding.authorityGeneration,
    importedMemberId,
  };
}

function cloudManagerOfferSummary(offer: CollabManagerResponsibilityOffer): CollabManagerResponsibilityOfferSummary {
  return {
    offerId: offer.offerId, purpose: offer.purpose, sourceManagerMemberId: offer.sourceManagerMemberId,
    targetMemberId: offer.targetMemberId, status: offer.state, offeredAt: offer.offeredAt, expiresAt: offer.expiresAt,
    ...(offer.acknowledgedAt ? { acknowledgedAt: offer.acknowledgedAt } : {}),
  };
}

function retainedInvitation(intent: CloudManagementIntent): CollabInvitationView | null {
  if (intent.operation === 'createProjectRecoveryLink' && intent.response) {
    if (retainedSecretExpired(intent.response)) return null;
    return { encodedInvitation: encodeProjectRecoveryInvitation({ link: intent.response, target: { kind: 'cloud', serverUrl: intent.serverUrl } }), expiresAt: intent.response.expiresAt };
  }
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
    (intent.operation === 'createProjectInvitation' || intent.operation === 'createProjectRecoveryLink'
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
      createProjectRecoveryLink: 'create-recovery-link',
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
