import type {
  CollabControlOperationDefinition,
  CollabControlOperationMap,
  CollabIsoTimestamp,
  CollabMember,
  CollabMemberId,
  CollabMutationContext,
  CollabOperationId,
  CollabProjectId,
  CollabProjectRecoveryOperationMap,
  CollabRequestId,
  CollabRequestTicketOperation,
} from '@claudian-collab/protocol';

import type { LANCollabInvitation } from '@/app/collab/lan/InvitationCodec';
import type {
  CollabHostTransferSummary,
  CollabHostTrustTransitionProof,
  CollabLANProjectSnapshot,
  CollabManagerResponsibilityOfferSummary,
  CollabManagerResponsibilityPurpose,
  CollabRetirementResult,
} from '@/core/collab';

export type LANCollabJoinAttemptId = string;

export interface LANCollabJoinAttempt {
  readonly id: LANCollabJoinAttemptId;
  readonly projectId: CollabProjectId;
  readonly member: CollabMember;
  readonly memberCredential: string;
  readonly expiresAt: CollabIsoTimestamp;
}

export interface CreateJoinAttemptRequest {
  readonly projectId: CollabProjectId;
  readonly joinAttemptId: LANCollabJoinAttemptId;
  readonly displayName: string;
}

export interface CreateJoinAttemptResponse {
  readonly joinAttempt: LANCollabJoinAttempt;
}

export interface ActivateJoinAttemptRequest extends CollabMutationContext {
  readonly joinAttemptId: LANCollabJoinAttemptId;
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
  readonly managerResponsibilityOfferId?: CollabOperationId;
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

export interface LANCreateInvitationResponse {
  readonly encodedInvitation: string;
  readonly invitation: LANCollabInvitation;
}

export interface LANRefreshEndpointRequest {
  readonly invitation: LANCollabInvitation;
  readonly projectId: string;
}

type SharedCollabControlOperationMap = Pick<
  CollabControlOperationMap,
  CollabRequestTicketOperation | keyof CollabProjectRecoveryOperationMap | 'listProjectMembers' | 'reissueTransferredMembershipClaim' | 'claimTransferredMembership'
>;

export interface LANCollabControlOperationMap extends SharedCollabControlOperationMap {
  createJoinAttempt: CollabControlOperationDefinition<
    CreateJoinAttemptRequest,
    CreateJoinAttemptResponse
  >;
  activateJoinAttempt: CollabControlOperationDefinition<
    ActivateJoinAttemptRequest,
    CollabLANProjectSnapshot
  >;
  getSnapshot: CollabControlOperationDefinition<GetSnapshotRequest, CollabLANProjectSnapshot>;
  createInvitation: CollabControlOperationDefinition<
    CreateInvitationRequest,
    LANCreateInvitationResponse
  >;
  revokeInvitation: CollabControlOperationDefinition<
    RevokeInvitationRequest,
    CollabLANProjectSnapshot
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
    LANRefreshEndpointRequest,
    RefreshEndpointResponse
  >;
  confirmEndpoint: CollabControlOperationDefinition<
    ConfirmEndpointRequest,
    ConfirmEndpointResponse
  >;
}

export type LANCollabControlOperation = keyof LANCollabControlOperationMap;

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
] as const satisfies readonly LANCollabControlOperation[]);

export type LANCollabLifecycleControlOperation =
  typeof LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS[number];
