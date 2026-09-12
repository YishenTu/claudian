import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  COLLAB_CLOUD_TO_LAN_TRANSFER_PHASES,
  COLLAB_LAN_TO_CLOUD_TRANSFER_PHASES,
  type CollabAuthorityTransferStatus,
  decodeCollabAuthorityTransferStatus,
} from '@claudian-collab/protocol';

import {
  type AuthorityTransferRecord,
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { parseInstallationKey } from '@/core/device/InstallationKey';

function statusError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-transfer-stale',
    recoveryActions: ['resume'],
    safeContext: { reason },
  });
}

function phases(status: CollabAuthorityTransferStatus): readonly string[] {
  const forward = status.direction === 'lan-to-cloud'
    ? COLLAB_LAN_TO_CLOUD_TRANSFER_PHASES
    : COLLAB_CLOUD_TO_LAN_TRANSFER_PHASES;
  return status.phase === 'cancelled'
    || COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(status.phase as never)
    ? COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES
    : forward;
}

function intermediateStatus(
  current: CollabAuthorityTransferStatus,
  observed: CollabAuthorityTransferStatus,
  phase: CollabAuthorityTransferStatus['phase'],
): CollabAuthorityTransferStatus {
  const forward = observed.direction === 'lan-to-cloud'
    ? COLLAB_LAN_TO_CLOUD_TRANSFER_PHASES
    : COLLAB_CLOUD_TO_LAN_TRANSFER_PHASES;
  const cancellation = COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(phase as never);
  const checkpointRequired = cancellation
    ? current.checkpointSha256 !== null || observed.checkpointSha256 !== null
    : forward.indexOf(phase as never) >= 2;
  const batchRequired = cancellation
    ? current.batchRevision !== null || observed.batchRevision !== null
    : forward.indexOf(phase as never) >= 4;
  const relinquishmentRequired = observed.direction === 'lan-to-cloud'
    ? forward.indexOf(phase as never) >= 6
    : forward.indexOf(phase as never) >= 5;
  return decodeCollabAuthorityTransferStatus({
    ...observed,
    batchRevision: batchRequired
      ? observed.batchRevision ?? current.batchRevision
      : null,
    batchSha256: batchRequired
      ? observed.batchSha256 ?? current.batchSha256
      : null,
    checkpointSha256: checkpointRequired
      ? observed.checkpointSha256 ?? current.checkpointSha256
      : null,
    phase,
    relinquishmentProof: relinquishmentRequired ? observed.relinquishmentProof : null,
    state: phase === 'completed'
      ? 'completed'
      : phase === 'cancelled'
        ? 'cancelled'
        : 'active',
  });
}

function sameIdentity(
  current: CollabAuthorityTransferStatus,
  observed: CollabAuthorityTransferStatus,
): boolean {
  return current.projectId === observed.projectId
    && current.transferId === observed.transferId
    && current.direction === observed.direction
    && current.sourceAuthority.kind === observed.sourceAuthority.kind
    && current.sourceAuthority.generation === observed.sourceAuthority.generation
    && current.targetAuthority.kind === observed.targetAuthority.kind
    && current.targetAuthority.generation === observed.targetAuthority.generation
    && current.targetUrl === observed.targetUrl
    && current.createdAt === observed.createdAt
    && current.expiresAt === observed.expiresAt;
}

export function assertAuthorityTransferStatusObservation(
  current: CollabAuthorityTransferStatus,
  observedValue: CollabAuthorityTransferStatus,
): CollabAuthorityTransferStatus {
  const observed = decodeCollabAuthorityTransferStatus(observedValue);
  if (!sameIdentity(current, observed)) {
    throw statusError('authority-transfer-observed-identity-mismatch');
  }
  if (Date.parse(observed.updatedAt) < Date.parse(current.updatedAt)) {
    throw statusError('authority-transfer-observed-time-regressed');
  }
  const path = phases(observed);
  const currentIndex = path.indexOf(current.phase);
  const observedIndex = path.indexOf(observed.phase);
  const crossingIntoCancellation = observedIndex >= 0
    && currentIndex < 0
    && current.relinquishmentProof === null;
  if ((!crossingIntoCancellation && currentIndex < 0) || observedIndex < 0) {
    throw statusError('authority-transfer-observed-phase-family-mismatch');
  }
  if (!crossingIntoCancellation && observedIndex < currentIndex) {
    throw statusError('authority-transfer-observed-phase-regressed');
  }
  if (
    current.checkpointSha256 !== null
    && current.checkpointSha256 !== observed.checkpointSha256
  ) throw statusError('authority-transfer-observed-checkpoint-mismatch');
  if (current.batchRevision !== null && (
    current.batchRevision !== observed.batchRevision
    || current.batchSha256 !== observed.batchSha256
  )) throw statusError('authority-transfer-observed-batch-mismatch');
  if (
    current.relinquishmentProof !== null
    && JSON.stringify(current.relinquishmentProof)
      !== JSON.stringify(observed.relinquishmentProof)
  ) throw statusError('authority-transfer-observed-relinquishment-mismatch');
  if (current.phase === observed.phase) {
    if (JSON.stringify(current) !== JSON.stringify(observed)) {
      throw statusError('authority-transfer-observed-phase-conflict');
    }
    return observed;
  }
  return observed;
}

