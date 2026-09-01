import {
  type CancelProjectAuthorityTransferRequest,
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferStatus,
  isCollabMemberId,
  type RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type CloudToLanManagerEntryRecord,
  type CloudToLanTargetEntryRecord,
  decodeCloudToLanManagerEntryRecord,
  decodeCloudToLanTargetEntryRecord,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import {
  type InstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

export const AUTHORITY_TRANSFER_ENTRY_SCHEMA_VERSION = 1 as const;
export const AUTHORITY_TRANSFER_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface AuthorityTransferEntrySuccessor {
  readonly operationIntentId: string;
  readonly ownerInstallationKey: InstallationKey;
  readonly transferId: string;
}

export type AuthorityTransferSourceCancellationIntent = Readonly<
  CancelProjectAuthorityTransferRequest & {
    readonly expectedAuthorityGeneration: number;
  }
>;

export interface AuthorityTransferSourceCancellation
  extends AuthorityTransferSourceCancellationIntent {
  readonly submission: 'not-sent' | 'possibly-sent';
}

interface AuthorityTransferEntryBase {
  readonly expiresAt: CollabIsoTimestamp;
  readonly projectId: CollabProjectId;
  readonly proposedAt: CollabIsoTimestamp;
  readonly proposedByMemberId: CollabMemberId;
  readonly request: RequestLanToCloudTransferRequest;
}

export interface AuthorityTransferRequesterEntryRecord extends AuthorityTransferEntryBase {
  readonly entryRole: 'requester';
  readonly phase: 'proposed' | 'submitted';
  readonly requesterInstallationKey: InstallationKey;
  readonly status: CollabAuthorityTransferStatus | null;
  readonly successor: null;
}

export interface AuthorityTransferSourceEntryRecord extends AuthorityTransferEntryBase {
  readonly beginSubmission: 'cloud-absent' | 'not-sent' | 'possibly-sent';
  readonly cancellation: AuthorityTransferSourceCancellation | null;
  readonly entryRole: 'source';
  readonly ownerInstallationKey: InstallationKey;
  readonly phase: 'cancelled' | 'handed-off' | 'proposed';
  readonly status: CollabAuthorityTransferStatus;
  readonly successor: AuthorityTransferEntrySuccessor | null;
}

export type AuthorityTransferEntryComponent =
  | CloudToLanManagerEntryRecord
  | AuthorityTransferRequesterEntryRecord
  | AuthorityTransferSourceEntryRecord
  | CloudToLanTargetEntryRecord;

export interface AuthorityTransferEntryRecord {
  readonly kind: 'authority-transfer-entry';
  readonly manager: CloudToLanManagerEntryRecord | null;
  readonly projectId: CollabProjectId;
  readonly requesters: Readonly<Record<string, AuthorityTransferRequesterEntryRecord>>;
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_ENTRY_SCHEMA_VERSION;
  readonly source: AuthorityTransferSourceEntryRecord | null;
  readonly target: CloudToLanTargetEntryRecord | null;
}

const DOCUMENT_KEYS = new Set([
  'kind',
  'manager',
  'projectId',
  'requesters',
  'schemaVersion',
  'source',
  'target',
]);
const COMPONENT_KEYS = [
  'expiresAt',
  'entryRole',
  'phase',
  'projectId',
  'proposedAt',
  'proposedByMemberId',
  'request',
  'status',
  'successor',
] as const;
const REQUESTER_KEYS = new Set([...COMPONENT_KEYS, 'requesterInstallationKey']);
const SOURCE_KEYS = new Set([
  ...COMPONENT_KEYS,
  'beginSubmission',
  'cancellation',
  'ownerInstallationKey',
]);
const SUCCESSOR_KEYS = new Set([
  'operationIntentId',
  'ownerInstallationKey',
  'transferId',
]);
const CANCELLATION_KEYS = new Set([
  'expectedAuthorityGeneration',
  'expectedPhase',
  'idempotencyKey',
  'projectId',
  'submission',
  'transferId',
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function decodeTimestamp(value: unknown): CollabIsoTimestamp {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError('Invalid authority transfer entry timestamp');
  return value;
}

export function authorityTransferEntryExpiresAt(
  proposedAt: CollabIsoTimestamp,
): CollabIsoTimestamp {
  return new Date(
    Date.parse(proposedAt) + AUTHORITY_TRANSFER_ENTRY_RETENTION_MS,
  ).toISOString();
}

function decodeSuccessor(value: unknown): AuthorityTransferEntrySuccessor | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, SUCCESSOR_KEYS)) {
    throw new TypeError('Invalid authority transfer entry successor');
  }
  const { operationIntentId, ownerInstallationKey, transferId } = value;
  if (
    typeof operationIntentId !== 'string'
    || typeof ownerInstallationKey !== 'string'
    || typeof transferId !== 'string'
  ) throw new TypeError('Invalid authority transfer entry successor');
  return {
    operationIntentId,
    ownerInstallationKey: parseInstallationKey(ownerInstallationKey),
    transferId,
  };
}

function decodeCancellation(
  value: unknown,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferSourceCancellation | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, CANCELLATION_KEYS)) {
    throw new TypeError('Invalid authority transfer cancellation intent');
  }
  const request = decodeCollabAuthorityTransferOperationRequest(
    'cancelProjectAuthorityTransfer',
    {
      expectedPhase: value.expectedPhase,
      idempotencyKey: value.idempotencyKey,
      projectId: value.projectId,
      transferId: value.transferId,
    },
  );
  if (
    !Number.isSafeInteger(value.expectedAuthorityGeneration)
    || (value.expectedAuthorityGeneration as number) < 1
    || value.expectedAuthorityGeneration !== status.sourceAuthority.generation
    || request.projectId !== status.projectId
    || request.transferId !== status.transferId
    || (value.submission !== 'not-sent' && value.submission !== 'possibly-sent')
  ) throw new TypeError('Invalid authority transfer cancellation binding');
  return {
    ...request,
    expectedAuthorityGeneration: value.expectedAuthorityGeneration,
    submission: value.submission,
  };
}

