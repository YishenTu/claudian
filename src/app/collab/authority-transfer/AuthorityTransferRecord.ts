import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  COLLAB_CLOUD_TO_LAN_TRANSFER_PHASES,
  COLLAB_LAN_TO_CLOUD_TRANSFER_PHASES,
  type CollabAuthorityTransferReceiptVerifier,
  type CollabAuthorityTransferStatus,
  type CollabIsoTimestamp,
  type CollabProjectId,
  decodeCollabAuthorityTransferOperationResponse,
  decodeCollabAuthorityTransferStatus,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

export const AUTHORITY_TRANSFER_RECORD_SCHEMA_VERSION = 1 as const;

export type AuthorityTransferLocalRole = 'source' | 'target';
export type AuthorityTransferLifecycleOwnership = 'owned' | 'proposal';
export type AuthorityTransferRestartFence = 'open' | 'permanent' | 'temporary';
export type AuthorityTransferTerminalResponderState = 'active' | 'expired' | 'pending';

export interface AuthorityTransferTerminalResponder {
  readonly expiresAt: CollabIsoTimestamp;
  readonly state: AuthorityTransferTerminalResponderState;
}

export interface AuthorityTransferRecord {
  readonly schemaVersion: typeof AUTHORITY_TRANSFER_RECORD_SCHEMA_VERSION;
  readonly kind: 'authority-transfer';
  readonly lifecycleOwnership: AuthorityTransferLifecycleOwnership;
  readonly localRole: AuthorityTransferLocalRole;
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
  readonly restartFence: AuthorityTransferRestartFence;
  readonly receiptVerifier: CollabAuthorityTransferReceiptVerifier | null;
  readonly sourceLanEndpoint: string | null;
  readonly stagingDirectoryName: string;
  readonly status: CollabAuthorityTransferStatus;
  readonly terminalCleanupCompleted: boolean;
  readonly terminalResponder: AuthorityTransferTerminalResponder | null;
  readonly transferId: string;
}

const RECORD_KEYS = new Set([
  'schemaVersion',
  'kind',
  'lifecycleOwnership',
  'localRole',
  'operationIntentId',
  'projectId',
  'restartFence',
  'receiptVerifier',
  'stagingDirectoryName',
  'sourceLanEndpoint',
  'status',
  'terminalCleanupCompleted',
  'terminalResponder',
  'transferId',
]);
const LEGACY_RECORD_KEY_SETS = [
  new Set([...RECORD_KEYS].filter(key => key !== 'receiptVerifier')),
  new Set([...RECORD_KEYS].filter(key => key !== 'sourceLanEndpoint')),
  new Set([...RECORD_KEYS].filter(
    key => key !== 'receiptVerifier' && key !== 'sourceLanEndpoint',
  )),
];
const TERMINAL_KEYS = new Set(['expiresAt', 'state']);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function decodeSourceLanEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid authority transfer source endpoint');
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('Invalid authority transfer source endpoint');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.origin !== value
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.port === ''
  ) throw new TypeError('Invalid authority transfer source endpoint');
  return endpoint.origin;
}

