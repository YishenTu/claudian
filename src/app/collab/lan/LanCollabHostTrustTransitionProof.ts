import { type CollabDecodeResult, CollabError, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type { CollabHostTrustTransitionProof } from '@/core/collab';

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{64,2048}$/;
const CERTIFICATE_PATTERN = /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n?$/;

function invalid(field: string): CollabDecodeResult<CollabHostTrustTransitionProof> {
  return {
    error: new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { field },
    }),
    status: 'invalid',
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function decodeLanCollabHostTrustTransitionProof(
  input: unknown,
): CollabDecodeResult<CollabHostTrustTransitionProof> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('hostTransitionProof');
  }
  const value = input as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'issuedAt',
    'nextCaCertificatePem',
    'nextCaFingerprint',
    'previousCaFingerprint',
    'projectId',
    'schemaVersion',
    'signature',
    'signatureAlgorithm',
    'transferId',
  ] as const;
  if (
    Object.keys(value).length !== expectedKeys.length
    || !expectedKeys.every(key => Object.hasOwn(value, key))
    || value.schemaVersion !== 1
    || typeof value.projectId !== 'string'
    || !isCollabProjectId(value.projectId)
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
    || typeof value.previousCaFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.previousCaFingerprint)
    || typeof value.nextCaCertificatePem !== 'string'
    || value.nextCaCertificatePem.length > 64 * 1024
    || !CERTIFICATE_PATTERN.test(value.nextCaCertificatePem)
    || typeof value.nextCaFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.nextCaFingerprint)
    || !isIsoTimestamp(value.issuedAt)
    || value.signatureAlgorithm !== 'rsa-pss-sha256'
    || typeof value.signature !== 'string'
    || !SIGNATURE_PATTERN.test(value.signature)
  ) {
    return invalid('hostTransitionProof');
  }
  return {
    status: 'ok',
    value: value as unknown as CollabHostTrustTransitionProof,
  };
}
