import type { ClaimTransferredMembershipRequest, RedeemProjectRecoveryLinkRequest } from '@claudian-collab/protocol';

import type { AuthorityTransferClaimantLANTarget } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { LANAuthorityTransferTargetSnapshotReader } from '@/app/collab/authority-transfer/LANAuthorityTransferTargetSnapshotReader';
import { LANAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LANAuthorityTransferClient';
import { collabControlOperationPath } from '@/app/collab/lan/CollabControlOperationBindings';
import { PinnedCollabHTTPClient } from '@/app/collab/lan/CollabHTTPClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LANCollabControlOperationCodecs';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Verifies the selected current LAN generation before exposing a recovery secret. */
export class LANMembershipClaimClient {
  private readonly identity: LANAuthorityTransferClient;
  readonly snapshots: LANAuthorityTransferTargetSnapshotReader;

  constructor(private readonly target: AuthorityTransferClaimantLANTarget & { projectId: string; authorityGeneration: number }) {
    this.identity = new LANAuthorityTransferClient(target);
    this.snapshots = new LANAuthorityTransferTargetSnapshotReader(target);
  }

  async redeemProjectRecoveryLink(request: RedeemProjectRecoveryLinkRequest, options: CollabOperationOptions) {
    if (request.projectId !== this.target.projectId || request.expectedAuthorityGeneration !== this.target.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
    const endpoint = await this.identity.resolveCurrentAuthorityEndpoint(this.target.authorityGeneration, options);
    return new PinnedCollabHTTPClient({ ...this.target, endpoint }, 10_000).requestPublic({
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
    return new PinnedCollabHTTPClient({ ...this.target, endpoint }, 10_000).requestPublic({
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