function assertStatusBinding(
  request: RequestLanToCloudTransferRequest,
  status: CollabAuthorityTransferStatus,
): void {
  if (
    status.projectId !== request.projectId
    || status.direction !== 'lan-to-cloud'
    || status.sourceAuthority.kind !== 'lan'
    || status.sourceAuthority.generation !== request.expectedAuthorityGeneration
    || status.targetAuthority.kind !== 'cloud'
    || status.targetAuthority.generation !== request.expectedAuthorityGeneration + 1
    || status.targetUrl !== request.targetUrl
  ) throw new TypeError('Invalid authority transfer entry binding');
}

function assertProposalStatus(status: CollabAuthorityTransferStatus): void {
  if (
    status.phase !== 'collecting-readiness'
    || status.state !== 'active'
    || status.batchRevision !== null
    || status.batchSha256 !== null
    || status.checkpointSha256 !== null
    || status.relinquishmentProof !== null
    || status.updatedAt !== status.createdAt
  ) throw new TypeError('Invalid authority transfer entry proposal status');
}

function assertCancelledEntryStatus(status: CollabAuthorityTransferStatus): void {
  if (
    status.phase !== 'cancelled'
    || status.state !== 'cancelled'
    || status.relinquishmentProof !== null
    || status.updatedAt < status.createdAt
    || status.updatedAt >= status.expiresAt
  ) throw new TypeError('Invalid authority transfer entry cancellation status');
}

