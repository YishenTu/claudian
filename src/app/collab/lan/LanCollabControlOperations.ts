import type {
  CollabControlOperationDefinition,
  CollabControlOperationMap,
  CollabIsoTimestamp,
  CollabMember,
  CollabMemberId,
  CollabMutationContext,
  CollabOperationId,
  CollabProjectId,
  CollabRequestId,
} from '@claudian/collab-protocol';

import type { LanCollabInvitation } from '@/app/collab/lan/InvitationCodec';
import type {
  CollabHostTransferSummary,
  CollabHostTrustTransitionProof,
  CollabLanProjectSnapshot,
  CollabManagerResponsibilityOfferSummary,
  CollabManagerResponsibilityPurpose,
  CollabRetirementResult,
} from '@/core/collab';

export type LanCollabJoinAttemptId = string;

export interface LanCollabJoinAttempt {
  readonly id: LanCollabJoinAttemptId;
  readonly projectId: CollabProjectId;
  readonly member: CollabMember;
  readonly memberCredential: string;
  readonly expiresAt: CollabIsoTimestamp;
}

export interface CreateJoinAttemptRequest {
  readonly projectId: CollabProjectId;
  readonly joinAttemptId: LanCollabJoinAttemptId;
  readonly displayName: string;
}

export interface CreateJoinAttemptResponse {
  readonly joinAttempt: LanCollabJoinAttempt;
}

export interface ActivateJoinAttemptRequest extends CollabMutationContext {
  readonly joinAttemptId: LanCollabJoinAttemptId;
}

export interface GetSnapshotRequest {
  readonly projectId: CollabProjectId;
}

export type CreateInvitationRequest = CollabMutationContext;
export type RevokeInvitationRequest = CollabMutationContext;

export interface LeaveProjectRequest extends CollabMutationContext {
  readonly expectedMemberId: CollabMemberId;
  readonly expectedHostMemberId: CollabMemberId;
  readonly idempotencyManagerMemberId: CollabMemberId | null;
  readonly managerResponsibilityOfferId?: CollabOperationId;
}

export interface CreateManagerResponsibilityOfferRequest extends CollabMutationContext {
  readonly purpose: CollabManagerResponsibilityPurpose;
  readonly targetMemberId: CollabMemberId;
}

export interface GetCurrentManagerResponsibilityOfferRequest {
  readonly projectId: CollabProjectId;
}

export interface GetManagerResponsibilityOfferRequest {
  readonly projectId: CollabProjectId;
  readonly offerId: CollabOperationId;
}

export interface AcknowledgeManagerResponsibilityRequest extends CollabMutationContext {
  readonly offerId: CollabOperationId;
  readonly expectedTargetMemberId: CollabMemberId;
}

export type DeclineManagerResponsibilityRequest =
  AcknowledgeManagerResponsibilityRequest;

export interface CancelManagerResponsibilityOfferRequest extends CollabMutationContext {
  readonly offerId: CollabOperationId;
}

export interface PromoteManagerRequest extends CollabMutationContext {
  readonly targetMemberId: CollabMemberId;
  readonly managerResponsibilityOfferId: CollabOperationId;
}

export interface PromoteManagerResponse {
  readonly projectId: CollabProjectId;
  readonly promotedMemberId: CollabMemberId;
  readonly managerSetGeneration: number;
}

export interface DemoteManagerRequest extends CollabMutationContext {
  readonly targetMemberId: CollabMemberId;
}

export interface DemoteManagerResponse {
  readonly projectId: CollabProjectId;
  readonly demotedMemberId: CollabMemberId;
  readonly managerSetGeneration: number;
}

export interface RemoveMemberRequest extends CollabMutationContext {
  readonly memberId: CollabMemberId;
}

export interface CreateHostTransferRequest extends CollabMutationContext {
  readonly expectedHostMemberId: CollabMemberId;
  readonly targetMemberId: CollabMemberId;
}

export interface AcceptHostTransferRequest extends CollabMutationContext {
  readonly transferId: CollabOperationId;
  readonly targetEndpoint: string;
  readonly targetCaCertificatePem: string;
  readonly targetCaFingerprint: string;
  readonly receiverCredential: string;
}

export interface DeclineHostTransferRequest extends CollabMutationContext {
  readonly transferId: CollabOperationId;
  readonly expectedTargetMemberId: CollabMemberId;
}

export interface CancelHostTransferRequest extends CollabMutationContext {
  readonly transferId: CollabOperationId;
  readonly expectedHostMemberId: CollabMemberId;
}

export interface RetireProjectRequest extends CollabMutationContext {
  readonly managerActorMemberId: CollabMemberId;
  readonly expectedHostMemberId: CollabMemberId;
}

export interface AcknowledgeRetirementRequest extends CollabMutationContext {
  readonly retiredAt: CollabIsoTimestamp;
}

export interface AcknowledgeRetirementResponse extends CollabRetirementResult {
  readonly acknowledgedAt: CollabIsoTimestamp;
}

export interface GetHostTransitionsRequest {
  readonly projectId: CollabProjectId;
}

export interface GetHostTransitionsResponse {
  readonly projectId: CollabProjectId;
  readonly proofs: readonly CollabHostTrustTransitionProof[];
}