function expectedRestartFence(
  localRole: AuthorityTransferLocalRole,
  lifecycleOwnership: AuthorityTransferLifecycleOwnership,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferRestartFence {
  if (lifecycleOwnership === 'proposal') return 'open';
  if (status.phase === 'collecting-readiness') return 'temporary';
  if (localRole === 'source') {
    if (status.relinquishmentProof !== null) return 'permanent';
    if (
      status.phase === 'source-reopened'
      || status.phase === 'cancelled'
    ) {
      return 'open';
    }
    return 'temporary';
  }
  if (
    status.phase === 'target-staged'
    || status.phase === 'claims-retained'
    || status.phase === 'cloud-relinquished'
    || status.phase === 'cancel-intent'
    || status.phase === 'target-invalidated'
  ) {
    return 'temporary';
  }
  return 'open';
}

function expectedTerminalResponder(
  localRole: AuthorityTransferLocalRole,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferTerminalResponder | null {
  if (localRole !== 'source' || status.direction !== 'lan-to-cloud') return null;
  if (status.relinquishmentProof !== null) {
    return { expiresAt: status.expiresAt, state: 'active' };
  }
  if (status.phase === 'claims-retained' || status.phase === 'repository-published') {
    return { expiresAt: status.expiresAt, state: 'pending' };
  }
  return null;
}

function decodeTerminalResponder(
  value: unknown,
  localRole: AuthorityTransferLocalRole,
  status: CollabAuthorityTransferStatus,
): AuthorityTransferTerminalResponder | null {
  if (value === null) {
    if (expectedTerminalResponder(localRole, status) !== null) throw new TypeError();
    return null;
  }
  if (!isRecord(value) || !exactKeys(value, TERMINAL_KEYS)) throw new TypeError();
  const state = value.state;
  const expiresAt = value.expiresAt;
  if (
    (state !== 'active' && state !== 'expired' && state !== 'pending')
    || expiresAt !== status.expiresAt
  ) {
    throw new TypeError();
  }
  const expected = expectedTerminalResponder(localRole, status);
  if (
    expected === null
    || (state === 'pending' && expected.state !== 'pending')
    || (state === 'active' && expected.state !== 'active')
    || (state === 'expired' && (expected.state !== 'active' || status.state !== 'completed'))
  ) {
    throw new TypeError();
  }
  return { expiresAt, state };
}

export function decodeAuthorityTransferRecord(value: unknown): AuthorityTransferRecord {
  if (
    !isRecord(value)
    || (
      !exactKeys(value, RECORD_KEYS)
      && !LEGACY_RECORD_KEY_SETS.some(keys => exactKeys(value, keys))
    )
  ) {
    throw new TypeError('Invalid authority transfer record');
  }
  if (value.schemaVersion !== 1 || value.kind !== 'authority-transfer') {
    throw new TypeError('Invalid authority transfer record');
  }
  const localRole = value.localRole;
  const lifecycleOwnership = value.lifecycleOwnership;
  const operationIntentId = value.operationIntentId;
  const stagingDirectoryName = value.stagingDirectoryName;
  if (
    (localRole !== 'source' && localRole !== 'target')
    || (lifecycleOwnership !== 'owned' && lifecycleOwnership !== 'proposal')
    || typeof operationIntentId !== 'string'
    || !isCollabOpaqueId(operationIntentId)
    || typeof stagingDirectoryName !== 'string'
    || stagingDirectoryName.length > 160
  ) {
    throw new TypeError('Invalid authority transfer identity');
  }
  const status = decodeCollabAuthorityTransferStatus(value.status);
  const receiptVerifier = value.receiptVerifier === undefined || value.receiptVerifier === null
    ? null
    : decodeCollabAuthorityTransferOperationResponse(
        'getAuthorityTransferReceiptVerifier',
        value.receiptVerifier,
      );
  const sourceLanEndpoint = value.sourceLanEndpoint === undefined || value.sourceLanEndpoint === null
    ? null
    : decodeSourceLanEndpoint(value.sourceLanEndpoint);
  const relinquishmentProof = status.relinquishmentProof;
  if (
    value.projectId !== status.projectId
    || value.transferId !== status.transferId
    || stagingDirectoryName !== `.claudian-authority-transfer-${status.transferId}`
    || (localRole === 'source') !== (status.direction === 'lan-to-cloud')
    || (lifecycleOwnership === 'proposal' && status.phase !== 'collecting-readiness')
    || (receiptVerifier !== null && (
      localRole !== 'source'
      || status.direction !== 'lan-to-cloud'
      || receiptVerifier.projectId !== status.projectId
      || receiptVerifier.transferId !== status.transferId
    ))
    || (sourceLanEndpoint !== null && (
      localRole !== 'source'
      || status.direction !== 'lan-to-cloud'
      || lifecycleOwnership !== 'owned'
    ))
  ) {
    throw new TypeError('Invalid authority transfer ownership');
  }
  if (relinquishmentProof !== null && (
    relinquishmentProof.operationIntentId !== operationIntentId
    || relinquishmentProof.committedAt < status.createdAt
    || relinquishmentProof.committedAt > status.updatedAt
    || relinquishmentProof.committedAt >= status.expiresAt
  )) {
    throw new TypeError('Invalid authority transfer relinquishment proof');
  }
  const restartFence = expectedRestartFence(localRole, lifecycleOwnership, status);
  if (value.restartFence !== restartFence) {
    throw new TypeError('Invalid authority transfer restart fence');
  }
  const terminalResponder = decodeTerminalResponder(
    value.terminalResponder,
    localRole,
    status,
  );
  const terminalCleanupCompleted = value.terminalCleanupCompleted;
  if (
    typeof terminalCleanupCompleted !== 'boolean'
    || (terminalCleanupCompleted && !isAuthorityTransferTerminalStatus(status))
    || (terminalCleanupCompleted && (
      terminalResponder?.state === 'active'
      || terminalResponder?.state === 'pending'
    ))
  ) {
    throw new TypeError('Invalid authority transfer terminal cleanup');
  }
  return {
    kind: 'authority-transfer',
    lifecycleOwnership,
    localRole,
    operationIntentId,
    projectId: status.projectId,
    receiptVerifier,
    restartFence,
    schemaVersion: 1,
    sourceLanEndpoint,
    stagingDirectoryName,
    status,
    terminalCleanupCompleted,
    terminalResponder,
    transferId: status.transferId,
  };
}

export function createAuthorityTransferRecord(input: {
  readonly localRole: AuthorityTransferLocalRole;
  readonly lifecycleOwnership?: AuthorityTransferLifecycleOwnership;
  readonly operationIntentId: string;
  readonly receiptVerifier?: CollabAuthorityTransferReceiptVerifier | null;
  readonly sourceLanEndpoint?: string | null;
  readonly stagingDirectoryName: string;
  readonly status: CollabAuthorityTransferStatus;
}): AuthorityTransferRecord {
  const status = decodeCollabAuthorityTransferStatus(input.status);
  const lifecycleOwnership = input.lifecycleOwnership
    ?? (status.phase === 'collecting-readiness' ? 'proposal' : 'owned');
  return decodeAuthorityTransferRecord({
    kind: 'authority-transfer',
    lifecycleOwnership,
    localRole: input.localRole,
    operationIntentId: input.operationIntentId,
    projectId: status.projectId,
    receiptVerifier: input.receiptVerifier ?? null,
    restartFence: expectedRestartFence(input.localRole, lifecycleOwnership, status),
    schemaVersion: 1,
    sourceLanEndpoint: input.sourceLanEndpoint ?? null,
    stagingDirectoryName: input.stagingDirectoryName,
    status,
    terminalCleanupCompleted: false,
    terminalResponder: expectedTerminalResponder(input.localRole, status),
    transferId: status.transferId,
  });
}

export function pinAuthorityTransferReceiptVerifier(
  record: AuthorityTransferRecord,
  verifier: CollabAuthorityTransferReceiptVerifier,
): AuthorityTransferRecord {
  if (record.receiptVerifier !== null) {
    if (JSON.stringify(record.receiptVerifier) !== JSON.stringify(verifier)) {
      throw new TypeError('Authority transfer receipt verifier changed');
    }
    return record;
  }
  return decodeAuthorityTransferRecord({ ...record, receiptVerifier: verifier });
}

export function expireAuthorityTransferTerminalResponder(
  record: AuthorityTransferRecord,
): AuthorityTransferRecord {
  if (record.terminalResponder?.state !== 'active' || record.status.state !== 'completed') {
    throw new TypeError('Authority transfer terminal responder is not expirable');
  }
  return decodeAuthorityTransferRecord({
    ...record,
    terminalResponder: {
      ...record.terminalResponder,
      state: 'expired',
    },
  });
}

export function isAuthorityTransferTerminalResponderExpired(
  record: AuthorityTransferRecord,
  now: Date,
): boolean {
  return record.terminalResponder?.state === 'expired'
    || (
      record.terminalResponder?.state === 'active'
      && now.getTime() >= Date.parse(record.status.expiresAt)
    );
}

export function isAuthorityTransferProposal(record: AuthorityTransferRecord): boolean {
  return record.lifecycleOwnership === 'proposal';
}

export function isAuthorityTransferTerminal(record: AuthorityTransferRecord): boolean {
  return isAuthorityTransferTerminalStatus(record.status);
}

function isAuthorityTransferTerminalStatus(status: CollabAuthorityTransferStatus): boolean {
  return status.state === 'cancelled' || status.state === 'completed';
}

export function markAuthorityTransferTerminalCleanupCompleted(
  record: AuthorityTransferRecord,
): AuthorityTransferRecord {
  if (
    !isAuthorityTransferTerminal(record)
    || record.terminalResponder?.state === 'active'
    || record.terminalResponder?.state === 'pending'
  ) {
    throw new TypeError('Authority transfer terminal cleanup is not completable');
  }
  if (record.terminalCleanupCompleted) return record;
  return decodeAuthorityTransferRecord({
    ...record,
    terminalCleanupCompleted: true,
  });
}

export function assertAuthorityTransferTransition(
  previous: AuthorityTransferRecord,
  next: AuthorityTransferRecord,
): void {
  if (
    previous.projectId !== next.projectId
    || previous.transferId !== next.transferId
    || previous.operationIntentId !== next.operationIntentId
    || previous.localRole !== next.localRole
    || previous.stagingDirectoryName !== next.stagingDirectoryName
    || (
      previous.sourceLanEndpoint !== null
      && previous.sourceLanEndpoint !== next.sourceLanEndpoint
    )
    || (
      previous.sourceLanEndpoint === null
      && next.sourceLanEndpoint !== null
      && previous.lifecycleOwnership !== 'proposal'
    )
    || (
      previous.receiptVerifier !== null
      && JSON.stringify(previous.receiptVerifier) !== JSON.stringify(next.receiptVerifier)
    )
    || previous.terminalCleanupCompleted !== next.terminalCleanupCompleted
    || previous.status.direction !== next.status.direction
    || previous.status.sourceAuthority.kind !== next.status.sourceAuthority.kind
    || previous.status.sourceAuthority.generation !== next.status.sourceAuthority.generation
    || previous.status.targetAuthority.kind !== next.status.targetAuthority.kind
    || previous.status.targetAuthority.generation !== next.status.targetAuthority.generation
    || previous.status.targetUrl !== next.status.targetUrl
    || previous.status.createdAt !== next.status.createdAt
    || previous.status.expiresAt !== next.status.expiresAt
  ) {
    throw new TypeError('Authority transfer identity changed');
  }
  if (Date.parse(next.status.updatedAt) < Date.parse(previous.status.updatedAt)) {
    throw new TypeError('Authority transfer time regressed');
  }
  if (
    previous.terminalResponder?.state !== 'expired'
    && next.terminalResponder?.state === 'expired'
  ) {
    throw new TypeError('Authority transfer terminal responder expiry is forbidden');
  }
  if (
    previous.status.relinquishmentProof !== null
    && COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(next.status.phase as never)
  ) {
    throw new TypeError('Authority transfer cancellation is forbidden');
  }
  if (
    previous.status.checkpointSha256 !== null
    && previous.status.checkpointSha256 !== next.status.checkpointSha256
  ) {
    throw new TypeError('Authority transfer checkpoint changed');
  }
  if (
    previous.status.batchRevision !== null
    && (
      previous.status.batchRevision !== next.status.batchRevision
      || previous.status.batchSha256 !== next.status.batchSha256
    )
  ) {
    throw new TypeError('Authority transfer claim batch changed');
  }
  if (
    previous.status.relinquishmentProof !== null
    && JSON.stringify(previous.status.relinquishmentProof)
      !== JSON.stringify(next.status.relinquishmentProof)
  ) {
    throw new TypeError('Authority transfer relinquishment proof changed');
  }
  if (previous.status.phase === next.status.phase) {
    if (
      previous.lifecycleOwnership === 'proposal'
      && next.lifecycleOwnership === 'owned'
      && next.status.phase === 'collecting-readiness'
    ) {
      return;
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new TypeError('Authority transfer phase changed without advancement');
    }
    return;
  }
  const phases = previous.status.direction === 'lan-to-cloud'
    ? COLLAB_LAN_TO_CLOUD_TRANSFER_PHASES
    : COLLAB_CLOUD_TO_LAN_TRANSFER_PHASES;
  const previousIndex = phases.indexOf(previous.status.phase as never);
  const nextIndex = phases.indexOf(next.status.phase as never);
  if (previousIndex >= 0 && nextIndex === previousIndex + 1) return;
  const cancellationIndex = COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.indexOf(
    previous.status.phase as never,
  );
  const nextCancellationIndex = COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.indexOf(
    next.status.phase as never,
  );
  if (
    previous.status.relinquishmentProof === null
    && (
      (previousIndex >= 0 && next.status.phase === 'cancel-intent')
      || (cancellationIndex >= 0 && nextCancellationIndex === cancellationIndex + 1)
    )
  ) {
    return;
  }
  throw new TypeError(
    previous.status.relinquishmentProof !== null && nextCancellationIndex >= 0
      ? 'Authority transfer cancellation is forbidden'
      : 'Authority transfer phase is stale',
  );
}