export function decodeAuthorityTransferEntryComponent(
  value: unknown,
): AuthorityTransferEntryComponent {
  if (isRecord(value) && value.entryRole === 'cloud-to-lan-manager') {
    return decodeCloudToLanManagerEntryRecord(value);
  }
  if (isRecord(value) && value.entryRole === 'cloud-to-lan-target') {
    return decodeCloudToLanTargetEntryRecord(value);
  }
  if (
    !isRecord(value)
    || (value.entryRole !== 'requester' && value.entryRole !== 'source')
    || !hasExactKeys(
      value,
      value.entryRole === 'source' ? SOURCE_KEYS : REQUESTER_KEYS,
    )
    || !isCollabMemberId(value.proposedByMemberId)
  ) throw new TypeError('Invalid authority transfer entry');
  const request = decodeCollabAuthorityTransferOperationRequest(
    'requestLanToCloudTransfer',
    value.request,
  );
  const proposedAt = decodeTimestamp(value.proposedAt);
  const expiresAt = decodeTimestamp(value.expiresAt);
  if (value.projectId !== request.projectId) {
    throw new TypeError('Invalid authority transfer entry Project');
  }
  if (expiresAt !== authorityTransferEntryExpiresAt(proposedAt)) {
    throw new TypeError('Invalid authority transfer entry expiry');
  }
  if (value.entryRole === 'requester') {
    if (typeof value.requesterInstallationKey !== 'string') {
      throw new TypeError('Invalid authority transfer requester installation');
    }
    const requesterInstallationKey = parseInstallationKey(value.requesterInstallationKey);
    const status = value.status === null
      ? null
      : decodeCollabAuthorityTransferStatus(value.status);
    if (
      (value.phase !== 'submitted' && value.phase !== 'proposed')
      || value.successor !== null
      || (value.phase === 'submitted') !== (status === null)
    ) throw new TypeError('Invalid authority transfer requester entry');
    if (status) {
      assertStatusBinding(request, status);
      assertProposalStatus(status);
    }
    return {
      entryRole: 'requester',
      expiresAt,
      phase: value.phase,
      projectId: request.projectId,
      proposedAt,
      proposedByMemberId: value.proposedByMemberId,
      request,
      requesterInstallationKey,
      status,
      successor: null,
    };
  }
  const status = decodeCollabAuthorityTransferStatus(value.status);
  const successor = decodeSuccessor(value.successor);
  const cancellation = decodeCancellation(value.cancellation, status);
  const beginSubmission = value.beginSubmission;
  if (
    beginSubmission !== 'cloud-absent'
    && beginSubmission !== 'not-sent'
    && beginSubmission !== 'possibly-sent'
  ) {
    throw new TypeError('Invalid authority transfer begin submission');
  }
  if (typeof value.ownerInstallationKey !== 'string') {
    throw new TypeError('Invalid authority transfer source owner');
  }
  const ownerInstallationKey = parseInstallationKey(value.ownerInstallationKey);
  assertStatusBinding(request, status);
  if (
    (value.phase !== 'proposed' && value.phase !== 'handed-off' && value.phase !== 'cancelled')
    || status.createdAt !== proposedAt
    || status.expiresAt !== expiresAt
    || (value.phase === 'handed-off') !== (successor !== null)
    || (successor !== null && successor.transferId !== status.transferId)
    || (beginSubmission === 'cloud-absent' && cancellation === null)
    || (value.phase === 'cancelled' && cancellation === null)
  ) throw new TypeError('Invalid authority transfer source entry');
  if (value.phase === 'cancelled') {
    assertCancelledEntryStatus(status);
  } else {
    assertProposalStatus(status);
  }
  return {
    beginSubmission,
    cancellation,
    entryRole: 'source',
    expiresAt,
    ownerInstallationKey,
    phase: value.phase,
    projectId: request.projectId,
    proposedAt: status.createdAt,
    proposedByMemberId: value.proposedByMemberId,
    request,
    status,
    successor,
  };
}

export function decodeAuthorityTransferEntryRecord(
  value: unknown,
): AuthorityTransferEntryRecord {
  if (
    !isRecord(value)
    || !hasExactKeys(value, DOCUMENT_KEYS)
    || value.schemaVersion !== AUTHORITY_TRANSFER_ENTRY_SCHEMA_VERSION
    || value.kind !== 'authority-transfer-entry'
  ) throw new TypeError('Invalid authority transfer entry document');
  if (!isRecord(value.requesters)) {
    throw new TypeError('Invalid authority transfer entry requesters');
  }
  const requesters = Object.fromEntries(Object.entries(value.requesters).map(([key, entry]) => {
    const installationKey = parseInstallationKey(key);
    const decoded = decodeAuthorityTransferEntryComponent(entry);
    if (
      decoded.entryRole !== 'requester'
      || decoded.requesterInstallationKey !== installationKey
    ) throw new TypeError('Invalid authority transfer requester slot');
    return [installationKey, decoded];
  }));
  const source = value.source === null
    ? null
    : decodeAuthorityTransferEntryComponent(value.source);
  const manager = value.manager === null
    ? null
    : decodeAuthorityTransferEntryComponent(value.manager);
  const target = value.target === null
    ? null
    : decodeAuthorityTransferEntryComponent(value.target);
  if (
    (source !== null && source.entryRole !== 'source')
    || (manager !== null && manager.entryRole !== 'cloud-to-lan-manager')
    || (target !== null && target.entryRole !== 'cloud-to-lan-target')
    || (source !== null && (manager !== null || target !== null))
    || (Object.keys(requesters).length === 0
      && source === null
      && manager === null
      && target === null)
    || Object.values(requesters).some(requester => requester.projectId !== value.projectId)
    || (source !== null && source.projectId !== value.projectId)
    || (manager !== null && manager.projectId !== value.projectId)
    || (target !== null && target.projectId !== value.projectId)
  ) throw new TypeError('Invalid authority transfer entry document components');
  return {
    kind: 'authority-transfer-entry',
    manager: manager,
    projectId: (Object.values(requesters)[0] ?? source ?? manager ?? target).projectId,
    requesters: Object.freeze(requesters),
    schemaVersion: AUTHORITY_TRANSFER_ENTRY_SCHEMA_VERSION,
    source,
    target: target,
  };
}

