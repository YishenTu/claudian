import { type CollabIsoTimestamp, type CollabMemberId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { decodeLanCollabHostTrustTransitionProof } from '@/app/collab/lan/LanCollabHostTrustTransitionProof';
import type { CollabHostTrustTransitionProof, CollabRetirementResult } from '@/core/collab';

export const COLLAB_RETIREMENT_TOMBSTONE_SCHEMA_VERSION = 1 as const;
export interface RetirementTombstoneMember {
  readonly memberId: CollabMemberId;
  readonly credentialHash: string;
  readonly acknowledgedAt: CollabIsoTimestamp | null;
}
export interface RetirementTombstoneRecord {
  readonly schemaVersion: typeof COLLAB_RETIREMENT_TOMBSTONE_SCHEMA_VERSION;
  readonly kind: 'retirement-tombstone';
  readonly projectId: CollabProjectId;
  readonly retiredAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly result: CollabRetirementResult;
  readonly replay: {
    readonly actorMemberId: CollabMemberId;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  };
  readonly hostTransitionProofs: readonly CollabHostTrustTransitionProof[];
  readonly formerMembers: readonly RetirementTombstoneMember[];
}
type Value = Readonly<Record<string, unknown>>;
const DIGEST = /^[0-9a-f]{64}$/;
const KEYS = new Set(['schemaVersion', 'kind', 'projectId', 'retiredAt', 'expiresAt', 'result', 'replay', 'hostTransitionProofs', 'formerMembers']);
function exact(value: unknown, keys: ReadonlySet<string>, name: string): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  const record = value as Value;
  if (Object.keys(record).length !== keys.size || Object.keys(record).some(key => !keys.has(key))) throw new TypeError(`Unexpected ${name} field`);
  return record;
}
function text(value: Value, key: string, max: number, pattern?: RegExp): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || result.length > max || (pattern && !pattern.test(result))) throw new TypeError(`Invalid ${key}`);
  return result;
}
function timestamp(value: Value, key: string, nullable = false): string | null {
  if (nullable && value[key] === null) return null;
  const result = text(value, key, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError(`Invalid ${key}`);
  return result;
}
export function decodeRetirementTombstoneRecord(value: unknown): RetirementTombstoneRecord {
  const record = exact(value, KEYS, 'retirement tombstone');
  if (record.schemaVersion !== 1 || record.kind !== 'retirement-tombstone' || !Array.isArray(record.hostTransitionProofs) || !Array.isArray(record.formerMembers) || record.hostTransitionProofs.length > 64 || record.formerMembers.length === 0 || record.formerMembers.length > 10_000) throw new TypeError('Invalid retirement tombstone');
  const projectId = text(record, 'projectId', 64);
  if (!isCollabProjectId(projectId)) throw new TypeError('Invalid projectId');
  const retiredAt = timestamp(record, 'retiredAt')!;
  const expiresAt = timestamp(record, 'expiresAt')!;
  if (Date.parse(expiresAt) - Date.parse(retiredAt) !== 30 * 24 * 60 * 60 * 1000) throw new TypeError('Invalid tombstone expiry');
  const result = exact(record.result, new Set(['projectId', 'retiredAt']), 'retirement result');
  if (result.projectId !== projectId || result.retiredAt !== retiredAt) throw new TypeError('Retirement result mismatch');
  const replay = exact(record.replay, new Set(['actorMemberId', 'idempotencyKey', 'requestFingerprint']), 'retirement replay');
  const hostTransitionProofs = record.hostTransitionProofs.map(proof => {
    const decoded = decodeLanCollabHostTrustTransitionProof(proof);
    if (decoded.status !== 'ok' || decoded.value.projectId !== projectId) throw new TypeError('Invalid Host transition proof');
    return decoded.value;
  });
  const formerMembers = record.formerMembers.map(value => {
    const member = exact(value, new Set(['memberId', 'credentialHash', 'acknowledgedAt']), 'former Member');
    const acknowledgedAt = timestamp(member, 'acknowledgedAt', true);
    if (acknowledgedAt !== null && (acknowledgedAt < retiredAt || acknowledgedAt > expiresAt)) throw new TypeError('Invalid acknowledgement time');
    const memberId = text(member, 'memberId', 64);
    if (!isCollabMemberId(memberId)) throw new TypeError('Invalid memberId');
    return {
      acknowledgedAt,
      credentialHash: text(member, 'credentialHash', 64, DIGEST),
      memberId,
    };
  });
  if (new Set(formerMembers.map(member => member.memberId)).size !== formerMembers.length) throw new TypeError('Duplicate former Member');
  return {
    expiresAt,
    formerMembers,
    hostTransitionProofs,
    kind: 'retirement-tombstone',
    projectId,
    replay: {
      actorMemberId: (() => {
        const actorMemberId = text(replay, 'actorMemberId', 64);
        if (!isCollabMemberId(actorMemberId)) throw new TypeError('Invalid actorMemberId');
        return actorMemberId;
      })(),
      idempotencyKey: (() => {
        const idempotencyKey = text(replay, 'idempotencyKey', 128);
        if (!isCollabOpaqueId(idempotencyKey)) throw new TypeError('Invalid idempotencyKey');
        return idempotencyKey;
      })(),
      requestFingerprint: text(replay, 'requestFingerprint', 64, DIGEST),
    },
    result: { projectId, retiredAt },
    retiredAt,
    schemaVersion: 1,
  };
}
