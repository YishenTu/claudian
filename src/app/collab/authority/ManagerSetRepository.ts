import { type CollabMemberId, isCollabMemberId } from '@claudian-collab/protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityManagerSet {
  readonly generation: number;
  readonly managerMemberIds: readonly CollabMemberId[];
}

interface ManagerSetMutationInput {
  readonly expectedGeneration: number;
  readonly targetMemberId: CollabMemberId;
}

interface PromoteManagerSuccessorInput extends ManagerSetMutationInput {
  readonly departingManagerMemberId: CollabMemberId;
}

function managerSetError(
  code: 'authority-integrity-error' | 'authorization-denied' | 'membership-revoked'
    | 'stale-project-selection',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : code === 'stale-project-selection'
        ? ['retry']
        : [],
    safeContext: { reason },
  });
}

function assertMemberId(value: string): void {
  if (!isCollabMemberId(value)) {
    throw managerSetError('authority-integrity-error', 'manager-member-id-invalid');
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw managerSetError('authority-integrity-error', 'manager-set-generation-invalid');
  }
}

export class ManagerSetRepository {
  read(connection: AuthorityDatabaseConnection): AuthorityManagerSet {
    const project = connection.get(
      'SELECT manager_set_generation FROM project WHERE singleton = 1',
    );
    const generation = project?.manager_set_generation;
    if (typeof generation !== 'number') {
      throw managerSetError('authority-integrity-error', 'manager-set-project-missing');
    }
    assertGeneration(generation);
    const managerMemberIds = connection.all(`
      SELECT member_id
      FROM members
      WHERE role = 'manager' AND status = 'active'
      ORDER BY member_id
    `).map(row => {
      if (typeof row.member_id !== 'string') {
        throw managerSetError('authority-integrity-error', 'manager-set-row-invalid');
      }
      assertMemberId(row.member_id);
      return row.member_id;
    });
    if (managerMemberIds.length === 0) {
      throw managerSetError('authority-integrity-error', 'manager-set-empty');
    }
    return { generation, managerMemberIds };
  }

  requireActiveManager(
    connection: AuthorityDatabaseConnection,
    actorMemberId: CollabMemberId,
  ): AuthorityManagerSet {
    assertMemberId(actorMemberId);
    const managerSet = this.read(connection);
    if (!managerSet.managerMemberIds.includes(actorMemberId)) {
      throw managerSetError('authorization-denied', 'manager-role-required');
    }
    return managerSet;
  }

  promote(
    connection: AuthorityDatabaseConnection,
    input: ManagerSetMutationInput,
  ): AuthorityManagerSet {
    this.requireTarget(connection, input.targetMemberId, 'member');
    connection.run(
      "UPDATE members SET role = 'manager' WHERE member_id = ? AND role = 'member' AND status = 'active'",
      [input.targetMemberId],
    );
    return this.advanceGeneration(connection, input.expectedGeneration);
  }

  demote(
    connection: AuthorityDatabaseConnection,
    input: ManagerSetMutationInput,
  ): AuthorityManagerSet {
    const before = this.read(connection);
    if (!before.managerMemberIds.includes(input.targetMemberId)) {
      throw managerSetError('stale-project-selection', 'manager-target-role-changed');
    }
    if (before.managerMemberIds.length === 1) {
      throw managerSetError('authorization-denied', 'last-manager-required');
    }
    connection.run(
      "UPDATE members SET role = 'member' WHERE member_id = ? AND role = 'manager' AND status = 'active'",
      [input.targetMemberId],
    );
    return this.advanceGeneration(connection, input.expectedGeneration);
  }

  promoteSuccessor(
    connection: AuthorityDatabaseConnection,
    input: PromoteManagerSuccessorInput,
  ): AuthorityManagerSet {
    assertMemberId(input.departingManagerMemberId);
    if (input.departingManagerMemberId === input.targetMemberId) {
      throw managerSetError('authorization-denied', 'manager-successor-must-differ');
    }
    const before = this.read(connection);
    if (!before.managerMemberIds.includes(input.departingManagerMemberId)) {
      throw managerSetError('stale-project-selection', 'departing-manager-role-changed');
    }
    this.requireTarget(connection, input.targetMemberId, 'member');
    connection.run(
      "UPDATE members SET role = 'manager' WHERE member_id = ? AND role = 'member' AND status = 'active'",
      [input.targetMemberId],
    );
    connection.run(
      "UPDATE members SET role = 'member' WHERE member_id = ? AND role = 'manager' AND status = 'active'",
      [input.departingManagerMemberId],
    );
    return this.advanceGeneration(connection, input.expectedGeneration);
  }

  advanceGeneration(
    connection: AuthorityDatabaseConnection,
    expectedGeneration: number,
  ): AuthorityManagerSet {
    assertGeneration(expectedGeneration);
    const rowsModified = connection.run(
      `UPDATE project
       SET manager_set_generation = manager_set_generation + 1
       WHERE singleton = 1 AND manager_set_generation = ?`,
      [expectedGeneration],
    );
    if (rowsModified !== 1) {
      throw managerSetError('stale-project-selection', 'manager-set-generation-changed');
    }
    const managerSet = this.read(connection);
    if (managerSet.generation !== expectedGeneration + 1) {
      throw managerSetError('stale-project-selection', 'manager-set-generation-changed');
    }
    return managerSet;
  }

  private requireTarget(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
    role: 'manager' | 'member',
  ): void {
    assertMemberId(memberId);
    const target = connection.get(
      'SELECT role, status FROM members WHERE member_id = ?',
      [memberId],
    );
    if (!target || target.status !== 'active') {
      throw managerSetError('membership-revoked', 'manager-target-not-active');
    }
    if (target.role !== role) {
      throw managerSetError('stale-project-selection', 'manager-target-role-changed');
    }
  }
}
