import type { CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

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
  membership<Operation extends CollabAuthorityMembershipOperation>(
    operation: Operation,
    input: CollabAuthorityMembershipOperationMap[Operation]['input'],
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityMembershipOperationMap[Operation]['result']>;
}
