import { type CollabOperationId, isCollabOpaqueId } from '@claudian-collab/protocol';

export interface HostTrustCheckpoint {
  readonly transferId: CollabOperationId;
  readonly proofChainDigest: string;
}

export function decodeHostTrustCheckpoint(value: unknown): HostTrustCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Host trust checkpoint');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== 2
    || !isCollabOpaqueId(record.transferId)
    || typeof record.proofChainDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.proofChainDigest)
  ) throw new TypeError('Invalid Host trust checkpoint');
  return { transferId: record.transferId, proofChainDigest: record.proofChainDigest };
}
