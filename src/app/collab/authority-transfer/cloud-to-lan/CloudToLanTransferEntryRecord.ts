import {
  type BeginCloudToLanTransferRequest,
  type CancelProjectAuthorityTransferRequest,
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferStatus,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { AuthorityTransferEntrySuccessor } from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  assertAuthorityTransferStatusObservation,
} from '@/app/collab/authority-transfer/AuthorityTransferObservedStatus';
import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type {
  CollabCloudToLanTargetPreparationDescriptor,
  CollabCloudToLanTransferHandle,
} from '@/core/collab/CollabFeaturePort';
import {
  type InstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

export const CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION = 1 as const;

export type CloudToLanTargetPreparationDescriptor =
  CollabCloudToLanTargetPreparationDescriptor;

export type CloudToLanTransferHandle = CollabCloudToLanTransferHandle;

export interface CloudToLanTargetEntryRecord {
  readonly createdAt: CollabIsoTimestamp;
  readonly descriptor: CloudToLanTargetPreparationDescriptor | null;
  readonly entryRole: 'cloud-to-lan-target';
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationIntentId: string;
  readonly ownerInstallationKey: InstallationKey;
  readonly phase: 'handed-off' | 'preparing' | 'published' | 'withdrawn';
  readonly projectId: CollabProjectId;
  readonly selectedTargetMemberId: CollabMemberId;
  readonly selectedTargetPersonalRef: string;
  readonly sourceAuthorityGeneration: number;
  readonly sourceCloudUrl: string;
  readonly successor: AuthorityTransferEntrySuccessor | null;
  readonly withdrawnAt: CollabIsoTimestamp | null;
}

export interface CloudToLanManagerEntryRecord {
  readonly cancellation: Readonly<{
    readonly request: CancelProjectAuthorityTransferRequest;
    readonly submission: 'not-sent' | 'possibly-sent';
  }> | null;
  readonly createdAt: CollabIsoTimestamp;
  readonly descriptor: CloudToLanTargetPreparationDescriptor;
  readonly entryRole: 'cloud-to-lan-manager';
  readonly expiresAt: CollabIsoTimestamp;
  readonly initiatingMemberId: CollabMemberId;
  readonly initiatingPersonalRef: string;
  readonly operationIntentId: string;
  readonly phase: 'observing' | 'prepared' | 'rejected' | 'settled' | 'submitted';
  readonly projectId: CollabProjectId;
  readonly request: BeginCloudToLanTransferRequest;
  readonly status: CollabAuthorityTransferStatus | null;
}

type UnknownRecord = Record<string, unknown>;

const TARGET_KEYS = new Set([
  'createdAt',
  'descriptor',
  'entryRole',
  'expiresAt',
  'operationIntentId',
  'ownerInstallationKey',
  'phase',
  'projectId',
  'selectedTargetMemberId',
  'selectedTargetPersonalRef',
  'sourceAuthorityGeneration',
  'sourceCloudUrl',
  'successor',
  'withdrawnAt',
]);
const MANAGER_KEYS = new Set([
  'cancellation',
  'createdAt',
  'descriptor',
  'entryRole',
  'expiresAt',
  'initiatingMemberId',
  'initiatingPersonalRef',
  'operationIntentId',
  'phase',
  'projectId',
  'request',
  'status',
]);
const DESCRIPTOR_KEYS = new Set([
  'caCertificatePem',
  'caFingerprint',
  'preparationId',
  'projectId',
  'publishedAt',
  'schemaVersion',
  'selectedTargetMemberId',
  'sourceAuthorityGeneration',
  'sourceCloudUrl',
  'targetUrl',
]);
const SUCCESSOR_KEYS = new Set([
  'operationIntentId',
  'ownerInstallationKey',
  'transferId',
]);
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function timestamp(value: unknown): CollabIsoTimestamp {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError('Invalid Cloud-to-LAN entry timestamp');
  return value;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Invalid Cloud-to-LAN authority generation');
  }
  return value as number;
}