export function createAuthorityTransferEntryDocument(input: Readonly<{
  readonly manager?: CloudToLanManagerEntryRecord | null;
  readonly projectId: CollabProjectId;
  readonly requesters?: Readonly<Record<string, AuthorityTransferRequesterEntryRecord>>;
  readonly source?: AuthorityTransferSourceEntryRecord | null;
  readonly target?: CloudToLanTargetEntryRecord | null;
}>): AuthorityTransferEntryRecord {
  return decodeAuthorityTransferEntryRecord({
    kind: 'authority-transfer-entry',
    manager: input.manager ?? null,
    projectId: input.projectId,
    requesters: input.requesters ?? {},
    schemaVersion: AUTHORITY_TRANSFER_ENTRY_SCHEMA_VERSION,
    source: input.source ?? null,
    target: input.target ?? null,
  });
}

export function createAuthorityTransferEntryRecord(input: Readonly<{
  readonly ownerInstallationKey: InstallationKey;
  readonly proposedByMemberId: CollabMemberId;
  readonly request: RequestLanToCloudTransferRequest;
  readonly status: CollabAuthorityTransferStatus;
}>): AuthorityTransferSourceEntryRecord {
  return decodeAuthorityTransferEntryComponent({
    beginSubmission: 'not-sent',
    cancellation: null,
    entryRole: 'source',
    expiresAt: input.status.expiresAt,
    ownerInstallationKey: input.ownerInstallationKey,
    phase: 'proposed',
    projectId: input.request.projectId,
    proposedAt: input.status.createdAt,
    proposedByMemberId: input.proposedByMemberId,
    request: input.request,
    status: input.status,
    successor: null,
  }) as AuthorityTransferSourceEntryRecord;
}

export function createAuthorityTransferRequesterEntry(input: Readonly<{
  readonly installationKey: InstallationKey;
  readonly proposedAt: CollabIsoTimestamp;
  readonly proposedByMemberId: CollabMemberId;
  readonly request: RequestLanToCloudTransferRequest;
}>): AuthorityTransferRequesterEntryRecord {
  return decodeAuthorityTransferEntryComponent({
    entryRole: 'requester',
    expiresAt: authorityTransferEntryExpiresAt(input.proposedAt),
    phase: 'submitted',
    projectId: input.request.projectId,
    proposedAt: input.proposedAt,
    proposedByMemberId: input.proposedByMemberId,
    request: input.request,
    requesterInstallationKey: input.installationKey,
    status: null,
    successor: null,
  }) as AuthorityTransferRequesterEntryRecord;
}

export function completeAuthorityTransferRequesterEntry(
  entry: AuthorityTransferRequesterEntryRecord,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferRequesterEntryRecord {
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    phase: 'proposed',
    status,
  }) as AuthorityTransferRequesterEntryRecord;
}

export function handoffAuthorityTransferEntry(
  entry: AuthorityTransferSourceEntryRecord,
  record: AuthorityTransferRecord,
): AuthorityTransferSourceEntryRecord {
  if (
    entry.status.transferId !== record.transferId
    || entry.projectId !== record.projectId
    || entry.request.idempotencyKey !== record.operationIntentId
    || (entry.phase === 'proposed'
      && JSON.stringify(entry.status) !== JSON.stringify(record.status))
    || entry.status.direction !== record.status.direction
    || entry.status.sourceAuthority.kind !== record.status.sourceAuthority.kind
    || entry.status.sourceAuthority.generation !== record.status.sourceAuthority.generation
    || entry.status.targetAuthority.kind !== record.status.targetAuthority.kind
    || entry.status.targetAuthority.generation !== record.status.targetAuthority.generation
    || entry.status.targetUrl !== record.status.targetUrl
    || record.localRole !== 'source'
    || record.lifecycleOwnership !== 'owned'
    || record.ownerInstallationKey === undefined
    || entry.ownerInstallationKey !== record.ownerInstallationKey
    || record.sourceLanEndpoint === null
  ) throw new TypeError('Invalid authority transfer entry handoff');
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    phase: 'handed-off',
    successor: {
      operationIntentId: record.operationIntentId,
      ownerInstallationKey: record.ownerInstallationKey,
      transferId: record.transferId,
    },
  }) as AuthorityTransferSourceEntryRecord;
}

