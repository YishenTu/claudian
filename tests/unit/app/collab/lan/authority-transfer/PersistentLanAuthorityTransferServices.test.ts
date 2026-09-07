import { createHash } from 'node:crypto';

import type {
  CollabAuthorityTransferStatus,
  CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';

import {
  PersistentLanAuthorityTransferTargetActiveService,
  PersistentLanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/PersistentLanAuthorityTransferServices';

const PROJECT_ID = 'project-persistent-route';
const TRANSFER_ID = 'transfer-persistent-route';
const MEMBER_ID = 'member-offline';
const CLAIM = Buffer.alloc(32, 5).toString('base64url');
const CHECKPOINT_SHA256 = 'a'.repeat(64);

function status(): CollabAuthorityTransferStatus {
  return {
    batchRevision: 1,
    batchSha256: 'b'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA256,
    createdAt: '2026-08-27T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-09-26T00:00:00.000Z',
    phase: 'completed',
    projectId: PROJECT_ID,
    relinquishmentProof: {
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
      certificate: Buffer.alloc(64, 2).toString('base64url'),
      certificateAlgorithm: 'ed25519',
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-27T00:00:08.000Z',
      operationIntentId: 'intent-owner',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: 'lan' },
      sourceHostMemberId: 'member-host',
      targetAuthority: { generation: 2, kind: 'cloud' },
      transferId: TRANSFER_ID,
    },
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: 'completed',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'https://cloud.example.test/',
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:00:10.000Z',
  };
}

function receipt(memberId = MEMBER_ID): CollabTransferredMembershipRedemptionReceipt {
  return {
    checkpointSha256: CHECKPOINT_SHA256,
    claimSha256: createHash('sha256').update(CLAIM, 'utf8').digest('hex'),
    memberId,
    operationIntentId: 'intent-claimant',
    projectId: PROJECT_ID,
    receiptId: 'receipt-persistent-route',
    receiptKeyId: 'cloud-receipt-key',
    redeemedAt: '2026-08-27T00:01:00.000Z',
    signature: Buffer.alloc(64, 4).toString('base64url'),
    signatureAlgorithm: 'ed25519',
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
}

describe('persistent LAN authority-transfer services', () => {
  it('expires claims, removes exact staging, and completes durable terminal cleanup', async () => {
    const calls: string[] = [];
    const record = {
      localRole: 'source',
      operationIntentId: 'intent-owner',
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status(),
      terminalCleanupCompleted: false,
      terminalResponder: { expiresAt: status().expiresAt, state: 'active' },
      transferId: TRANSFER_ID,
    } as const;
    const service = new PersistentLanAuthorityTransferTerminalSourceService({
      authenticate: async () => ({ memberId: MEMBER_ID }),
      cleanupStaging: async input => {
        expect(input).toBe(record);
        calls.push('staging');
      },
      expiresAt: status().expiresAt,
      persistence: {
        completeTerminalCleanup: async (input: unknown) => {
          expect(input).toEqual({
            operationIntentId: 'intent-owner',
            projectId: PROJECT_ID,
            stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
            transferId: TRANSFER_ID,
          });
          calls.push('complete');
        },
        expireTerminalResponder: async () => {
          calls.push('expire');
        },
        load: async () => record,
      } as never,
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });

    await expect(service.expire()).resolves.toBeUndefined();
    expect(calls).toEqual(['expire', 'staging', 'complete']);
  });

  it('serves only the authenticated former Member claim and scrubs after signature verification', async () => {
    const verify = jest.fn(async () => undefined);
    const scrubClaimWithVerifiedReceipt = jest.fn(async () => undefined);
    const service = new PersistentLanAuthorityTransferTerminalSourceService({
      authenticate: async () => ({ memberId: MEMBER_ID }),
      cleanupStaging: jest.fn(),
      expiresAt: status().expiresAt,
      now: () => new Date('2026-08-27T00:02:00.000Z'),
      persistence: {
        expireTerminalResponder: jest.fn(),
        load: async () => ({
          projectId: PROJECT_ID,
          localRole: 'source',
          status: status(),
          terminalResponder: { expiresAt: status().expiresAt, state: 'active' },
          transferId: TRANSFER_ID,
        }),
        loadClaim: async (
          _projectId: string,
          _transferId: string,
          memberId: string,
        ) => ({
          claim: CLAIM,
          expiresAt: status().expiresAt,
          memberId,
          projectId: PROJECT_ID,
          targetAuthorityGeneration: 2,
          transferId: TRANSFER_ID,
        }),
        scrubClaimWithVerifiedReceipt,
      } as never,
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
      verifyRedemptionReceipt: verify,
    });
    const actor = await service.authenticateMemberCredential('credential');

    await expect(service.getTransferredMembershipClaim(actor, {
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    })).resolves.toMatchObject({ memberId: MEMBER_ID });
    await expect(service.acknowledgeTransferredMembershipClaimRedemption(actor, {
      idempotencyKey: 'intent-ack',
      projectId: PROJECT_ID,
      receipt: receipt(),
      transferId: TRANSFER_ID,
    })).resolves.toMatchObject({
      memberId: MEMBER_ID,
      receiptId: 'receipt-persistent-route',
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(scrubClaimWithVerifiedReceipt).toHaveBeenCalledWith({
      acknowledgedAt: '2026-08-27T00:02:00.000Z',
      receipt: receipt(),
    });
  });

  it('rejects a redemption receipt for a different former Member before scrubbing', async () => {
    const scrubClaimWithVerifiedReceipt = jest.fn();
    const verifyRedemptionReceipt = jest.fn();
    const service = new PersistentLanAuthorityTransferTerminalSourceService({
      authenticate: async () => ({ memberId: MEMBER_ID }),
      cleanupStaging: jest.fn(),
      expiresAt: status().expiresAt,
      persistence: {
        expireTerminalResponder: jest.fn(),
        load: async () => ({
          projectId: PROJECT_ID,
          localRole: 'source',
          status: status(),
          terminalResponder: { expiresAt: status().expiresAt, state: 'active' },
          transferId: TRANSFER_ID,
        }),
        scrubClaimWithVerifiedReceipt,
      } as never,
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
      verifyRedemptionReceipt,
    });

    await expect(service.acknowledgeTransferredMembershipClaimRedemption(
      { memberId: MEMBER_ID },
      {
        idempotencyKey: 'intent-ack-wrong',
        projectId: PROJECT_ID,
        receipt: receipt('member-other'),
        transferId: TRANSFER_ID,
      },
    )).rejects.toMatchObject({ code: 'authorization-denied' });
    expect(verifyRedemptionReceipt).not.toHaveBeenCalled();
    expect(scrubClaimWithVerifiedReceipt).not.toHaveBeenCalled();
  });

  it('validates the target receipt before exposing it to a LAN claimant', async () => {
    const bind = jest.fn(async () => receipt());
    const expire = jest.fn(async () => undefined);
    const service = new PersistentLanAuthorityTransferTargetActiveService({
      bind,
      expire,
      expiresAt: status().expiresAt,
      projectId: PROJECT_ID,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });
    const request = {
      claim: CLAIM,
      credentialHash: 'c'.repeat(64),
      idempotencyKey: 'intent-claimant',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };

    await expect(service.claimTransferredMembership(request)).resolves.toEqual(receipt());
    expect(bind).toHaveBeenCalledWith(request);
    expect(service.expiresAt).toBe(status().expiresAt);
    await expect(service.expire()).resolves.toBeUndefined();
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