function cloudUrl(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > 4096
  ) throw new TypeError('Invalid Cloud-to-LAN source URL');
  try {
    return validateCloudServerUrl(value, 'Cloud-to-LAN source URL');
  } catch {
    throw new TypeError('Invalid Cloud-to-LAN source URL');
  }
}

function lanUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid Cloud-to-LAN target URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Invalid Cloud-to-LAN target URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== value
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port === ''
  ) throw new TypeError('Invalid Cloud-to-LAN target URL');
  return value;
}

function successor(value: unknown): AuthorityTransferEntrySuccessor | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, SUCCESSOR_KEYS)) {
    throw new TypeError('Invalid Cloud-to-LAN entry successor');
  }
  if (
    typeof value.operationIntentId !== 'string'
    || !isCollabOpaqueId(value.operationIntentId)
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
    || typeof value.ownerInstallationKey !== 'string'
  ) throw new TypeError('Invalid Cloud-to-LAN entry successor');
  return {
    operationIntentId: value.operationIntentId,
    ownerInstallationKey: parseInstallationKey(value.ownerInstallationKey),
    transferId: value.transferId,
  };
}

export function decodeCloudToLanTargetPreparationDescriptor(
  value: unknown,
): CloudToLanTargetPreparationDescriptor {
  if (
    !isRecord(value)
    || !hasExactKeys(value, DESCRIPTOR_KEYS)
    || value.schemaVersion !== CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION
    || !isCollabProjectId(value.projectId)
    || !isCollabMemberId(value.selectedTargetMemberId)
    || typeof value.preparationId !== 'string'
    || !isCollabOpaqueId(value.preparationId)
    || typeof value.caCertificatePem !== 'string'
    || value.caCertificatePem.length > 64 * 1024
    || !value.caCertificatePem.startsWith('-----BEGIN CERTIFICATE-----\n')
    || (
      !value.caCertificatePem.endsWith('\n-----END CERTIFICATE-----')
      && !value.caCertificatePem.endsWith('\n-----END CERTIFICATE-----\n')
    )
    || typeof value.caFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.caFingerprint)
  ) throw new TypeError('Invalid Cloud-to-LAN target descriptor');
  return Object.freeze({
    caCertificatePem: value.caCertificatePem,
    caFingerprint: value.caFingerprint,
    preparationId: value.preparationId,
    projectId: value.projectId,
    publishedAt: timestamp(value.publishedAt),
    schemaVersion: CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION,
    selectedTargetMemberId: value.selectedTargetMemberId,
    sourceAuthorityGeneration: generation(value.sourceAuthorityGeneration),
    sourceCloudUrl: cloudUrl(value.sourceCloudUrl),
    targetUrl: lanUrl(value.targetUrl),
  });
}

export function decodeCloudToLanTransferHandle(value: unknown): CloudToLanTransferHandle {
  if (!isRecord(value)) throw new TypeError('Invalid Cloud-to-LAN transfer handle');
  const keys = new Set([
    'operationIntentId',
    'preparationId',
    'projectId',
    'schemaVersion',
    'selectedTargetMemberId',
    'sourceAuthorityGeneration',
    'sourceCloudUrl',
    'targetUrl',
    'transferId',
  ]);
  if (
    !hasExactKeys(value, keys)
    || value.schemaVersion !== CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION
    || !isCollabProjectId(value.projectId)
    || !isCollabMemberId(value.selectedTargetMemberId)
    || typeof value.operationIntentId !== 'string'
    || !isCollabOpaqueId(value.operationIntentId)
    || typeof value.preparationId !== 'string'
    || !isCollabOpaqueId(value.preparationId)
    || typeof value.transferId !== 'string'
    || !isCollabOpaqueId(value.transferId)
  ) throw new TypeError('Invalid Cloud-to-LAN transfer handle');
  return Object.freeze({
    operationIntentId: value.operationIntentId,
    preparationId: value.preparationId,
    projectId: value.projectId,
    schemaVersion: CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION,
    selectedTargetMemberId: value.selectedTargetMemberId,
    sourceAuthorityGeneration: generation(value.sourceAuthorityGeneration),
    sourceCloudUrl: cloudUrl(value.sourceCloudUrl),
    targetUrl: lanUrl(value.targetUrl),
    transferId: value.transferId,
  });
}

