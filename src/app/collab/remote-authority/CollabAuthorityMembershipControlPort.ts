import type { CollabMemberId, CollabOperationId, CollabProjectId, CollabProjectMembershipOperation, CollabProjectMembershipOperationMap } from '@claudian-collab/protocol';

import type {
  CollabInvitationView,
  CollabManagerResponsibilityOfferSummary,
  CollabManagerResponsibilityPurpose,
  CollabOperationOptions,
} from '@/core/collab';

interface MembershipMutationInput {
  readonly idempotencyKey: string;
  readonly projectId: CollabProjectId;
}

interface ManagerResponsibilityOfferInput extends MembershipMutationInput {
  readonly offerId: CollabOperationId;
}

interface MemberRoleInput extends MembershipMutationInput {
  readonly targetMemberId: CollabMemberId;
}

export interface CollabAuthorityMembershipOperationMap {
  readonly acknowledgeManagerResponsibility: {
    readonly input: ManagerResponsibilityOfferInput;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly cancelManagerResponsibilityOffer: {
    readonly input: ManagerResponsibilityOfferInput;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly createInvitation: {
    readonly input: MembershipMutationInput;
    readonly result: CollabInvitationView;
  };
  readonly createManagerResponsibilityOffer: {
    readonly input: MemberRoleInput & { readonly purpose: CollabManagerResponsibilityPurpose };
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly declineManagerResponsibility: {
    readonly input: ManagerResponsibilityOfferInput;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly demoteManager: {
    readonly input: MemberRoleInput;
    readonly result: void;
  };
  readonly getManagerResponsibilityOffer: {
    readonly input: { readonly offerId: CollabOperationId; readonly projectId: CollabProjectId };
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly promoteManager: {
    readonly input: MemberRoleInput & { readonly managerResponsibilityOfferId: CollabOperationId };
    readonly result: void;
  };
  readonly removeMember: {
    readonly input: MembershipMutationInput & { readonly memberId: CollabMemberId };
    readonly result: void;
  };
  readonly revokeInvitation: {
    readonly input: MembershipMutationInput;
    readonly result: void;
  };
}

export type CollabAuthorityMembershipOperation = keyof CollabAuthorityMembershipOperationMap;

export interface CollabAuthorityMembershipControlPort {
  readonly authorityKind: 'lan';
  membership<Operation extends CollabAuthorityMembershipOperation>(
    operation: Operation,
    input: CollabAuthorityMembershipOperationMap[Operation]['input'],
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityMembershipOperationMap[Operation]['result']>;
}

export interface CloudMembershipBinding {
  readonly projectId: CollabProjectId;
  readonly serverUrl: string;
  readonly memberId: CollabMemberId;
  readonly authorityGeneration: number;
}

export type CloudMembershipOperation = Exclude<CollabProjectMembershipOperation,
  'createCloudProject' | 'joinCloudProject'>;

export interface CloudAuthorityMembershipControlPort {
  readonly authorityKind: 'cloud';
  cloudMembership<Operation extends CloudMembershipOperation>(
    operation: Operation,
    request: CollabProjectMembershipOperationMap[Operation]['request'],
    binding: CloudMembershipBinding,
    options?: CollabOperationOptions,
  ): Promise<CollabProjectMembershipOperationMap[Operation]['response']>;
}

export type CollabAuthorityMembershipRouterPort =
  Pick<CollabAuthorityMembershipControlPort, 'membership'>
  & Pick<CloudAuthorityMembershipControlPort, 'cloudMembership'>;
