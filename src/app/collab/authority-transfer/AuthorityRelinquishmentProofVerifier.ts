import { createPublicKey, verify } from 'node:crypto';

import {
  type CollabAuthorityRelinquishmentProof,
  decodeCollabAuthorityRelinquishmentProof,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function verifierUnavailable(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function invalidProof(): CollabError {
  return new CollabError({
    code: 'authorization-denied',
    safeContext: { reason: 'authority-transfer-relinquishment-proof-invalid' },
  });
}

/** Verifies a relinquishment proof against the source key pinned before cutover. */
export async function verifyAuthorityRelinquishmentProof(
  value: CollabAuthorityRelinquishmentProof,
  record: AuthorityTransferRecord,
): Promise<void> {
  const verifier = record.receiptVerifier;
  if (!verifier) {
    throw verifierUnavailable('authority-transfer-receipt-verifier-missing');
  }
  let proof: CollabAuthorityRelinquishmentProof;
  try {
    proof = decodeCollabAuthorityRelinquishmentProof(value);
  } catch {
    throw invalidProof();
  }
  if (
    verifier.projectId !== record.projectId
    || verifier.transferId !== record.transferId
    || proof.projectId !== record.projectId
    || proof.transferId !== record.transferId
    || proof.certificateAlgorithm !== verifier.signatureAlgorithm
    || proof.checkpointSha256 !== record.status.checkpointSha256
    || proof.batchRevision !== record.status.batchRevision
    || proof.batchSha256 !== record.status.batchSha256
    || proof.sourceAuthority.kind !== record.status.sourceAuthority.kind
    || proof.sourceAuthority.generation !== record.status.sourceAuthority.generation
    || proof.targetAuthority.kind !== record.status.targetAuthority.kind
    || proof.targetAuthority.generation !== record.status.targetAuthority.generation
  ) throw invalidProof();

  let publicKey;
  try {
    publicKey = createPublicKey({
      format: 'jwk',
      key: {
        crv: 'Ed25519',
        kty: 'OKP',
        x: verifier.receiptPublicKey,
      },
    });
  } catch {
    throw verifierUnavailable('authority-transfer-receipt-verifier-invalid');
  }
  const { certificate, ...payload } = proof;
  if (!verify(
    null,
    Buffer.from(encodeCollabAuthorityRelinquishmentProofSigningInput(payload), 'utf8'),
    publicKey,
    Buffer.from(certificate, 'base64url'),
  )) throw invalidProof();
}