export function assertCloudToLanTargetHandle(
  entry: CloudToLanTargetEntryRecord,
  handle: CloudToLanTransferHandle,
): void {
  if (
    (entry.phase !== 'published' && entry.phase !== 'handed-off')
    || !entry.descriptor
    || entry.operationIntentId !== handle.preparationId
    || entry.projectId !== handle.projectId
    || entry.selectedTargetMemberId !== handle.selectedTargetMemberId
    || entry.sourceAuthorityGeneration !== handle.sourceAuthorityGeneration
    || entry.sourceCloudUrl !== handle.sourceCloudUrl
    || entry.descriptor.targetUrl !== handle.targetUrl
    || (
      entry.successor !== null
      && (
        entry.successor.operationIntentId !== handle.operationIntentId
        || entry.successor.transferId !== handle.transferId
      )
    )
  ) throw new TypeError('Cloud-to-LAN target handle mismatch');
}

export function decodeCloudToLanTargetEntryRecord(
  value: unknown,
): CloudToLanTargetEntryRecord {
  if (
    !isRecord(value)
    || !hasExactKeys(value, TARGET_KEYS)
    || value.entryRole !== 'cloud-to-lan-target'
    || !isCollabProjectId(value.projectId)
    || !isCollabMemberId(value.selectedTargetMemberId)
    || typeof value.operationIntentId !== 'string'
    || !isCollabOpaqueId(value.operationIntentId)
    || typeof value.ownerInstallationKey !== 'string'
    || typeof value.selectedTargetPersonalRef !== 'string'
    || (
      value.phase !== 'preparing'
      && value.phase !== 'published'
      && value.phase !== 'handed-off'
      && value.phase !== 'withdrawn'
    )
  ) throw new TypeError('Invalid Cloud-to-LAN target entry');
  const createdAt = timestamp(value.createdAt);
  const expiresAt = timestamp(value.expiresAt);
  const decodedDescriptor = value.descriptor === null
    ? null
    : decodeCloudToLanTargetPreparationDescriptor(value.descriptor);
  const decodedSuccessor = successor(value.successor);
  const withdrawnAt = value.withdrawnAt === null ? null : timestamp(value.withdrawnAt);
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt)
    || (value.phase === 'preparing' && decodedDescriptor !== null)
    || (
      (value.phase === 'published' || value.phase === 'handed-off')
      && decodedDescriptor === null
    )
    || (value.phase === 'handed-off') !== (decodedSuccessor !== null)
    || (value.phase === 'withdrawn') !== (withdrawnAt !== null)
    || (withdrawnAt !== null && withdrawnAt < createdAt)
    || (decodedDescriptor !== null && (
      decodedDescriptor.preparationId !== value.operationIntentId
      || decodedDescriptor.projectId !== value.projectId
      || decodedDescriptor.publishedAt < createdAt
      || decodedDescriptor.selectedTargetMemberId !== value.selectedTargetMemberId
      || decodedDescriptor.sourceAuthorityGeneration !== value.sourceAuthorityGeneration
      || decodedDescriptor.sourceCloudUrl !== value.sourceCloudUrl
    ))
  ) throw new TypeError('Invalid Cloud-to-LAN target entry binding');
  return {
    createdAt,
    descriptor: decodedDescriptor,
    entryRole: 'cloud-to-lan-target',
    expiresAt,
    operationIntentId: value.operationIntentId,
    ownerInstallationKey: parseInstallationKey(value.ownerInstallationKey),
    phase: value.phase,
    projectId: value.projectId,
    selectedTargetMemberId: value.selectedTargetMemberId,
    selectedTargetPersonalRef: value.selectedTargetPersonalRef,
    sourceAuthorityGeneration: generation(value.sourceAuthorityGeneration),
    sourceCloudUrl: cloudUrl(value.sourceCloudUrl),
    successor: decodedSuccessor,
    withdrawnAt,
  };
}

