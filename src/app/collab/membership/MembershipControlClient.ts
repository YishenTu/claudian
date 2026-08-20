import {
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian/collab-protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabHttpOperationOptions,
  CollabJsonRequest,
} from '@/app/collab/lan/CollabHttpClient';
import type { LanCollabInvitation } from '@/app/collab/lan/InvitationCodec';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type {
  AcknowledgeManagerResponsibilityRequest,
  CancelManagerResponsibilityOfferRequest,
  ConfirmEndpointResponse,
  CreateManagerResponsibilityOfferRequest,
  DemoteManagerResponse,
  MembershipTerminationResponse,
  PromoteManagerResponse,
  RefreshEndpointResponse,
} from '@/app/collab/lan/LanCollabControlOperations';
import type {
  LanCollabControlOperationMap,
  LanCollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabManagerResponsibilityOfferSummary } from '@/core/collab';
import { type CollabInvitationView } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface MembershipControlTransport {
  requestWithMember<T>(
    request: CollabJsonRequest<T>,
    memberCredential: string,
    options?: CollabHttpOperationOptions,
  ): Promise<T>;
}

interface MembershipMutationInput {
  readonly idempotencyKey: string;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export interface PromoteManagerInput extends MembershipMutationInput {
  readonly managerResponsibilityOfferId: string;
  readonly targetMemberId: string;
}

export interface DemoteManagerInput extends MembershipMutationInput {
  readonly targetMemberId: string;
}

export interface RemoveMemberInput extends MembershipMutationInput {
  readonly memberId: string;
}

export interface LeaveProjectInput extends MembershipMutationInput {
  readonly expectedHostMemberId: string;
  readonly expectedMemberId: string;
  readonly idempotencyManagerMemberId: string | null;
  readonly managerResponsibilityOfferId?: string;
}

export interface CreateManagerResponsibilityOfferInput extends MembershipMutationInput {
  readonly purpose: CreateManagerResponsibilityOfferRequest['purpose'];
  readonly targetMemberId: string;
}

export interface ManagerResponsibilityOfferInput extends MembershipMutationInput {
  readonly expectedTargetMemberId: string;
  readonly offerId: string;
}

export interface CancelManagerResponsibilityOfferInput extends MembershipMutationInput {
  readonly offerId: string;
}

export interface GetManagerResponsibilityOfferInput {
  readonly memberCredential: string;
  readonly offerId: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export type CreateInvitationInput = MembershipMutationInput;

export interface RevokeInvitationInput extends MembershipMutationInput {
  readonly memberId: string;
}

interface ManagerRoleResponseContext {
  readonly projectId: string;
  readonly targetMemberId: string;
}

interface TerminationResponseContext {
  readonly expectedMemberId: string;
  readonly expectedStatus: MembershipTerminationResponse['status'];
  readonly projectId: string;
}

interface InvitationResponseContext {
  readonly projectId: string;
}

interface InvitationRevocationContext extends InvitationResponseContext {
  readonly memberId: string;
}

interface RefreshEndpointResponseContext {
  readonly caFingerprint: string;
  readonly endpoint: string;
}

export interface RefreshEndpointInput {
  readonly invitation: LanCollabInvitation;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export interface ConfirmEndpointInput {
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly memberCredential: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function decodeError(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { field },
  });
}

function semanticId(
  value: unknown,
  field: string,
  predicate: (candidate: unknown) => candidate is string,
): string {
  if (!predicate(value)) {
    throw decodeError(field);
  }
  return value;
}

const memberId = (value: unknown, field: string): string => (
  semanticId(value, field, isCollabMemberId)
);
const opaqueId = (value: unknown, field: string): string => (
  semanticId(value, field, isCollabOpaqueId)
);
const projectId = (value: unknown, field: string): string => (
  semanticId(value, field, isCollabProjectId)
);

export function decodePromoteManagerResponse(
  value: unknown,
  context: ManagerRoleResponseContext,
): PromoteManagerResponse {
  const response = lifecycleResponse('promoteManager', value);
  if (
    response.projectId !== context.projectId
    || response.promotedMemberId !== context.targetMemberId
  ) {
    throw decodeError('promoteManagerResponse');
  }
  return response;
}

export function decodeDemoteManagerResponse(
  value: unknown,
  context: ManagerRoleResponseContext,
): DemoteManagerResponse {
  const response = lifecycleResponse('demoteManager', value);
  if (
    response.projectId !== context.projectId
    || response.demotedMemberId !== context.targetMemberId
  ) {
    throw decodeError('demoteManagerResponse');
  }
  return response;
}

type LifecycleResponse<Operation extends LanCollabLifecycleControlOperation> =
  LanCollabControlOperationMap[Operation]['response'];

function lifecycleResponse<Operation extends LanCollabLifecycleControlOperation>(
  operation: Operation,
  value: unknown,
): LifecycleResponse<Operation> {
  return lanCollabControlOperationCodec(operation).decodeResponse(value);
}

function assertOfferContext(
  offer: CollabManagerResponsibilityOfferSummary,
  context: {
    readonly offerId?: string;
    readonly projectId: string;
    readonly sourceManagerMemberId?: string;
    readonly targetMemberId?: string;
  },
): CollabManagerResponsibilityOfferSummary {
  if (
    (context.offerId !== undefined && offer.offerId !== context.offerId)
    || (context.sourceManagerMemberId !== undefined
      && offer.sourceManagerMemberId !== context.sourceManagerMemberId)
    || (context.targetMemberId !== undefined && offer.targetMemberId !== context.targetMemberId)
  ) throw decodeError('managerResponsibilityOffer');
  return offer;
}

export function decodeMembershipTerminationResponse(
  value: unknown,
  context: TerminationResponseContext,
): MembershipTerminationResponse {
  const response = lanCollabControlOperationCodec('removeMember').decodeResponse(value);
  if (
    response.projectId !== context.projectId
    || response.memberId !== context.expectedMemberId
    || response.status !== context.expectedStatus
  ) {
    throw decodeError('membershipTerminationResponse');
  }
  return response;
}

export function decodeCreateInvitationResponse(
  value: unknown,
  context: InvitationResponseContext,
): CollabInvitationView {
  const response = lanCollabControlOperationCodec('createInvitation').decodeResponse(value);
  if (response.invitation.projectId !== context.projectId) {
    throw decodeError('invitationResponse');
  }
  return {
    encodedInvitation: response.encodedInvitation,
    expiresAt: response.invitation.expiresAt,
  };
}

export function decodeRefreshEndpointResponse(
  value: unknown,
  context: RefreshEndpointResponseContext,
): RefreshEndpointResponse {
  const { caFingerprint, endpoint } = lanCollabControlOperationCodec(
    'refreshEndpoint',
  ).decodeResponse(value);
  if (
    typeof caFingerprint !== 'string'
    || typeof endpoint !== 'string'
    || caFingerprint !== context.caFingerprint
    || endpoint !== context.endpoint
  ) {
    throw decodeError('refreshEndpointResponse');
  }
  return { caFingerprint, endpoint };
}

function decodeInvitationRevocationResponse(
  value: unknown,
  context: InvitationRevocationContext,
): void {
  const response = lanCollabControlOperationCodec('revokeInvitation').decodeResponse(value);
  if (
    response.project.id !== context.projectId
    || response.currentMember.id !== context.memberId
  ) {
    throw decodeError('invitationRevocationResponse');
  }
}

export class MembershipControlClient {
  constructor(private readonly transport: MembershipControlTransport) {}

