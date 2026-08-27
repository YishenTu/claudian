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
  record: AuthorityTransferRecord,
  observed: CollabAuthorityTransferStatus,
): boolean {
  return record.projectId === observed.projectId
    && record.transferId === observed.transferId
    && record.status.direction === observed.direction
    && record.status.sourceAuthority.kind === observed.sourceAuthority.kind
    && record.status.sourceAuthority.generation === observed.sourceAuthority.generation
    && record.status.targetAuthority.kind === observed.targetAuthority.kind
    && record.status.targetAuthority.generation === observed.targetAuthority.generation
    && record.status.targetUrl === observed.targetUrl
    && record.status.createdAt === observed.createdAt
    && record.status.expiresAt === observed.expiresAt;
}

/** Persists every durable phase implied by one later authoritative observation. */
export async function advanceThroughObservedAuthorityStatus(
  persistence: Pick<AuthorityTransferPersistence, 'advance'>,
  initial: AuthorityTransferRecord,
  observedValue: CollabAuthorityTransferStatus,
): Promise<AuthorityTransferRecord> {
  const observed = decodeCollabAuthorityTransferStatus(observedValue);
  if (!sameIdentity(initial, observed)) {
    throw statusError('authority-transfer-observed-identity-mismatch');
  }
  if (initial.status.phase === observed.phase) {
    if (JSON.stringify(initial.status) !== JSON.stringify(observed)) {
      throw statusError('authority-transfer-observed-phase-conflict');
    }
    return initial;
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
      receiptVerifier: current.receiptVerifier,
      sourceLanEndpoint: current.sourceLanEndpoint,
      stagingDirectoryName: current.stagingDirectoryName,
      status,
    });
    await persistence.advance(next, current.status.phase);
    current = next;
  }
  return current;
}