export function decodeCloudToLanManagerEntryRecord(
  value: unknown,
): CloudToLanManagerEntryRecord {
  if (
    !isRecord(value)
    || !hasExactKeys(value, MANAGER_KEYS)
    || value.entryRole !== 'cloud-to-lan-manager'
    || !isCollabProjectId(value.projectId)
    || !isCollabMemberId(value.initiatingMemberId)
    || typeof value.initiatingPersonalRef !== 'string'
    || typeof value.operationIntentId !== 'string'
    || !isCollabOpaqueId(value.operationIntentId)
    || (
      value.phase !== 'prepared'
      && value.phase !== 'submitted'
      && value.phase !== 'observing'
      && value.phase !== 'rejected'
      && value.phase !== 'settled'
    )
  ) throw new TypeError('Invalid Cloud-to-LAN Manager entry');
  const descriptor = decodeCloudToLanTargetPreparationDescriptor(value.descriptor);
  const request = decodeCollabAuthorityTransferOperationRequest(
    'beginCloudToLanTransfer',
    value.request,
  );
  const status = value.status === null ? null : decodeCollabAuthorityTransferStatus(value.status);
  const cancellation = value.cancellation === null
    ? null
    : (() => {
        if (!isRecord(value.cancellation) || !hasExactKeys(
          value.cancellation,
          new Set(['request', 'submission']),
        )) throw new TypeError('Invalid Cloud-to-LAN Manager cancellation');
        const cancellationRequest = decodeCollabAuthorityTransferOperationRequest(
          'cancelProjectAuthorityTransfer',
          value.cancellation.request,
        );
        if (
          value.cancellation.submission !== 'not-sent'
          && value.cancellation.submission !== 'possibly-sent'
        ) throw new TypeError('Invalid Cloud-to-LAN Manager cancellation');
        return {
          request: cancellationRequest,
          submission: value.cancellation.submission,
        } as const;
      })();
  const createdAt = timestamp(value.createdAt);
  const expiresAt = timestamp(value.expiresAt);
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt)
    || request.projectId !== value.projectId
    || request.idempotencyKey !== value.operationIntentId
    || request.expectedAuthorityGeneration !== descriptor.sourceAuthorityGeneration
    || request.targetHostMemberId !== descriptor.selectedTargetMemberId
    || request.targetUrl !== descriptor.targetUrl
    || descriptor.projectId !== value.projectId
    || ((value.phase === 'observing' || value.phase === 'settled') !== (status !== null))
    || (value.phase === 'rejected' && (status !== null || cancellation !== null))
    || (value.phase === 'observing' && status?.state !== 'active')
    || (
      value.phase === 'settled'
      && status?.state !== 'completed'
      && status?.state !== 'cancelled'
    )
    || (status !== null && (
      status.direction !== 'cloud-to-lan'
      || status.projectId !== value.projectId
      || status.sourceAuthority.kind !== 'cloud'
      || status.sourceAuthority.generation !== request.expectedAuthorityGeneration
      || status.targetAuthority.kind !== 'lan'
      || status.targetAuthority.generation !== request.expectedAuthorityGeneration + 1
      || status.targetUrl !== request.targetUrl
      || status.expiresAt !== expiresAt
    ))
    || (cancellation !== null && (
      status === null
      || status.state !== 'active'
      || status.relinquishmentProof !== null
      || cancellation.request.projectId !== value.projectId
      || cancellation.request.transferId !== status.transferId
      || cancellation.request.expectedPhase !== status.phase
    ))
  ) throw new TypeError('Invalid Cloud-to-LAN Manager entry binding');
  return {
    cancellation,
    createdAt,
    descriptor,
    entryRole: 'cloud-to-lan-manager',
    expiresAt,
    initiatingMemberId: value.initiatingMemberId,
    initiatingPersonalRef: value.initiatingPersonalRef,
    operationIntentId: value.operationIntentId,
    phase: value.phase,
    projectId: value.projectId,
    request,
    status,
  };
}

