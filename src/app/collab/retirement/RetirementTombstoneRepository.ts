import { createHash, timingSafeEqual } from 'node:crypto';

import { type CollabIsoTimestamp, type CollabMemberId, type CollabProjectId } from '@claudian-collab/protocol';

import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  decodeRetirementTombstoneRecord,
  type RetirementTombstoneRecord,
} from '@/app/collab/retirement/RetirementTombstoneRecord';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabRetirementResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MEMBER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RetirementTombstoneStore {
  listRetirementTombstoneProjectIds(): Promise<readonly CollabProjectId[]>;
  loadRetirementTombstone(
    projectId: CollabProjectId,
  ): Promise<RetirementTombstoneRecord | null>;
  removeRetirementTombstone(projectId: CollabProjectId): Promise<boolean>;
  saveRetirementTombstone(record: RetirementTombstoneRecord): Promise<void>;
}

export interface RetirementTombstoneRepositoryOptions {
  readonly isRecoveryOwner: (ownerInstallationKey: string | undefined) => boolean;
  readonly now?: () => Date;
}

export interface RetirementTombstoneAuthentication {
  readonly memberId: CollabMemberId;
  readonly tombstone: RetirementTombstoneRecord;
}

export interface RetirementAcknowledgementResult {
  readonly acknowledgedAt: CollabIsoTimestamp;
  readonly result: CollabRetirementResult;
}

export interface RetirementTombstoneRestoreResult {
  readonly expiredProjectIds: readonly CollabProjectId[];
  readonly tombstones: readonly RetirementTombstoneRecord[];
}

function retirementError(
  code:
    | 'authentication-failed'
    | 'durable-progress-recovery-required'
    | 'project-not-found'
    | 'stale-project-selection',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'durable-progress-recovery-required'
      ? ['retry', 'open-diagnostics']
      : [],
    safeContext: { reason },
  });
}

function credentialDigest(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

function sameRecord(
  left: RetirementTombstoneRecord,
  right: RetirementTombstoneRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class RetirementTombstoneRepository {
  private readonly isRecoveryOwner: RetirementTombstoneRepositoryOptions['isRecoveryOwner'];
  private readonly now: () => Date;
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly store: RetirementTombstoneStore | CollabLocalProjectRepository,
    options: RetirementTombstoneRepositoryOptions,
  ) {
    this.isRecoveryOwner = options.isRecoveryOwner;
    this.now = options.now ?? (() => new Date());
  }

  load(projectId: CollabProjectId): Promise<RetirementTombstoneRecord | null> {
    return this.queue.run(async () => {
      const tombstone = await this.store.loadRetirementTombstone(projectId);
      if (!tombstone) return null;
      if (Date.parse(tombstone.expiresAt) <= this.now().getTime()) {
        return null;
      }
      return tombstone;
    });
  }

  savePrepared(record: RetirementTombstoneRecord): Promise<void> {
    let decoded: RetirementTombstoneRecord;
    try {
      decoded = decodeRetirementTombstoneRecord(record);
    } catch {
      return Promise.reject(retirementError(
        'durable-progress-recovery-required',
        'retirement-tombstone-invalid',
      ));
    }
    return this.queue.run(async () => {
      const existing = await this.store.loadRetirementTombstone(decoded.projectId);
      if (existing) {
        if (!sameRecord(existing, decoded)) {
          throw retirementError(
            'durable-progress-recovery-required',
            'retirement-tombstone-conflict',
          );
        }
        return;
      }
      await this.store.saveRetirementTombstone(decoded);
    });
  }

  authenticate(
    projectId: CollabProjectId,
    memberCredential: string,
  ): Promise<RetirementTombstoneAuthentication> {
    if (!MEMBER_CREDENTIAL_PATTERN.test(memberCredential)) {
      return Promise.reject(retirementError(
        'authentication-failed',
        'retirement-credential-invalid',
      ));
    }
    return this.queue.run(async () => {
      const tombstone = await this.loadUnlocked(projectId);
      const actual = credentialDigest(memberCredential);
      let matchedMemberId: CollabMemberId | null = null;
      for (const member of tombstone.formerMembers) {
        const expected = Buffer.from(member.credentialHash, 'hex');
        if (expected.length === actual.length && timingSafeEqual(actual, expected)) {
          matchedMemberId = member.memberId;
        }
      }
      if (!matchedMemberId) {
        throw retirementError('authentication-failed', 'retirement-credential-mismatch');
      }
      return { memberId: matchedMemberId, tombstone };
    });
  }

  acknowledge(
    projectId: CollabProjectId,
    memberCredential: string,
    expectedRetiredAt?: CollabIsoTimestamp,
  ): Promise<RetirementAcknowledgementResult> {
    if (!MEMBER_CREDENTIAL_PATTERN.test(memberCredential)) {
      return Promise.reject(retirementError(
        'authentication-failed',
        'retirement-credential-invalid',
      ));
    }
    return this.queue.run(async () => {
      const tombstone = await this.loadUnlocked(projectId);
      if (
        expectedRetiredAt !== undefined
        && tombstone.result.retiredAt !== expectedRetiredAt
      ) {
        throw retirementError('stale-project-selection', 'retirement-timestamp-changed');
      }
      const actual = credentialDigest(memberCredential);
      let memberIndex = -1;
      for (let index = 0; index < tombstone.formerMembers.length; index += 1) {
        const expected = Buffer.from(tombstone.formerMembers[index].credentialHash, 'hex');
        if (expected.length === actual.length && timingSafeEqual(actual, expected)) {
          memberIndex = index;
        }
      }
      if (memberIndex < 0) {
        throw retirementError('authentication-failed', 'retirement-credential-mismatch');
      }
      const member = tombstone.formerMembers[memberIndex];
      const acknowledgedAt = member.acknowledgedAt ?? this.now().toISOString();
      if (member.acknowledgedAt === null) {
        const formerMembers = tombstone.formerMembers.map((candidate, index) => (
          index === memberIndex ? { ...candidate, acknowledgedAt } : candidate
        ));
        await this.store.saveRetirementTombstone({ ...tombstone, formerMembers });
      }
      return {
        acknowledgedAt,
        result: tombstone.result,
      };
    });
  }

  restore(): Promise<RetirementTombstoneRestoreResult> {
    return this.queue.run(async () => {
      const expiredProjectIds: CollabProjectId[] = [];
      const tombstones: RetirementTombstoneRecord[] = [];
      const now = this.now().getTime();
      for (const projectId of await this.store.listRetirementTombstoneProjectIds()) {
        const tombstone = await this.store.loadRetirementTombstone(projectId);
        if (!tombstone) continue;
        if (
          tombstone.ownerInstallationKey !== undefined
          && !this.isRecoveryOwner(tombstone.ownerInstallationKey)
        ) continue;
        if (Date.parse(tombstone.expiresAt) <= now) {
          expiredProjectIds.push(projectId);
        } else {
          tombstones.push(tombstone);
        }
      }
      return { expiredProjectIds, tombstones };
    });
  }

  remove(projectId: CollabProjectId): Promise<boolean> {
    return this.queue.run(() => this.store.removeRetirementTombstone(projectId));
  }

  private async loadUnlocked(projectId: CollabProjectId): Promise<RetirementTombstoneRecord> {
    const tombstone = await this.store.loadRetirementTombstone(projectId);
    if (!tombstone) {
      throw retirementError('project-not-found', 'retirement-tombstone-missing');
    }
    if (Date.parse(tombstone.expiresAt) <= this.now().getTime()) {
      throw retirementError('project-not-found', 'retirement-tombstone-expired');
    }
    return tombstone;
  }
}
