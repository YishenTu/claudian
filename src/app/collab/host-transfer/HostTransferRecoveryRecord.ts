import { type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

export const COLLAB_HOST_TRANSFER_RECOVERY_SCHEMA_VERSION = 1 as const;
export type HostTransferRecoveryDirection = 'incoming' | 'outgoing';
export type HostTransferRecoveryPhase =
  | 'offered'
  | 'accepted'
  | 'quiescing'
  | 'staged'
  | 'authority-relinquished'
  | 'target-active'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired';
export interface HostTransferRecoveryRecord {
  readonly schemaVersion: typeof COLLAB_HOST_TRANSFER_RECOVERY_SCHEMA_VERSION;
  readonly kind: 'host-transfer-recovery';
  readonly direction: HostTransferRecoveryDirection;
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly sourceHostMemberId: CollabMemberId;
  readonly targetHostMemberId: CollabMemberId;
  readonly phase: HostTransferRecoveryPhase;
  readonly targetEndpoint: string | null;
  readonly targetCaCertificatePem: string | null;
  readonly targetCaFingerprint: string | null;
  readonly receiverCredential: string | null;
  readonly receiverCredentialHash: string | null;
  readonly targetTerminalResponseReceived: boolean;
  readonly stagingDirectoryName: string | null;
  readonly manifestDigest: string | null;
  readonly activationCertificate: string | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly updatedAt: CollabIsoTimestamp;
}
type Value = Readonly<Record<string, unknown>>;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PHASES: readonly HostTransferRecoveryPhase[] = ['offered', 'accepted', 'quiescing', 'staged', 'authority-relinquished', 'target-active', 'completed', 'cancelled', 'declined', 'expired'];
const KEYS = new Set(['schemaVersion', 'kind', 'direction', 'projectId', 'transferId', 'sourceHostMemberId', 'targetHostMemberId', 'phase', 'targetEndpoint', 'targetCaCertificatePem', 'targetCaFingerprint', 'receiverCredential', 'receiverCredentialHash', 'targetTerminalResponseReceived', 'stagingDirectoryName', 'manifestDigest', 'activationCertificate', 'createdAt', 'updatedAt']);
function text(value: Value, key: string, max: number, pattern?: RegExp): string {
  const field = value[key];
  if (typeof field !== 'string' || !field || field.length > max || (pattern && !pattern.test(field))) throw new TypeError(`Invalid ${key}`);
  return field;
}
function nullable(value: Value, key: string, max: number, pattern?: RegExp): string | null {
  return value[key] === null ? null : text(value, key, max, pattern);
}
function time(value: Value, key: string): string {
  const field = text(value, key, 64);
  if (!Number.isFinite(Date.parse(field)) || new Date(field).toISOString() !== field) throw new TypeError(`Invalid ${key}`);
  return field;
}
function endpoint(value: Value): string | null {
  const field = nullable(value, 'targetEndpoint', 2_048);
  if (field === null) return null;
  try {
    const parsed = new URL(field);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
  } catch { throw new TypeError('Invalid targetEndpoint'); }
  return field;
}
export function decodeHostTransferRecoveryRecord(value: unknown): HostTransferRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Host transfer recovery');
  const record = value as Value;
  if (Object.keys(record).length !== KEYS.size || Object.keys(record).some(key => !KEYS.has(key)) || record.schemaVersion !== 1 || record.kind !== 'host-transfer-recovery') throw new TypeError('Invalid Host transfer recovery');
  const direction = record.direction;
  const phase = record.phase;
  if ((direction !== 'incoming' && direction !== 'outgoing') || typeof phase !== 'string' || !PHASES.includes(phase as HostTransferRecoveryPhase)) throw new TypeError('Invalid Host transfer state');
  const transferId = text(record, 'transferId', 128);
  if (!isCollabOpaqueId(transferId)) throw new TypeError('Invalid transferId');
  const targetEndpoint = endpoint(record);
  const targetCaCertificatePem = nullable(record, 'targetCaCertificatePem', 64 * 1024);
  const targetCaFingerprint = nullable(record, 'targetCaFingerprint', 64, DIGEST);
  const receiverCredential = nullable(record, 'receiverCredential', 43, CREDENTIAL);
  const receiverCredentialHash = nullable(record, 'receiverCredentialHash', 64, DIGEST);
  const targetTerminalResponseReceived = record.targetTerminalResponseReceived;
  if (typeof targetTerminalResponseReceived !== 'boolean') {
    throw new TypeError('Invalid target terminal response state');
  }
  const stagingDirectoryName = nullable(record, 'stagingDirectoryName', 160, /^\.claudian-host-transfer-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  const manifestDigest = nullable(record, 'manifestDigest', 64, DIGEST);
  const activationCertificate = nullable(record, 'activationCertificate', 64 * 1024);
  const terminalBeforeCutover = phase === 'cancelled' || phase === 'declined' || phase === 'expired';
  const accepted = !terminalBeforeCutover && phase !== 'offered';
  const retainedIncomingProvisional = direction === 'incoming' && terminalBeforeCutover;
  // Outgoing terminal records retain the credential until the target's
  // terminal response has been checkpointed and explicitly confirmed.
  const outgoingTerminalCleanup = direction === 'outgoing' && terminalBeforeCutover;
  const incomingTerminalReceipt = direction === 'incoming'
    && (terminalBeforeCutover || phase === 'completed')
    && receiverCredentialHash !== null;
  const targetDetails = targetEndpoint !== null
    && targetCaCertificatePem !== null
    && targetCaFingerprint !== null;
  const anyTargetDetails = targetEndpoint !== null
    || targetCaCertificatePem !== null
    || targetCaFingerprint !== null;
  const receiverRequired = (accepted || retainedIncomingProvisional) && !incomingTerminalReceipt;
  const staged = phase === 'staged' || phase === 'authority-relinquished' || phase === 'target-active' || phase === 'completed';
  const relinquished = phase === 'authority-relinquished' || phase === 'target-active' || phase === 'completed';
  if (
    (anyTargetDetails && !targetDetails)
    || ((accepted || retainedIncomingProvisional || outgoingTerminalCleanup) && !targetDetails)
    || (phase === 'offered' && (targetDetails || receiverCredential !== null))
    || (receiverCredential !== null && receiverCredentialHash !== null)
    || (receiverRequired && receiverCredential === null)
    || (!receiverRequired && !outgoingTerminalCleanup && receiverCredential !== null)
    || (direction === 'incoming'
      && (accepted || retainedIncomingProvisional)
      && !incomingTerminalReceipt
      && stagingDirectoryName !== `.claudian-host-transfer-${transferId}`)
    || (direction === 'incoming'
      && incomingTerminalReceipt
      && stagingDirectoryName !== null
      && stagingDirectoryName !== `.claudian-host-transfer-${transferId}`)
    || (!incomingTerminalReceipt && receiverCredentialHash !== null)
    || (direction === 'outgoing' && stagingDirectoryName !== null)
    || (direction === 'incoming' && targetTerminalResponseReceived)
    || (direction === 'incoming' && incomingTerminalReceipt
      && phase !== 'completed' && !terminalBeforeCutover)
    || (direction === 'outgoing'
      && targetTerminalResponseReceived
      && !terminalBeforeCutover
      && phase !== 'completed')
    || (direction === 'outgoing' && receiverCredential === null)
    || (direction === 'outgoing' && targetTerminalResponseReceived && receiverCredential === null)
    || (staged !== (manifestDigest !== null))
    || (relinquished !== (activationCertificate !== null))
    || (targetCaCertificatePem !== null && (!targetCaCertificatePem.includes('-----BEGIN CERTIFICATE-----') || !targetCaCertificatePem.includes('-----END CERTIFICATE-----') || targetCaCertificatePem.includes('PRIVATE KEY')))
  ) throw new TypeError('Impossible Host transfer phase');
  const createdAt = time(record, 'createdAt');
  const updatedAt = time(record, 'updatedAt');
  if (updatedAt < createdAt) throw new TypeError('Invalid Host transfer timestamps');
  const projectId = text(record, 'projectId', 64);
  const sourceHostMemberId = text(record, 'sourceHostMemberId', 64);
  const targetHostMemberId = text(record, 'targetHostMemberId', 64);
  if (
    !isCollabProjectId(projectId)
    || !isCollabMemberId(sourceHostMemberId)
    || !isCollabMemberId(targetHostMemberId)
  ) {
    throw new TypeError('Invalid Host transfer identity');
  }
  return {
    activationCertificate,
    createdAt,
    direction,
    kind: 'host-transfer-recovery',
    manifestDigest,
    phase: phase as HostTransferRecoveryPhase,
    projectId,
    receiverCredential,
    receiverCredentialHash,
    schemaVersion: 1,
    sourceHostMemberId,
    stagingDirectoryName,
    targetCaCertificatePem,
    targetCaFingerprint,
    targetEndpoint,
    targetHostMemberId,
    targetTerminalResponseReceived,
    transferId,
    updatedAt,
  };
}