function canAdoptLanToCloudCanonicalIdentity(
  record: AuthorityTransferRecord,
  observed: CollabAuthorityTransferStatus,
): boolean {
  return record.lifecycleOwnership === 'owned'
    && record.localRole === 'source'
    && record.status.direction === 'lan-to-cloud'
    && record.status.phase === 'collecting-readiness'
    && record.status.state === 'active'
    && record.status.updatedAt === record.status.createdAt
    && record.status.batchRevision === null
    && record.status.batchSha256 === null
    && record.status.checkpointSha256 === null
    && record.status.relinquishmentProof === null
    && observed.direction === 'lan-to-cloud'
    && observed.phase !== 'collecting-readiness'
    && record.projectId === observed.projectId
    && record.transferId === observed.transferId
    && record.status.sourceAuthority.kind === observed.sourceAuthority.kind
    && record.status.sourceAuthority.generation === observed.sourceAuthority.generation
    && record.status.targetAuthority.kind === observed.targetAuthority.kind
    && record.status.targetAuthority.generation === observed.targetAuthority.generation
    && record.status.targetUrl === observed.targetUrl;
}

/** Persists every durable phase implied by one later authoritative observation. */
export async function advanceThroughObservedAuthorityStatus(
  persistence: Pick<
    AuthorityTransferPersistence,
    'adoptLanToCloudCanonicalIdentity' | 'advance'
  >,
  initial: AuthorityTransferRecord,
  observedValue: CollabAuthorityTransferStatus,
): Promise<AuthorityTransferRecord> {
  const observed = decodeCollabAuthorityTransferStatus(observedValue);
  const adoptingCanonicalIdentity = !sameIdentity(initial.status, observed)
    && canAdoptLanToCloudCanonicalIdentity(initial, observed);
  if (!adoptingCanonicalIdentity) {
    assertAuthorityTransferStatusObservation(initial.status, observed);
    if (initial.status.phase === observed.phase) return initial;
  }
  const path = phases(observed);
  const currentIndex = path.indexOf(initial.status.phase);
  const observedIndex = path.indexOf(observed.phase);
  const crossingIntoCancellation = observedIndex >= 0
    && currentIndex < 0
    && initial.status.relinquishmentProof === null;
  if ((!crossingIntoCancellation && currentIndex < 0) || observedIndex < 0) {
    throw statusError('authority-transfer-observed-phase-family-mismatch');
  }
  const start = crossingIntoCancellation ? 0 : currentIndex + 1;
  if (!crossingIntoCancellation && observedIndex < currentIndex) {
    throw statusError('authority-transfer-observed-phase-regressed');
  }
  let current = initial;
  for (let index = start; index <= observedIndex; index += 1) {
    const phase = path[index];
    if (!phase) throw statusError('authority-transfer-observed-phase-missing');
    const typedPhase = phase as CollabAuthorityTransferStatus['phase'];
    const status = typedPhase === observed.phase
      ? observed
      : intermediateStatus(current.status, observed, typedPhase);
    const next = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: current.localRole,
      operationIntentId: current.operationIntentId,
      ownerInstallationKey: parseInstallationKey(current.ownerInstallationKey),
      receiptVerifier: current.receiptVerifier,
      sourceLanEndpoint: current.sourceLanEndpoint,
      stagingDirectoryName: current.stagingDirectoryName,
      status,
    });
    if (adoptingCanonicalIdentity && current === initial) {
      await persistence.adoptLanToCloudCanonicalIdentity(next);
    } else {
      await persistence.advance(next, current.status.phase);
    }
    current = next;
  }
  return current;
}
