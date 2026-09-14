import type { ClaimTransferredMembershipRequest, RedeemProjectRecoveryLinkRequest } from '@claudian-collab/protocol';

import type { AuthorityTransferClaimantLanTarget } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { LanAuthorityTransferTargetSnapshotReader } from '@/app/collab/authority-transfer/LanAuthorityTransferTargetSnapshotReader';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { collabControlOperationPath } from '@/app/collab/lan/CollabControlOperationBindings';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Verifies the selected current LAN generation before exposing a recovery secret. */
export class LanMembershipClaimClient {
  private readonly identity: LanAuthorityTransferClient;
  readonly snapshots: LanAuthorityTransferTargetSnapshotReader;

  constructor(private readonly target: AuthorityTransferClaimantLanTarget & { projectId: string; authorityGeneration: number }) {
    this.identity = new LanAuthorityTransferClient(target);
    this.snapshots = new LanAuthorityTransferTargetSnapshotReader(target);
  }

  async redeemProjectRecoveryLink(request: RedeemProjectRecoveryLinkRequest, options: CollabOperationOptions) {
    if (request.projectId !== this.target.projectId || request.expectedAuthorityGeneration !== this.target.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
    const endpoint = await this.identity.resolveCurrentAuthorityEndpoint(this.target.authorityGeneration, options);
    return new PinnedCollabHttpClient({ ...this.target, endpoint }, 10_000).requestPublic({
      method: 'POST', path: collabControlOperationPath('redeemProjectRecoveryLink', request.projectId),
      body: request, idempotencyKey: request.idempotencyKey,
      decode: value => {
        const receipt = lanCollabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse(value);
        if (receipt.projectId !== request.projectId || receipt.recoveryLinkId !== request.recoveryLinkId
          || receipt.authorityGeneration !== this.target.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
        return receipt;
      },
    }, options);
  }

  async redeem(request: Extract<ClaimTransferredMembershipRequest, { credentialHash: string }>, options: CollabOperationOptions) {
    if (request.projectId !== this.target.projectId) throw new CollabError({ code: 'project-not-found' });
    const endpoint = await this.identity.resolveCurrentAuthorityEndpoint(this.target.authorityGeneration, options);
    return new PinnedCollabHttpClient({ ...this.target, endpoint }, 10_000).requestPublic({
      method: 'POST', path: collabControlOperationPath('claimTransferredMembership', request.projectId),
      body: request, idempotencyKey: request.idempotencyKey,
      decode: value => {
        const receipt = lanCollabControlOperationCodec('claimTransferredMembership').decodeResponse(value);
        if (receipt.projectId !== request.projectId || receipt.transferId !== request.transferId
          || receipt.targetAuthorityGeneration !== this.target.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
        return receipt;
      },
    }, options);
  }
}
