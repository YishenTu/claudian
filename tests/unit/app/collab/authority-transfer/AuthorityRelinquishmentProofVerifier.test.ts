import { generateKeyPairSync, sign } from 'node:crypto';

import {
  type CollabAuthorityRelinquishmentProof,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { verifyAuthorityRelinquishmentProof } from '@/app/collab/authority-transfer/AuthorityRelinquishmentProofVerifier';
import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';

const PROJECT_ID = 'project-relinquishment-verifier';
const TRANSFER_ID = 'transfer-relinquishment-verifier';

describe('verifyAuthorityRelinquishmentProof', () => {
  it('accepts only the exact proof signed by the transfer-pinned Cloud key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const receiptPublicKey = (publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
    const payload = {
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: 'a'.repeat(64),
      committedAt: '2026-08-27T00:00:08.000Z',
      operationIntentId: 'intent-relinquishment-verifier',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 2, kind: 'lan' as const },
      transferId: TRANSFER_ID,
    };
    const proof: CollabAuthorityRelinquishmentProof = {
      ...payload,
      certificate: sign(
        null,
        Buffer.from(encodeCollabAuthorityRelinquishmentProofSigningInput(payload), 'utf8'),
        privateKey,
      ).toString('base64url'),
    };
    const record = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-target',
      ownerInstallationKey: TEST_INSTALLATION_A,
      receiptVerifier: {
        projectId: PROJECT_ID,
        receiptKeyId: 'receipt-key-source',
        receiptPublicKey,
        receiptPublicKeyEncoding: 'base64url-raw',
        signatureAlgorithm: 'ed25519',
        transferId: TRANSFER_ID,
      },
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        batchRevision: 1,
        batchSha256: 'b'.repeat(64),
        checkpointSha256: 'a'.repeat(64),
        createdAt: '2026-08-27T00:00:00.000Z',
        direction: 'cloud-to-lan',
        expiresAt: '2026-09-26T00:00:00.000Z',
        phase: 'completed',
        projectId: PROJECT_ID,
        relinquishmentProof: proof,
        sourceAuthority: payload.sourceAuthority,
        state: 'completed',
        targetAuthority: payload.targetAuthority,
        targetUrl: 'https://lan.example.test',
        transferId: TRANSFER_ID,
        updatedAt: '2026-08-27T00:00:10.000Z',
      },
    });

    await expect(verifyAuthorityRelinquishmentProof(proof, record))
      .resolves.toBeUndefined();
    const tampered = Buffer.from(proof.certificate, 'base64url');
    tampered[0] ^= 1;
    await expect(verifyAuthorityRelinquishmentProof({
      ...proof,
      certificate: tampered.toString('base64url'),
    }, record)).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'authority-transfer-relinquishment-proof-invalid' },
    });
  });
});