  confirmEndpoint(input: ConfirmEndpointInput): Promise<ConfirmEndpointResponse> {
    projectId(input.projectId, 'projectId');
    return this.transport.requestWithMember({
      decode: value => decodeRefreshEndpointResponse(value, {
        caFingerprint: input.caFingerprint,
        endpoint: input.endpoint,
      }),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.confirmEndpoint.method,
      path: collabControlOperationPath('confirmEndpoint', input.projectId),
    }, input.memberCredential, {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }

  createInvitation(input: CreateInvitationInput): Promise<CollabInvitationView> {
    projectId(input.projectId, 'projectId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
      },
      decode: value => decodeCreateInvitationResponse(value, {
        projectId: input.projectId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createInvitation.method,
      path: collabControlOperationPath('createInvitation', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  refreshEndpoint(input: RefreshEndpointInput): Promise<RefreshEndpointResponse> {
    projectId(input.projectId, 'projectId');
    if (input.invitation.projectId !== input.projectId) {
      throw decodeError('invitation.projectId');
    }
    return this.transport.requestWithMember({
      body: {
        invitation: input.invitation,
        projectId: input.projectId,
      },
      decode: value => decodeRefreshEndpointResponse(value, {
        caFingerprint: input.invitation.caFingerprint,
        endpoint: input.invitation.endpoint,
      }),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.refreshEndpoint.method,
      path: collabControlOperationPath('refreshEndpoint', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  revokeInvitation(input: RevokeInvitationInput): Promise<void> {
    projectId(input.projectId, 'projectId');
    memberId(input.memberId, 'memberId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
      },
      decode: value => decodeInvitationRevocationResponse(value, {
        memberId: input.memberId,
        projectId: input.projectId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.revokeInvitation.method,
      path: collabControlOperationPath('revokeInvitation', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  promoteManager(input: PromoteManagerInput): Promise<PromoteManagerResponse> {
    projectId(input.projectId, 'projectId');
    opaqueId(input.managerResponsibilityOfferId, 'managerResponsibilityOfferId');
    memberId(input.targetMemberId, 'targetMemberId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        managerResponsibilityOfferId: input.managerResponsibilityOfferId,
        projectId: input.projectId,
        targetMemberId: input.targetMemberId,
      },
      decode: value => decodePromoteManagerResponse(value, {
        projectId: input.projectId,
        targetMemberId: input.targetMemberId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.promoteManager.method,
      path: collabControlOperationPath('promoteManager', input.projectId, {
        memberId: input.targetMemberId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  demoteManager(input: DemoteManagerInput): Promise<DemoteManagerResponse> {
    projectId(input.projectId, 'projectId');
    memberId(input.targetMemberId, 'targetMemberId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        targetMemberId: input.targetMemberId,
      },
      decode: value => decodeDemoteManagerResponse(value, {
        projectId: input.projectId,
        targetMemberId: input.targetMemberId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.demoteManager.method,
      path: collabControlOperationPath('demoteManager', input.projectId, {
        memberId: input.targetMemberId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  removeMember(input: RemoveMemberInput): Promise<MembershipTerminationResponse> {
    projectId(input.projectId, 'projectId');
    memberId(input.memberId, 'memberId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        memberId: input.memberId,
        projectId: input.projectId,
      },
      decode: value => decodeMembershipTerminationResponse(value, {
        expectedMemberId: input.memberId,
        expectedStatus: 'revoked',
        projectId: input.projectId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.removeMember.method,
      path: collabControlOperationPath('removeMember', input.projectId, {
        memberId: input.memberId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  leaveProject(input: LeaveProjectInput): Promise<MembershipTerminationResponse> {
    projectId(input.projectId, 'projectId');
    memberId(input.expectedMemberId, 'expectedMemberId');
    memberId(input.expectedHostMemberId, 'expectedHostMemberId');
    if (input.idempotencyManagerMemberId !== null) {
      memberId(input.idempotencyManagerMemberId, 'idempotencyManagerMemberId');
    }
    if (input.managerResponsibilityOfferId !== undefined) {
      opaqueId(input.managerResponsibilityOfferId, 'managerResponsibilityOfferId');
    }
    return this.transport.requestWithMember({
      body: {
        expectedHostMemberId: input.expectedHostMemberId,
        expectedMemberId: input.expectedMemberId,
        idempotencyManagerMemberId: input.idempotencyManagerMemberId,
        idempotencyKey: input.idempotencyKey,
        ...(input.managerResponsibilityOfferId === undefined ? {} : {
          managerResponsibilityOfferId: input.managerResponsibilityOfferId,
        }),
        projectId: input.projectId,
      },
      decode: value => {
        const response = lifecycleResponse('leaveProject', value);
        if (
          response.memberId !== input.expectedMemberId
          || response.projectId !== input.projectId
          || response.status !== 'left'
        ) throw decodeError('membershipTerminationResponse');
        return response;
      },
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.leaveProject.method,
      path: collabControlOperationPath('leaveProject', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  createManagerResponsibilityOffer(
    input: CreateManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    projectId(input.projectId, 'projectId');
    memberId(input.targetMemberId, 'targetMemberId');
    return this.transport.requestWithMember({
      body: {
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        purpose: input.purpose,
        targetMemberId: input.targetMemberId,
      },
      decode: value => assertOfferContext(
        lifecycleResponse('createManagerResponsibilityOffer', value),
        {
          projectId: input.projectId,
          targetMemberId: input.targetMemberId,
        },
      ),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createManagerResponsibilityOffer.method,
      path: collabControlOperationPath('createManagerResponsibilityOffer', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  getCurrentManagerResponsibilityOffer(
    input: Omit<GetManagerResponsibilityOfferInput, 'offerId'>,
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    projectId(input.projectId, 'projectId');
    return this.transport.requestWithMember({
      decode: value => lifecycleResponse('getCurrentManagerResponsibilityOffer', value),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getCurrentManagerResponsibilityOffer.method,
      path: collabControlOperationPath('getCurrentManagerResponsibilityOffer', input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  getManagerResponsibilityOffer(
    input: GetManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    projectId(input.projectId, 'projectId');
    opaqueId(input.offerId, 'offerId');
    return this.transport.requestWithMember({
      decode: value => assertOfferContext(
        lifecycleResponse('getManagerResponsibilityOffer', value),
        { offerId: input.offerId, projectId: input.projectId },
      ),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getManagerResponsibilityOffer.method,
      path: collabControlOperationPath('getManagerResponsibilityOffer', input.projectId, {
        offerId: input.offerId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  acknowledgeManagerResponsibility(
    input: ManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    return this.transitionManagerResponsibility('acknowledge', input);
  }

  declineManagerResponsibility(
    input: ManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    return this.transitionManagerResponsibility('decline', input);
  }

  cancelManagerResponsibilityOffer(
    input: CancelManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    projectId(input.projectId, 'projectId');
    opaqueId(input.offerId, 'offerId');
    const body: CancelManagerResponsibilityOfferRequest = {
      idempotencyKey: input.idempotencyKey,
      offerId: input.offerId,
      projectId: input.projectId,
    };
    return this.transport.requestWithMember({
      body,
      decode: value => assertOfferContext(
        lifecycleResponse('cancelManagerResponsibilityOffer', value),
        { offerId: input.offerId, projectId: input.projectId },
      ),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.cancelManagerResponsibilityOffer.method,
      path: collabControlOperationPath('cancelManagerResponsibilityOffer', input.projectId, {
        offerId: input.offerId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  private transitionManagerResponsibility(
    action: 'acknowledge' | 'decline',
    input: ManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    projectId(input.projectId, 'projectId');
    opaqueId(input.offerId, 'offerId');
    memberId(input.expectedTargetMemberId, 'expectedTargetMemberId');
    const body: AcknowledgeManagerResponsibilityRequest = {
      expectedTargetMemberId: input.expectedTargetMemberId,
      idempotencyKey: input.idempotencyKey,
      offerId: input.offerId,
      projectId: input.projectId,
    };
    const operation = action === 'acknowledge'
      ? 'acknowledgeManagerResponsibility'
      : 'declineManagerResponsibility';
    return this.transport.requestWithMember({
      body,
      decode: value => assertOfferContext(lifecycleResponse(operation, value), {
        offerId: input.offerId,
        projectId: input.projectId,
        targetMemberId: input.expectedTargetMemberId,
      }),
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
      path: collabControlOperationPath(operation, input.projectId, {
        offerId: input.offerId,
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }
}
