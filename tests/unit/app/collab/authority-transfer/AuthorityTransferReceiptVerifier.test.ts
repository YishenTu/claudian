import { generateKeyPairSync, sign } from 'node:crypto';

import {
  type CollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  verifyAuthorityTransferRedemptionReceipt,
} from '@/app/collab/authority-transfer/AuthorityTransferReceiptVerifier';
import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';

const PROJECT_ID = 'project-receipt-verifier';
const TRANSFER_ID = 'transfer-receipt-verifier';
const CHECKPOINT_SHA256 = 'a'.repeat(64);

function terminalRecord(receiptKeyId: string, receiptPublicKey: string) {
  return createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
    lifecycleOwnership: 'owned',
    localRole: 'source',
    operationIntentId: 'intent-receipt-verifier',
    receiptVerifier: {
      projectId: PROJECT_ID,
      receiptKeyId,
      receiptPublicKey,
      receiptPublicKeyEncoding: 'base64url-raw',
      signatureAlgorithm: 'ed25519',
      transferId: TRANSFER_ID,
    },
    stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
    status: {
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
        certificate: Buffer.alloc(64, 1).toString('base64url'),
        certificateAlgorithm: 'ed25519',
        checkpointSha256: CHECKPOINT_SHA256,
        committedAt: '2026-08-27T00:00:08.000Z',
        operationIntentId: 'intent-receipt-verifier',
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
    },
  });
}

describe('verifyAuthorityTransferRedemptionReceipt', () => {
  it('accepts only a receipt signed by the transfer-pinned Cloud key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const receiptKeyId = 'receipt-key-1';
    const receiptPublicKey = (publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
    const payload = {
      checkpointSha256: CHECKPOINT_SHA256,
      claimSha256: 'c'.repeat(64),
      memberId: 'member-offline',
      operationIntentId: 'intent-redeem',
      projectId: PROJECT_ID,
      receiptId: 'receipt-1',
      receiptKeyId,
      redeemedAt: '2026-08-27T00:00:12.000Z',
      signatureAlgorithm: 'ed25519' as const,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    };
    const receipt: CollabTransferredMembershipRedemptionReceipt = {
      ...payload,
      signature: sign(
        null,
        Buffer.from(
          encodeCollabTransferredMembershipRedemptionReceiptSigningInput(payload),
          'utf8',
        ),
        privateKey,
      ).toString('base64url'),
    };

    await expect(verifyAuthorityTransferRedemptionReceipt(
      receipt,
      terminalRecord(receiptKeyId, receiptPublicKey),
    )).resolves.toBeUndefined();

    await expect(verifyAuthorityTransferRedemptionReceipt(
      { ...receipt, receiptKeyId: 'receipt-key-2' },
      terminalRecord(receiptKeyId, receiptPublicKey),
    )).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'authority-transfer-redemption-receipt-invalid' },
    });

    const tampered = Buffer.from(receipt.signature, 'base64url');
    tampered[0] ^= 1;
    await expect(verifyAuthorityTransferRedemptionReceipt(
      { ...receipt, signature: tampered.toString('base64url') },
      terminalRecord(receiptKeyId, receiptPublicKey),
    )).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'authority-transfer-redemption-receipt-invalid' },
    });
  });

  it('fails closed when restart lost the transfer-pinned verifier', async () => {
    const record = terminalRecord('receipt-key-1', Buffer.alloc(32, 1).toString('base64url'));

    await expect(verifyAuthorityTransferRedemptionReceipt({} as never, {
      ...record,
      receiptVerifier: null,
    })).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-receipt-verifier-missing' },
    });
  });
});