export interface MembershipTerminationResponse {
  readonly discardedRequestId: CollabRequestId | null;
  readonly memberId: CollabMemberId;
  readonly projectId: CollabProjectId;
  readonly status: 'left' | 'revoked';
}

export interface RefreshEndpointResponse {
  readonly endpoint: string;
  readonly caFingerprint: string;
}

export interface ConfirmEndpointRequest {
  readonly projectId: CollabProjectId;
}

export type ConfirmEndpointResponse = RefreshEndpointResponse;

export interface LanCreateInvitationResponse {
  readonly encodedInvitation: string;
  readonly invitation: LanCollabInvitation;
}

export interface LanRefreshEndpointRequest {
  readonly invitation: LanCollabInvitation;
  readonly projectId: string;
}

export interface LanCollabControlOperationMap extends CollabControlOperationMap {
  createJoinAttempt: CollabControlOperationDefinition<
    CreateJoinAttemptRequest,
    CreateJoinAttemptResponse
  >;
  activateJoinAttempt: CollabControlOperationDefinition<
    ActivateJoinAttemptRequest,
    CollabLanProjectSnapshot
  >;
  getSnapshot: CollabControlOperationDefinition<GetSnapshotRequest, CollabLanProjectSnapshot>;
  createInvitation: CollabControlOperationDefinition<
    CreateInvitationRequest,
    LanCreateInvitationResponse
  >;
  revokeInvitation: CollabControlOperationDefinition<
    RevokeInvitationRequest,
    CollabLanProjectSnapshot
  >;
  createManagerResponsibilityOffer: CollabControlOperationDefinition<
    CreateManagerResponsibilityOfferRequest,
    CollabManagerResponsibilityOfferSummary
  >;
  getCurrentManagerResponsibilityOffer: CollabControlOperationDefinition<
    GetCurrentManagerResponsibilityOfferRequest,
    CollabManagerResponsibilityOfferSummary | null
  >;
  getManagerResponsibilityOffer: CollabControlOperationDefinition<
    GetManagerResponsibilityOfferRequest,
    CollabManagerResponsibilityOfferSummary
  >;
  acknowledgeManagerResponsibility: CollabControlOperationDefinition<
    AcknowledgeManagerResponsibilityRequest,
    CollabManagerResponsibilityOfferSummary
  >;
  declineManagerResponsibility: CollabControlOperationDefinition<
    DeclineManagerResponsibilityRequest,
    CollabManagerResponsibilityOfferSummary
  >;
  cancelManagerResponsibilityOffer: CollabControlOperationDefinition<
    CancelManagerResponsibilityOfferRequest,
    CollabManagerResponsibilityOfferSummary
  >;
  promoteManager: CollabControlOperationDefinition<PromoteManagerRequest, PromoteManagerResponse>;
  demoteManager: CollabControlOperationDefinition<DemoteManagerRequest, DemoteManagerResponse>;
  createHostTransfer: CollabControlOperationDefinition<
    CreateHostTransferRequest,
    CollabHostTransferSummary
  >;
  acceptHostTransfer: CollabControlOperationDefinition<
    AcceptHostTransferRequest,
    CollabHostTransferSummary
  >;
  declineHostTransfer: CollabControlOperationDefinition<
    DeclineHostTransferRequest,
    CollabHostTransferSummary
  >;
  cancelHostTransfer: CollabControlOperationDefinition<
    CancelHostTransferRequest,
    CollabHostTransferSummary
  >;
  removeMember: CollabControlOperationDefinition<
    RemoveMemberRequest,
    MembershipTerminationResponse
  >;
  leaveProject: CollabControlOperationDefinition<
    LeaveProjectRequest,
    MembershipTerminationResponse
  >;
  retireProject: CollabControlOperationDefinition<RetireProjectRequest, CollabRetirementResult>;
  acknowledgeRetirement: CollabControlOperationDefinition<
    AcknowledgeRetirementRequest,
    AcknowledgeRetirementResponse
  >;
  getHostTransitions: CollabControlOperationDefinition<
    GetHostTransitionsRequest,
    GetHostTransitionsResponse
  >;
  refreshEndpoint: CollabControlOperationDefinition<
    LanRefreshEndpointRequest,
    RefreshEndpointResponse
  >;
  confirmEndpoint: CollabControlOperationDefinition<
    ConfirmEndpointRequest,
    ConfirmEndpointResponse
  >;
}

export type LanCollabControlOperation = keyof LanCollabControlOperationMap;

export const LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS = Object.freeze([
  'leaveProject',
  'createManagerResponsibilityOffer',
  'getCurrentManagerResponsibilityOffer',
  'getManagerResponsibilityOffer',
  'acknowledgeManagerResponsibility',
  'declineManagerResponsibility',
  'cancelManagerResponsibilityOffer',
  'promoteManager',
  'demoteManager',
  'createHostTransfer',
  'acceptHostTransfer',
  'declineHostTransfer',
  'cancelHostTransfer',
  'retireProject',
  'acknowledgeRetirement',
  'getHostTransitions',
] as const satisfies readonly LanCollabControlOperation[]);

export type LanCollabLifecycleControlOperation =
  typeof LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS[number];