export function createCloudToLanTargetEntry(input: Readonly<{
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly operationIntentId: string;
  readonly ownerInstallationKey: InstallationKey;
  readonly projectId: CollabProjectId;
  readonly selectedTargetMemberId: CollabMemberId;
  readonly selectedTargetPersonalRef: string;
  readonly sourceAuthorityGeneration: number;
  readonly sourceCloudUrl: string;
}>): CloudToLanTargetEntryRecord {
  return decodeCloudToLanTargetEntryRecord({
    ...input,
    descriptor: null,
    entryRole: 'cloud-to-lan-target',
    phase: 'preparing',
    successor: null,
    withdrawnAt: null,
  });
}

export function publishCloudToLanTargetEntry(
  entry: CloudToLanTargetEntryRecord,
  input: Readonly<{
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly publishedAt: CollabIsoTimestamp;
    readonly targetUrl: string;
  }>,
): CloudToLanTargetEntryRecord {
  if (entry.phase !== 'preparing') throw new TypeError('Cloud-to-LAN target is already published');
  return decodeCloudToLanTargetEntryRecord({
    ...entry,
    descriptor: {
      ...input,
      preparationId: entry.operationIntentId,
      projectId: entry.projectId,
      schemaVersion: CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION,
      selectedTargetMemberId: entry.selectedTargetMemberId,
      sourceAuthorityGeneration: entry.sourceAuthorityGeneration,
      sourceCloudUrl: entry.sourceCloudUrl,
    },
    phase: 'published',
  });
}

export function handoffCloudToLanTargetEntry(
  entry: CloudToLanTargetEntryRecord,
  record: AuthorityTransferRecord,
): CloudToLanTargetEntryRecord {
  if (
    (entry.phase !== 'published' && entry.phase !== 'handed-off')
    || !entry.descriptor
    || record.localRole !== 'target'
    || record.lifecycleOwnership !== 'owned'
    || record.ownerInstallationKey !== entry.ownerInstallationKey
    || record.projectId !== entry.projectId
    || record.status.direction !== 'cloud-to-lan'
    || record.status.sourceAuthority.kind !== 'cloud'
    || record.status.sourceAuthority.generation !== entry.sourceAuthorityGeneration
    || record.status.targetAuthority.kind !== 'lan'
    || record.status.targetAuthority.generation !== entry.sourceAuthorityGeneration + 1
    || record.status.targetUrl !== entry.descriptor.targetUrl
  ) throw new TypeError('Invalid Cloud-to-LAN target handoff');
  const handedOff = decodeCloudToLanTargetEntryRecord({
    ...entry,
    phase: 'handed-off',
    successor: {
      operationIntentId: record.operationIntentId,
      ownerInstallationKey: record.ownerInstallationKey,
      transferId: record.transferId,
    },
  });
  if (
    entry.phase === 'handed-off'
    && JSON.stringify(entry) !== JSON.stringify(handedOff)
  ) throw new TypeError('Invalid Cloud-to-LAN target handoff');
  return handedOff;
}

export function withdrawCloudToLanTargetEntry(
  entry: CloudToLanTargetEntryRecord,
  withdrawnAt: CollabIsoTimestamp,
): CloudToLanTargetEntryRecord {
  if (
    (entry.phase !== 'preparing' && entry.phase !== 'published')
    || entry.successor !== null
  ) throw new TypeError('Cloud-to-LAN target is not withdrawable');
  return decodeCloudToLanTargetEntryRecord({
    ...entry,
    phase: 'withdrawn',
    withdrawnAt,
  });
}

export function createCloudToLanManagerEntry(input: Readonly<{
  readonly createdAt: CollabIsoTimestamp;
  readonly descriptor: CloudToLanTargetPreparationDescriptor;
  readonly expiresAt: CollabIsoTimestamp;
  readonly initiatingMemberId: CollabMemberId;
  readonly initiatingPersonalRef: string;
  readonly operationIntentId: string;
}>): CloudToLanManagerEntryRecord {
  return decodeCloudToLanManagerEntryRecord({
    cancellation: null,
    createdAt: input.createdAt,
    descriptor: input.descriptor,
    entryRole: 'cloud-to-lan-manager',
    expiresAt: input.expiresAt,
    initiatingMemberId: input.initiatingMemberId,
    initiatingPersonalRef: input.initiatingPersonalRef,
    operationIntentId: input.operationIntentId,
    phase: 'prepared',
    projectId: input.descriptor.projectId,
    request: {
      expectedAuthorityGeneration: input.descriptor.sourceAuthorityGeneration,
      idempotencyKey: input.operationIntentId,
      projectId: input.descriptor.projectId,
      targetHostMemberId: input.descriptor.selectedTargetMemberId,
      targetUrl: input.descriptor.targetUrl,
    },
    status: null,
  });
}

