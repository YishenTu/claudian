import { type CollabMemberId, type CollabOperationId, isCollabMemberId, isCollabOpaqueId } from '@claudian-collab/protocol';

import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import type {
  CollabManagerResponsibilityOfferSummary,
  CollabManagerResponsibilityPurpose,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NONTERMINAL_STATUSES = new Set(['offered', 'acknowledged']);

export interface ConsumeManagerResponsibilityInput {
  readonly consumedAt: string;
  readonly expectedPurpose: CollabManagerResponsibilityPurpose;
  readonly expectedSourceManagerMemberId: CollabMemberId;
  readonly expectedTargetMemberId?: CollabMemberId;
  readonly offerId: CollabOperationId;
}

interface ManagerResponsibilityOfferRecord {
  readonly acknowledgedAt: string | null;
  readonly consumedAt: string | null;
  readonly expiresAt: string;
  readonly offeredAt: string;
  readonly offerId: CollabOperationId;
  readonly purpose: CollabManagerResponsibilityPurpose;
  readonly sourceManagerMemberId: CollabMemberId;
  readonly status: CollabManagerResponsibilityOfferSummary['status'];
  readonly targetMemberId: CollabMemberId;
  readonly updatedAt: string;
}

function responsibilityError(
  code:
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'manager-responsibility-pending'
    | 'membership-revoked'
    | 'stale-project-selection',
  reason: string,
  offer?: Pick<ManagerResponsibilityOfferRecord, 'expiresAt' | 'offerId' | 'status'>,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : code === 'stale-project-selection'
        ? ['retry']
        : [],
    safeContext: {
      ...(offer ? {
        expiresAt: offer.expiresAt,
        offerId: offer.offerId,
        status: offer.status,
      } : {}),
      reason,
    },
  });
}

function assertId(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  reason: string,
): void {
  if (!predicate(value)) {
    throw responsibilityError('authority-integrity-error', reason);
  }
}

function assertTimestamp(value: string, reason: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw responsibilityError('authority-integrity-error', reason);
  }
}

function text(
  row: Readonly<Record<string, unknown>>,
  field: string,
  nullable = false,
): string | null {
  const value = row[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    throw responsibilityError('authority-integrity-error', 'manager-responsibility-row-invalid');
  }
  return value;
}

function decodeRecord(
  row: Readonly<Record<string, unknown>>,
): ManagerResponsibilityOfferRecord {
  const offerId = text(row, 'offer_id')!;
  const purpose = text(row, 'purpose');
  const sourceManagerMemberId = text(row, 'source_manager_member_id')!;
  const targetMemberId = text(row, 'target_member_id')!;
  const status = text(row, 'status');
  const offeredAt = text(row, 'offered_at')!;
  const expiresAt = text(row, 'expires_at')!;
  const acknowledgedAt = text(row, 'acknowledged_at', true);
  const consumedAt = text(row, 'consumed_at', true);
  const updatedAt = text(row, 'updated_at')!;
  if (
    (purpose !== 'manager-promotion' && purpose !== 'manager-leave')
    || (
      status !== 'offered'
      && status !== 'acknowledged'
      && status !== 'consumed'
      && status !== 'declined'
      && status !== 'cancelled'
      && status !== 'expired'
    )
  ) {
    throw responsibilityError('authority-integrity-error', 'manager-responsibility-row-invalid');
  }
  assertId(offerId, isCollabOpaqueId, 'manager-responsibility-offer-id-invalid');
  assertId(
    sourceManagerMemberId,
    isCollabMemberId,
    'manager-responsibility-source-id-invalid',
  );
  assertId(targetMemberId, isCollabMemberId, 'manager-responsibility-target-id-invalid');
  assertTimestamp(offeredAt, 'manager-responsibility-offered-at-invalid');
  assertTimestamp(expiresAt, 'manager-responsibility-expires-at-invalid');
  assertTimestamp(updatedAt, 'manager-responsibility-updated-at-invalid');
  if (acknowledgedAt !== null) {
    assertTimestamp(acknowledgedAt, 'manager-responsibility-acknowledged-at-invalid');
  }
  if (consumedAt !== null) {
    assertTimestamp(consumedAt, 'manager-responsibility-consumed-at-invalid');
  }
  if (
    sourceManagerMemberId === targetMemberId
    || Date.parse(expiresAt) <= Date.parse(offeredAt)
    || (status === 'offered' && (acknowledgedAt !== null || consumedAt !== null))
    || (status === 'acknowledged' && (acknowledgedAt === null || consumedAt !== null))
    || (status === 'consumed' && (acknowledgedAt === null || consumedAt === null))
    || (
      (status === 'declined' || status === 'cancelled' || status === 'expired')
      && consumedAt !== null
    )
  ) {
    throw responsibilityError('authority-integrity-error', 'manager-responsibility-row-invalid');
  }
  return {
    acknowledgedAt,
    consumedAt,
    expiresAt,
    offeredAt,
    offerId,
    purpose,
    sourceManagerMemberId,
    status,
    targetMemberId,
    updatedAt,
  };
}

