import {
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  type CollabMemberId,
  collabMemberRef,
  isCollabMemberId,
} from '@claudian-collab/protocol';

import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface AdmissionSettlementDatabase {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

interface PendingAdmissionIdentity {
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
}

export interface AuthorityTransferAdmissionSettlementOptions {
  readonly database: AdmissionSettlementDatabase;
  readonly runner: Pick<GitCommandRunner, 'run'>;
}

export interface SettleAuthorityTransferAdmissionInput {
  readonly repositoryPath: string;
  readonly settledAt: string;
  readonly signal?: AbortSignal;
}

function settlementError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function pendingAdmissions(
  connection: AuthorityDatabaseConnection,
): readonly PendingAdmissionIdentity[] {
  return connection.all(`
    SELECT member_id, personal_ref
    FROM members
    WHERE status = 'pending'
    ORDER BY member_id
  `).map((row) => {
    const memberId = row.member_id;
    const personalRef = row.personal_ref;
    if (
      typeof memberId !== 'string'
      || !isCollabMemberId(memberId)
      || personalRef !== collabMemberRef(memberId)
    ) throw settlementError('authority-transfer-pending-member-invalid');
    return { memberId, personalRef };
  });
}

function samePendingAdmissions(
  left: readonly PendingAdmissionIdentity[],
  right: readonly PendingAdmissionIdentity[],
): boolean {
  return left.length === right.length && left.every((item, index) => (
    item.memberId === right[index]?.memberId
    && item.personalRef === right[index]?.personalRef
  ));
}

function parseRefs(stdout: Buffer): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  const lines = stdout.toString('utf8').trim();
  if (lines.length === 0) return refs;
  for (const line of lines.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 1) throw settlementError('authority-transfer-ref-inventory-invalid');
    refs.set(line.slice(separator + 1), line.slice(0, separator));
  }
  return refs;
}

export class AuthorityTransferAdmissionSettlement {
  constructor(private readonly options: AuthorityTransferAdmissionSettlementOptions) {}

  async settle(input: SettleAuthorityTransferAdmissionInput): Promise<void> {
    if (
      Number.isNaN(Date.parse(input.settledAt))
      || new Date(input.settledAt).toISOString() !== input.settledAt
    ) throw settlementError('authority-transfer-settlement-time-invalid');
    const pending = await this.options.database.read((connection) => {
      const state = connection.get('SELECT state FROM project WHERE singleton = 1')?.state;
      if (state !== 'active') throw settlementError('authority-transfer-source-not-active');
      return pendingAdmissions(connection);
    });
    const inventory = parseRefs((await this.options.runner.run({
      args: [
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        COLLAB_MAIN_REF,
        COLLAB_MEMBER_REF_PREFIX,
      ],
      cwd: input.repositoryPath,
      maxStdoutBytes: 1024 * 1024,
      signal: input.signal,
      suppressHooks: true,
    })).stdout);
    const mainOid = inventory.get(COLLAB_MAIN_REF);
    if (!mainOid) throw settlementError('authority-transfer-main-ref-missing');
    for (const member of pending) {
      const oid = inventory.get(member.personalRef);
      if (oid !== undefined && oid !== mainOid) {
        throw settlementError('authority-transfer-pending-ref-diverged');
      }
    }

    for (const member of pending) {
      const oid = inventory.get(member.personalRef);
      if (oid === undefined) continue;
      await this.options.runner.run({
        args: ['update-ref', '-d', member.personalRef, oid],
        cwd: input.repositoryPath,
        maxStdoutBytes: 64 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
    }

    await this.options.database.mutate((connection) => {
      const current = pendingAdmissions(connection);
      if (!samePendingAdmissions(current, pending)) {
        throw settlementError('authority-transfer-pending-admission-stale');
      }
      connection.run(`
        UPDATE invitations
        SET revoked_at = ?
        WHERE revoked_at IS NULL
      `, [input.settledAt]);
      for (const member of pending) {
        const changes = connection.run(`
          DELETE FROM members
          WHERE member_id = ? AND status = 'pending' AND personal_ref = ?
        `, [member.memberId, member.personalRef]);
        if (changes !== 1) {
          throw settlementError('authority-transfer-pending-admission-stale');
        }
      }
    });
  }
}