export function cancelAuthorityTransferSourceEntry(
  entry: AuthorityTransferSourceEntryRecord,
  request: AuthorityTransferSourceCancellationIntent,
  cancelledAt: CollabIsoTimestamp,
): AuthorityTransferSourceEntryRecord {
  const prepared = prepareAuthorityTransferSourceCancellation(entry, request);
  if (prepared.phase === 'cancelled') return prepared;
  if (prepared.phase !== 'proposed') {
    throw new TypeError('Authority transfer entry is already handed off');
  }
  return decodeAuthorityTransferEntryComponent({
    ...prepared,
    phase: 'cancelled',
    status: {
      ...prepared.status,
      phase: 'cancelled',
      state: 'cancelled',
      updatedAt: cancelledAt,
    },
  }) as AuthorityTransferSourceEntryRecord;
}

export function settleAuthorityTransferSourceCancellation(
  entry: AuthorityTransferSourceEntryRecord,
  record: AuthorityTransferRecord,
): AuthorityTransferSourceEntryRecord {
  if (
    record.localRole !== 'source'
    || record.lifecycleOwnership !== 'owned'
    || record.ownerInstallationKey !== entry.ownerInstallationKey
    || record.transferId !== entry.status.transferId
    || record.operationIntentId !== entry.request.idempotencyKey
    || record.status.state !== 'cancelled'
    || record.status.relinquishmentProof !== null
    || entry.cancellation === null
  ) throw new TypeError('Invalid authority transfer source cancellation settlement');
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    expiresAt: record.status.expiresAt,
    phase: 'cancelled',
    proposedAt: record.status.createdAt,
    status: record.status,
    successor: null,
  }) as AuthorityTransferSourceEntryRecord;
}

export function markAuthorityTransferSourceBeginPossiblySent(
  entry: AuthorityTransferSourceEntryRecord,
): AuthorityTransferSourceEntryRecord {
  if (
    entry.phase !== 'handed-off'
    || entry.beginSubmission === 'cloud-absent'
    || entry.cancellation !== null
  ) {
    throw new TypeError('Authority transfer source is not handed off');
  }
  if (entry.beginSubmission === 'possibly-sent') return entry;
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    beginSubmission: 'possibly-sent',
  }) as AuthorityTransferSourceEntryRecord;
}

export function markAuthorityTransferSourceCloudAbsent(
  entry: AuthorityTransferSourceEntryRecord,
): AuthorityTransferSourceEntryRecord {
  if (
    entry.phase !== 'handed-off'
    || entry.beginSubmission !== 'possibly-sent'
    || entry.cancellation?.submission !== 'possibly-sent'
  ) {
    throw new TypeError('Authority transfer Cloud absence is not provable');
  }
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    beginSubmission: 'cloud-absent',
  }) as AuthorityTransferSourceEntryRecord;
}

export function prepareAuthorityTransferSourceCancellation(
  entry: AuthorityTransferSourceEntryRecord,
  request: AuthorityTransferSourceCancellationIntent,
): AuthorityTransferSourceEntryRecord {
  const existing = entry.cancellation;
  if (existing) {
    if (
      existing.expectedAuthorityGeneration === request.expectedAuthorityGeneration
      && existing.expectedPhase === request.expectedPhase
      && existing.idempotencyKey === request.idempotencyKey
      && existing.projectId === request.projectId
      && existing.transferId === request.transferId
    ) return entry;
    throw new TypeError('Authority transfer cancellation intent conflict');
  }
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    cancellation: {
      ...request,
      submission: 'not-sent',
    },
  }) as AuthorityTransferSourceEntryRecord;
}

export function markAuthorityTransferSourceCancellationPossiblySent(
  entry: AuthorityTransferSourceEntryRecord,
): AuthorityTransferSourceEntryRecord {
  if (!entry.cancellation) {
    throw new TypeError('Authority transfer cancellation intent is missing');
  }
  if (entry.cancellation.submission === 'possibly-sent') return entry;
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    cancellation: {
      ...entry.cancellation,
      submission: 'possibly-sent',
    },
  }) as AuthorityTransferSourceEntryRecord;
}

export function clearAuthorityTransferSourceCancellation(
  entry: AuthorityTransferSourceEntryRecord,
): AuthorityTransferSourceEntryRecord {
  if (entry.phase !== 'handed-off' || entry.cancellation === null) {
    throw new TypeError('Authority transfer cancellation intent is not active');
  }
  return decodeAuthorityTransferEntryComponent({
    ...entry,
    cancellation: null,
  }) as AuthorityTransferSourceEntryRecord;
}
