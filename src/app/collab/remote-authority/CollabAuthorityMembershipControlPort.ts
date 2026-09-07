import type {
  DemoteManagerResponse,
  MembershipTerminationResponse,
  PromoteManagerResponse,
} from '@/app/collab/lan/LanCollabControlOperations';
import type {
  CancelManagerResponsibilityOfferInput,
  CreateInvitationInput,
  CreateManagerResponsibilityOfferInput,
  DemoteManagerInput,
  GetManagerResponsibilityOfferInput,
  ManagerResponsibilityOfferInput,
  PromoteManagerInput,
  RemoveMemberInput,
  RevokeInvitationInput,
} from '@/app/collab/membership/MembershipControlClient';
import type {
  CollabInvitationView,
  CollabManagerResponsibilityOfferSummary,
  CollabOperationOptions,
} from '@/core/collab';

type AuthorityInput<Input> = Omit<Input, 'memberCredential' | 'signal'>;

export interface CollabAuthorityMembershipOperationMap {
  readonly acknowledgeManagerResponsibility: {
    readonly input: AuthorityInput<ManagerResponsibilityOfferInput>;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly cancelManagerResponsibilityOffer: {
    readonly input: AuthorityInput<CancelManagerResponsibilityOfferInput>;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly createInvitation: {
    readonly input: AuthorityInput<CreateInvitationInput>;
    readonly result: CollabInvitationView;
  };
  readonly createManagerResponsibilityOffer: {
    readonly input: AuthorityInput<CreateManagerResponsibilityOfferInput>;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly declineManagerResponsibility: {
    readonly input: AuthorityInput<ManagerResponsibilityOfferInput>;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly demoteManager: {
    readonly input: AuthorityInput<DemoteManagerInput>;
    readonly result: DemoteManagerResponse;
  };
  readonly getManagerResponsibilityOffer: {
    readonly input: AuthorityInput<GetManagerResponsibilityOfferInput>;
    readonly result: CollabManagerResponsibilityOfferSummary;
  };
  readonly promoteManager: {
    readonly input: AuthorityInput<PromoteManagerInput>;
    readonly result: PromoteManagerResponse;
  };
  readonly removeMember: {
    readonly input: AuthorityInput<RemoveMemberInput>;
    readonly result: MembershipTerminationResponse;
  };
  readonly revokeInvitation: {
    readonly input: AuthorityInput<RevokeInvitationInput>;
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