export function markCloudToLanManagerBeginPossiblySent(
  entry: CloudToLanManagerEntryRecord,
): CloudToLanManagerEntryRecord {
  if (entry.phase !== 'prepared' && entry.phase !== 'submitted') {
    throw new TypeError('Cloud-to-LAN Manager begin is not submittable');
  }
  if (entry.phase === 'submitted') return entry;
  return decodeCloudToLanManagerEntryRecord({
    ...entry,
    phase: 'submitted',
  });
}

export function recordCloudToLanManagerStatus(
  entry: CloudToLanManagerEntryRecord,
  status: CollabAuthorityTransferStatus,
): CloudToLanManagerEntryRecord {
  if (entry.phase !== 'submitted' && entry.phase !== 'observing') {
    throw new TypeError('Cloud-to-LAN Manager status is not recordable');
  }
  if (entry.status) {
    assertAuthorityTransferStatusObservation(entry.status, status);
  }
  return decodeCloudToLanManagerEntryRecord({
    ...entry,
    cancellation: null,
    expiresAt: status.expiresAt,
    phase: status.state === 'completed' || status.state === 'cancelled'
      ? 'settled'
      : 'observing',
    status,
  });
}

export function rejectCloudToLanManagerEntry(
  entry: CloudToLanManagerEntryRecord,
): CloudToLanManagerEntryRecord {
  if (entry.phase !== 'submitted' || entry.status !== null) {
    throw new TypeError('Cloud-to-LAN Manager begin is not rejectable');
  }
  return decodeCloudToLanManagerEntryRecord({
    ...entry,
    cancellation: null,
    phase: 'rejected',
  });
}

export function prepareCloudToLanManagerCancellation(
  entry: CloudToLanManagerEntryRecord,
  request: CancelProjectAuthorityTransferRequest,
): CloudToLanManagerEntryRecord {
  if (
    entry.phase !== 'observing'
    || !entry.status
    || entry.status.state !== 'active'
    || entry.status.relinquishmentProof !== null
    || entry.cancellation !== null
  ) throw new TypeError('Cloud-to-LAN Manager cancellation is not preparable');
  return decodeCloudToLanManagerEntryRecord({
    ...entry,
    cancellation: { request, submission: 'not-sent' },
  });
}

export function markCloudToLanManagerCancellationPossiblySent(
  entry: CloudToLanManagerEntryRecord,
): CloudToLanManagerEntryRecord {
  if (!entry.cancellation) {
    throw new TypeError('Cloud-to-LAN Manager cancellation is missing');
  }
  if (entry.cancellation.submission === 'possibly-sent') return entry;
  return decodeCloudToLanManagerEntryRecord({
    ...entry,
    cancellation: { ...entry.cancellation, submission: 'possibly-sent' },
  });
}

export function cloudToLanTransferHandle(
  entry: CloudToLanManagerEntryRecord,
): CloudToLanTransferHandle {
  if (!entry.status) throw new TypeError('Cloud-to-LAN Manager status is missing');
  return decodeCloudToLanTransferHandle({
    operationIntentId: entry.operationIntentId,
    preparationId: entry.descriptor.preparationId,
    projectId: entry.projectId,
    schemaVersion: CLOUD_TO_LAN_ENTRY_SCHEMA_VERSION,
    selectedTargetMemberId: entry.descriptor.selectedTargetMemberId,
    sourceAuthorityGeneration: entry.descriptor.sourceAuthorityGeneration,
    sourceCloudUrl: entry.descriptor.sourceCloudUrl,
    targetUrl: entry.descriptor.targetUrl,
    transferId: entry.status.transferId,
  });
}