function toSummary(
  record: ManagerResponsibilityOfferRecord,
): CollabManagerResponsibilityOfferSummary {
  return {
    ...(record.acknowledgedAt === null ? {} : {
      acknowledgedAt: record.acknowledgedAt,
    }),
    expiresAt: record.expiresAt,
    offeredAt: record.offeredAt,
    offerId: record.offerId,
    purpose: record.purpose,
    sourceManagerMemberId: record.sourceManagerMemberId,
    status: record.status,
    targetMemberId: record.targetMemberId,
  };
}

const OFFER_COLUMNS = `
  offer_id, purpose, source_manager_member_id,
  target_member_id, status,
  offered_at, expires_at, acknowledged_at, consumed_at, updated_at
`;

export class ManagerResponsibilityRepository {
  constructor(private readonly managerSet = new ManagerSetRepository()) {}

  create(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly expiresAt: string;
      readonly offeredAt: string;
      readonly offerId: CollabOperationId;
      readonly purpose: CollabManagerResponsibilityPurpose;
      readonly sourceManagerMemberId: CollabMemberId;
      readonly targetMemberId: CollabMemberId;
    },
  ): CollabManagerResponsibilityOfferSummary {
    assertId(input.offerId, isCollabOpaqueId, 'manager-responsibility-offer-id-invalid');
    assertId(
      input.sourceManagerMemberId,
      isCollabMemberId,
      'manager-responsibility-source-id-invalid',
    );
    assertId(input.targetMemberId, isCollabMemberId, 'manager-responsibility-target-id-invalid');
    assertTimestamp(input.offeredAt, 'manager-responsibility-offered-at-invalid');
    assertTimestamp(input.expiresAt, 'manager-responsibility-expires-at-invalid');
    if (
      input.sourceManagerMemberId === input.targetMemberId
      || (input.purpose !== 'manager-promotion' && input.purpose !== 'manager-leave')
      || Date.parse(input.expiresAt) <= Date.parse(input.offeredAt)
    ) {
      throw responsibilityError('authority-integrity-error', 'manager-responsibility-input-invalid');
    }
    const existing = this.findParticipantConflict(
      connection,
      input.sourceManagerMemberId,
      input.targetMemberId,
    );
    if (existing) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-exists',
        existing,
      );
    }
    const managerSet = this.managerSet.requireActiveManager(
      connection,
      input.sourceManagerMemberId,
    );
    if (input.purpose === 'manager-leave' && managerSet.managerMemberIds.length !== 1) {
      throw responsibilityError(
        'stale-project-selection',
        'manager-responsibility-successor-not-required',
      );
    }
    const target = connection.get(
      'SELECT member_id, role, status FROM members WHERE member_id = ?',
      [input.targetMemberId],
    );
    if (!target || target.member_id !== input.targetMemberId || target.status !== 'active') {
      throw responsibilityError('membership-revoked', 'manager-responsibility-target-not-active');
    }
    if (target.role !== 'member') {
      throw responsibilityError(
        'stale-project-selection',
        'manager-responsibility-target-role-changed',
      );
    }
    connection.run(
      `INSERT INTO manager_responsibility_offers (
        offer_id, purpose, source_manager_member_id,
        target_member_id, status,
        offered_at, expires_at, acknowledged_at, consumed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'offered', ?, ?, NULL, NULL, ?)`,
      [
        input.offerId,
        input.purpose,
        input.sourceManagerMemberId,
        input.targetMemberId,
        input.offeredAt,
        input.expiresAt,
        input.offeredAt,
      ],
    );
    return toSummary(this.requireById(connection, input.offerId));
  }

  findById(
    connection: AuthorityDatabaseConnection,
    offerId: CollabOperationId,
  ): CollabManagerResponsibilityOfferSummary | null {
    assertId(offerId, isCollabOpaqueId, 'manager-responsibility-offer-id-invalid');
    const row = connection.get(
      `SELECT ${OFFER_COLUMNS}
       FROM manager_responsibility_offers
       WHERE offer_id = ?`,
      [offerId],
    );
    return row ? toSummary(decodeRecord(row)) : null;
  }

  findCurrentForActor(
    connection: AuthorityDatabaseConnection,
    actorMemberId: CollabMemberId,
  ): CollabManagerResponsibilityOfferSummary | null {
    assertId(actorMemberId, isCollabMemberId, 'manager-responsibility-actor-id-invalid');
    const row = connection.get(
      `SELECT ${OFFER_COLUMNS}
       FROM manager_responsibility_offers
       WHERE (source_manager_member_id = ? OR target_member_id = ?)
         AND status IN ('offered', 'acknowledged')
       LIMIT 1`,
      [actorMemberId, actorMemberId],
    );
    return row ? toSummary(decodeRecord(row)) : null;
  }

  expireDue(connection: AuthorityDatabaseConnection, expiredAt: string): number {
    assertTimestamp(expiredAt, 'manager-responsibility-expired-at-invalid');
    const due = connection.all(
      `SELECT offer_id
       FROM manager_responsibility_offers
       WHERE status IN ('offered', 'acknowledged') AND expires_at <= ?`,
      [expiredAt],
    );
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'expired', updated_at = ?
       WHERE status IN ('offered', 'acknowledged') AND expires_at <= ?`,
      [expiredAt, expiredAt],
    );
    return due.length;
  }

  acknowledge(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly acknowledgedAt: string;
      readonly actorMemberId: CollabMemberId;
      readonly expectedTargetMemberId: CollabMemberId;
      readonly offerId: CollabOperationId;
    },
  ): CollabManagerResponsibilityOfferSummary {
    const record = this.requireById(connection, input.offerId);
    this.requireTargetActor(record, input.actorMemberId, input.expectedTargetMemberId);
    this.requireNotExpired(record, input.acknowledgedAt);
    if (record.status !== 'offered') {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-not-offered',
        record,
      );
    }
    this.requireValidParticipants(connection, record);
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?
       WHERE offer_id = ? AND status = 'offered'`,
      [input.acknowledgedAt, input.acknowledgedAt, record.offerId],
    );
    return toSummary(this.requireById(connection, record.offerId));
  }

  decline(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly declinedAt: string;
      readonly expectedTargetMemberId: CollabMemberId;
      readonly offerId: CollabOperationId;
    },
  ): CollabManagerResponsibilityOfferSummary {
    const record = this.requireById(connection, input.offerId);
    this.requireTargetActor(record, input.actorMemberId, input.expectedTargetMemberId);
    this.requireNotExpired(record, input.declinedAt);
    if (record.status !== 'offered') {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-not-declinable',
        record,
      );
    }
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'declined', updated_at = ?
       WHERE offer_id = ? AND status = 'offered'`,
      [input.declinedAt, record.offerId],
    );
    return toSummary(this.requireById(connection, record.offerId));
  }

  cancel(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly cancelledAt: string;
      readonly offerId: CollabOperationId;
    },
  ): CollabManagerResponsibilityOfferSummary {
    const record = this.requireById(connection, input.offerId);
    if (
      record.sourceManagerMemberId !== input.actorMemberId
    ) {
      throw responsibilityError('authorization-denied', 'manager-responsibility-source-required');
    }
    this.requireNotExpired(record, input.cancelledAt);
    if (!NONTERMINAL_STATUSES.has(record.status)) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-not-cancellable',
        record,
      );
    }
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'cancelled', updated_at = ?
       WHERE offer_id = ? AND status IN ('offered', 'acknowledged')`,
      [input.cancelledAt, record.offerId],
    );
    return toSummary(this.requireById(connection, record.offerId));
  }

  cancelRelatedNonterminal(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly cancelledAt: string;
      readonly memberId: CollabMemberId;
    },
  ): number {
    assertId(input.memberId, isCollabMemberId, 'manager-responsibility-member-id-invalid');
    return this.cancelMatchingNonterminal(connection, input.cancelledAt, input.memberId);
  }

  consume(
    connection: AuthorityDatabaseConnection,
    input: ConsumeManagerResponsibilityInput,
  ): CollabManagerResponsibilityOfferSummary {
    const record = this.requireById(connection, input.offerId);
    this.requireNotExpired(record, input.consumedAt);
    if (
      record.status !== 'acknowledged'
      || record.purpose !== input.expectedPurpose
      || record.sourceManagerMemberId !== input.expectedSourceManagerMemberId
      || (
        input.expectedTargetMemberId !== undefined
        && record.targetMemberId !== input.expectedTargetMemberId
      )
    ) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-mismatch',
        record,
      );
    }
    this.requireValidParticipants(connection, record);
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'consumed', consumed_at = ?, updated_at = ?
       WHERE offer_id = ? AND status = 'acknowledged'`,
      [input.consumedAt, input.consumedAt, record.offerId],
    );
    return toSummary(this.requireById(connection, record.offerId));
  }

  private findParticipantConflict(
    connection: AuthorityDatabaseConnection,
    sourceManagerMemberId: CollabMemberId,
    targetMemberId: CollabMemberId,
  ): ManagerResponsibilityOfferRecord | null {
    const row = connection.get(
      `SELECT ${OFFER_COLUMNS}
       FROM manager_responsibility_offers
       WHERE status IN ('offered', 'acknowledged')
         AND (
           source_manager_member_id IN (?, ?)
           OR target_member_id IN (?, ?)
         )
       LIMIT 1`,
      [
        sourceManagerMemberId,
        targetMemberId,
        sourceManagerMemberId,
        targetMemberId,
      ],
    );
    return row ? decodeRecord(row) : null;
  }

  private cancelMatchingNonterminal(
    connection: AuthorityDatabaseConnection,
    cancelledAt: string,
    memberId?: CollabMemberId,
  ): number {
    assertTimestamp(cancelledAt, 'manager-responsibility-cancelled-at-invalid');
    const where = memberId === undefined
      ? "status IN ('offered', 'acknowledged')"
      : "status IN ('offered', 'acknowledged') AND (source_manager_member_id = ? OR target_member_id = ?)";
    const params = memberId === undefined ? [] : [memberId, memberId];
    const matches = connection.all(
      `SELECT offer_id FROM manager_responsibility_offers WHERE ${where}`,
      params,
    );
    connection.run(
      `UPDATE manager_responsibility_offers
       SET status = 'cancelled', updated_at = ?
       WHERE ${where}`,
      [cancelledAt, ...params],
    );
    return matches.length;
  }

  private requireActiveTarget(
    connection: AuthorityDatabaseConnection,
    targetMemberId: CollabMemberId,
  ): void {
    const target = connection.get(
      'SELECT member_id, role, status FROM members WHERE member_id = ?',
      [targetMemberId],
    );
    if (!target || target.member_id !== targetMemberId || target.status !== 'active') {
      throw responsibilityError('membership-revoked', 'manager-responsibility-target-not-active');
    }
    if (target.role !== 'member') {
      throw responsibilityError(
        'stale-project-selection',
        'manager-responsibility-target-role-changed',
      );
    }
  }

  private requireValidParticipants(
    connection: AuthorityDatabaseConnection,
    record: ManagerResponsibilityOfferRecord,
  ): void {
    const managerSet = this.managerSet.requireActiveManager(
      connection,
      record.sourceManagerMemberId,
    );
    this.requireActiveTarget(connection, record.targetMemberId);
    if (record.purpose === 'manager-leave' && managerSet.managerMemberIds.length !== 1) {
      throw responsibilityError(
        'stale-project-selection',
        'manager-responsibility-successor-not-required',
      );
    }
  }

  private requireById(
    connection: AuthorityDatabaseConnection,
    offerId: CollabOperationId,
  ): ManagerResponsibilityOfferRecord {
    assertId(offerId, isCollabOpaqueId, 'manager-responsibility-offer-id-invalid');
    const row = connection.get(
      `SELECT ${OFFER_COLUMNS}
       FROM manager_responsibility_offers
       WHERE offer_id = ?`,
      [offerId],
    );
    if (!row) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-not-found',
      );
    }
    return decodeRecord(row);
  }

  private requireNotExpired(
    record: ManagerResponsibilityOfferRecord,
    now: string,
  ): void {
    assertTimestamp(now, 'manager-responsibility-transition-at-invalid');
    if (NONTERMINAL_STATUSES.has(record.status) && Date.parse(record.expiresAt) <= Date.parse(now)) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-offer-expired',
        { ...record, status: 'expired' },
      );
    }
  }

  private requireTargetActor(
    record: ManagerResponsibilityOfferRecord,
    actorMemberId: CollabMemberId,
    expectedTargetMemberId: CollabMemberId,
  ): void {
    if (
      actorMemberId !== expectedTargetMemberId
      || record.targetMemberId !== actorMemberId
    ) {
      throw responsibilityError('authorization-denied', 'manager-responsibility-target-required');
    }
  }
}
