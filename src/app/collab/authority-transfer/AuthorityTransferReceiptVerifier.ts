import { createPublicKey, verify } from 'node:crypto';

import {
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
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

function invalidReceipt(): CollabError {
  return new CollabError({
    code: 'authorization-denied',
    safeContext: { reason: 'authority-transfer-redemption-receipt-invalid' },
  });
}

/** Verifies a Cloud redemption receipt against the key pinned before LAN relinquishment. */
export async function verifyAuthorityTransferRedemptionReceipt(
  value: CollabTransferredMembershipRedemptionReceipt,
  record: AuthorityTransferRecord,
): Promise<void> {
  const verifier = record.receiptVerifier;
  if (!verifier) {
    throw verifierUnavailable('authority-transfer-receipt-verifier-missing');
  }
  let receipt: CollabTransferredMembershipRedemptionReceipt;
  try {
    receipt = decodeCollabTransferredMembershipRedemptionReceipt(value);
  } catch {
    throw invalidReceipt();
  }
  if (
    verifier.projectId !== record.projectId
    || verifier.transferId !== record.transferId
    || receipt.projectId !== verifier.projectId
    || receipt.transferId !== verifier.transferId
    || receipt.receiptKeyId !== verifier.receiptKeyId
    || receipt.signatureAlgorithm !== verifier.signatureAlgorithm
  ) {
    throw invalidReceipt();
  }

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
  const { signature: _signature, ...payload } = receipt;
  const valid = verify(
    null,
    Buffer.from(
      encodeCollabTransferredMembershipRedemptionReceiptSigningInput(payload),
      'utf8',
    ),
    publicKey,
    Buffer.from(receipt.signature, 'base64url'),
  );
  if (!valid) throw invalidReceipt();
}
