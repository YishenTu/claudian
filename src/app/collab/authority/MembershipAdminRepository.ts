import { type CollabMemberId, type CollabMemberStatus, type CollabOperationId, type CollabProjectId, type CollabRole, isCollabMemberId, isCollabProjectId } from '@claudian-collab/protocol';

import { ManagerResponsibilityRepository } from '@/app/collab/authority/ManagerResponsibilityRepository';
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketMentionRepository } from '@/app/collab/authority/TicketMentionRepository';
import type {
  DemoteManagerResponse,
  MembershipTerminationResponse,
  PromoteManagerResponse,
} from '@/app/collab/lan/LanCollabControlOperations';
import { CollabError, type CollabRecoveryAction } from '@/core/collab/ClaudianCollabError';

export interface MembershipAdminContext {
  readonly actorRole: CollabRole;
  readonly hostMemberId: CollabMemberId;
  readonly projectId: CollabProjectId;
}

export interface MembershipLeaveResult {
  readonly promotedSuccessor: PromoteManagerResponse | null;
  readonly termination: MembershipTerminationResponse;
}

function membershipError(
  code:
    | 'acceptance-recovery-required'
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'membership-revoked'
    | 'project-not-found'
    | 'stale-project-selection',
  reason: string,
  recoveryActions: readonly CollabRecoveryAction[] = [],
): CollabError {
  return new CollabError({
    code,
    recoveryActions: recoveryActions.length > 0
      ? recoveryActions
      : code === 'authority-integrity-error'
        ? ['open-diagnostics']
        : [],
    safeContext: { reason },
  });
}

function assertMemberId(value: string, reason: string): void {
  if (!isCollabMemberId(value)) {
    throw membershipError('authority-integrity-error', reason);
  }
}

function assertProjectId(value: string, reason: string): void {
  if (!isCollabProjectId(value)) {
    throw membershipError('authority-integrity-error', reason);
  }
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw membershipError('authority-integrity-error', 'membership-timestamp-invalid');
  }
}

export class MembershipAdminRepository {
  constructor(
    private readonly requestTicketRelations = new RequestTicketRelationRepository(),
    private readonly ticketMentions = new TicketMentionRepository(),
    private readonly managerResponsibilities = new ManagerResponsibilityRepository(),
    private readonly managerSet = new ManagerSetRepository(),
  ) {}

  promoteManager(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly consumedAt: string;
      readonly managerResponsibilityOfferId: CollabOperationId;
      readonly projectId: CollabProjectId;
      readonly targetMemberId: CollabMemberId;
    },
  ): PromoteManagerResponse {
    assertMemberId(input.targetMemberId, 'membership-target-id-invalid');
    assertTimestamp(input.consumedAt);
    this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    const managerSet = this.managerSet.requireActiveManager(connection, input.actorMemberId);
    if (input.targetMemberId === input.actorMemberId) {
      throw membershipError('stale-project-selection', 'membership-target-already-manager', ['retry']);
    }
    this.managerResponsibilities.consume(connection, {
      consumedAt: input.consumedAt,
      expectedPurpose: 'manager-promotion',
      expectedSourceManagerMemberId: input.actorMemberId,
      expectedTargetMemberId: input.targetMemberId,
      offerId: input.managerResponsibilityOfferId,
    });
    const updated = this.managerSet.promote(connection, {
      expectedGeneration: managerSet.generation,
      targetMemberId: input.targetMemberId,
    });
    return {
      managerSetGeneration: updated.generation,
      projectId: input.projectId,
      promotedMemberId: input.targetMemberId,
    };
  }

  demoteManager(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly demotedAt: string;
      readonly projectId: CollabProjectId;
      readonly targetMemberId: CollabMemberId;
    },
  ): DemoteManagerResponse {
    assertMemberId(input.targetMemberId, 'membership-target-id-invalid');
    assertTimestamp(input.demotedAt);
    this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    const managerSet = this.managerSet.requireActiveManager(connection, input.actorMemberId);
    if (input.targetMemberId === input.actorMemberId) {
      throw membershipError('authorization-denied', 'membership-manager-self-demotion-denied');
    }
    this.managerResponsibilities.cancelRelatedNonterminal(connection, {
      cancelledAt: input.demotedAt,
      memberId: input.targetMemberId,
    });
    const updated = this.managerSet.demote(connection, {
      expectedGeneration: managerSet.generation,
      targetMemberId: input.targetMemberId,
    });
    return {
      demotedMemberId: input.targetMemberId,
      managerSetGeneration: updated.generation,
      projectId: input.projectId,
    };
  }

  leave(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly expectedHostMemberId: CollabMemberId;
      readonly expectedMemberId: CollabMemberId;
      readonly managerResponsibilityOfferId?: CollabOperationId;
      readonly projectId: CollabProjectId;
      readonly terminatedAt: string;
    },
  ): MembershipLeaveResult {
    assertMemberId(input.expectedMemberId, 'membership-expected-member-id-invalid');
    assertMemberId(input.expectedHostMemberId, 'membership-expected-host-id-invalid');
    assertTimestamp(input.terminatedAt);
    const context = this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    if (input.expectedMemberId !== input.actorMemberId) {
      throw membershipError('stale-project-selection', 'membership-member-changed', ['retry']);
    }
    if (context.hostMemberId !== input.expectedHostMemberId) {
      throw membershipError('stale-project-selection', 'membership-host-changed', ['retry']);
    }
    if (context.hostMemberId === input.actorMemberId) {
      throw membershipError('authorization-denied', 'membership-host-transfer-required');
    }

    const managerSet = this.managerSet.read(connection);
    const actorIsManager = managerSet.managerMemberIds.includes(input.actorMemberId);
    if (!actorIsManager) {
      if (input.managerResponsibilityOfferId !== undefined) {
        throw membershipError(
          'stale-project-selection',
          'membership-manager-offer-unexpected',
          ['retry'],
        );
      }
      this.managerResponsibilities.cancelRelatedNonterminal(connection, {
        cancelledAt: input.terminatedAt,
        memberId: input.actorMemberId,
      });
      return {
        promotedSuccessor: null,
        termination: this.terminateMember(connection, {
          expectedRole: 'member',
          projectId: input.projectId,
          status: 'left',
          targetMemberId: input.actorMemberId,
          terminatedAt: input.terminatedAt,
        }),
      };
    }

    if (managerSet.managerMemberIds.length > 1) {
      if (input.managerResponsibilityOfferId !== undefined) {
        throw membershipError(
          'stale-project-selection',
          'membership-manager-offer-unexpected',
          ['retry'],
        );
      }
      this.managerResponsibilities.cancelRelatedNonterminal(connection, {
        cancelledAt: input.terminatedAt,
        memberId: input.actorMemberId,
      });
      this.managerSet.demote(connection, {
        expectedGeneration: managerSet.generation,
        targetMemberId: input.actorMemberId,
      });
      return {
        promotedSuccessor: null,
        termination: this.terminateMember(connection, {
          expectedRole: 'member',
          projectId: input.projectId,
          status: 'left',
          targetMemberId: input.actorMemberId,
          terminatedAt: input.terminatedAt,
        }),
      };
    }

    if (!input.managerResponsibilityOfferId) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        recoveryActions: ['promote-manager'],
        safeContext: { reason: 'membership-manager-successor-required' },
      });
    }
    const consumed = this.managerResponsibilities.consume(connection, {
      consumedAt: input.terminatedAt,
      expectedPurpose: 'manager-leave',
      expectedSourceManagerMemberId: input.actorMemberId,
      offerId: input.managerResponsibilityOfferId,
    });
    const updated = this.managerSet.promoteSuccessor(connection, {
      departingManagerMemberId: input.actorMemberId,
      expectedGeneration: managerSet.generation,
      targetMemberId: consumed.targetMemberId,
    });
    const termination = this.terminateMember(connection, {
      expectedRole: 'member',
      projectId: input.projectId,
      status: 'left',
      targetMemberId: input.actorMemberId,
      terminatedAt: input.terminatedAt,
    });
    this.managerSet.read(connection);
    return {
      promotedSuccessor: {
        managerSetGeneration: updated.generation,
        projectId: input.projectId,
        promotedMemberId: consumed.targetMemberId,
      },
      termination,
    };
  }

  terminate(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly projectId: CollabProjectId;
      readonly status: Extract<CollabMemberStatus, 'left' | 'revoked'>;
      readonly targetMemberId: CollabMemberId;
      readonly terminatedAt: string;
    },
  ): MembershipTerminationResponse {
    assertMemberId(input.targetMemberId, 'membership-target-id-invalid');
    assertTimestamp(input.terminatedAt);
    const context = this.requireActiveActor(connection, input.projectId, input.actorMemberId);
    if (input.status === 'revoked') {
      this.managerSet.requireActiveManager(connection, input.actorMemberId);
      if (input.targetMemberId === input.actorMemberId) {
        throw membershipError('authorization-denied', 'membership-manager-self-removal-denied');
      }
    }
    if (input.status === 'left' && input.targetMemberId !== input.actorMemberId) {
      throw membershipError('authorization-denied', 'membership-leave-target-mismatch');
    }
    if (input.targetMemberId === context.hostMemberId) {
      throw membershipError('authorization-denied', 'membership-host-cannot-terminate');
    }
    const target = this.requireActiveTarget(connection, input.targetMemberId);
    if (target.role === 'manager') {
      const managerSet = this.managerSet.requireActiveManager(connection, input.actorMemberId);
      this.managerResponsibilities.cancelRelatedNonterminal(connection, {
        cancelledAt: input.terminatedAt,
        memberId: input.targetMemberId,
      });
      this.managerSet.demote(connection, {
        expectedGeneration: managerSet.generation,
        targetMemberId: input.targetMemberId,
      });
    } else {
      this.managerResponsibilities.cancelRelatedNonterminal(connection, {
        cancelledAt: input.terminatedAt,
        memberId: input.targetMemberId,
      });
    }
    return this.terminateMember(connection, {
      expectedRole: 'member',
      projectId: input.projectId,
      status: input.status,
      targetMemberId: input.targetMemberId,
      terminatedAt: input.terminatedAt,
    });
  }

  requireActiveActor(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    actorMemberId: CollabMemberId,
  ): MembershipAdminContext {
    assertProjectId(projectId, 'membership-project-id-invalid');
    assertMemberId(actorMemberId, 'membership-actor-id-invalid');
    const row = connection.get(
      `SELECT
        p.project_id, p.state AS project_state, p.host_member_id,
        m.member_id, m.role AS member_role, m.status AS member_status
       FROM project p
       LEFT JOIN members m ON m.member_id = ?
       WHERE p.singleton = 1`,
      [actorMemberId],
    );
    if (!row || row.project_id !== projectId) {
      throw membershipError('project-not-found', 'membership-project-missing');
    }
    if (row.project_state !== 'active') {
      throw membershipError('authorization-denied', 'membership-project-disabled');
    }
    if (row.member_id !== actorMemberId || row.member_status !== 'active') {
      throw membershipError('membership-revoked', 'membership-actor-not-active');
    }
    if (
      typeof row.host_member_id !== 'string'
      || (row.member_role !== 'manager' && row.member_role !== 'member')
    ) {
      throw membershipError('authority-integrity-error', 'membership-project-row-invalid');
    }
    return {
      actorRole: row.member_role,
      hostMemberId: row.host_member_id,
      projectId,
    };
  }

  private requireActiveTarget(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
  ): { readonly role: CollabRole } {
    const target = connection.get(
      'SELECT member_id, role, status FROM members WHERE member_id = ?',
      [memberId],
    );
    if (!target || target.member_id !== memberId || target.status !== 'active') {
      throw membershipError('membership-revoked', 'membership-target-not-active');
    }
    if (target.role !== 'manager' && target.role !== 'member') {
      throw membershipError('authority-integrity-error', 'membership-target-role-invalid');
    }
    return { role: target.role };
  }

  private terminateMember(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly expectedRole: CollabRole;
      readonly projectId: CollabProjectId;
      readonly status: Extract<CollabMemberStatus, 'left' | 'revoked'>;
      readonly targetMemberId: CollabMemberId;
      readonly terminatedAt: string;
    },
  ): MembershipTerminationResponse {
    const openRequest = connection.get(
      `SELECT request_id
       FROM change_requests
       WHERE member_id = ? AND status = 'open'`,
      [input.targetMemberId],
    );
    const discardedRequestId = openRequest?.request_id ?? null;
    if (discardedRequestId !== null && typeof discardedRequestId !== 'string') {
      throw membershipError('authority-integrity-error', 'membership-request-row-invalid');
    }
    if (discardedRequestId && connection.get(
      `SELECT operation_id
       FROM accept_operations
       WHERE request_id = ? AND state != 'completed'
       LIMIT 1`,
      [discardedRequestId],
    )) {
      throw membershipError(
        'acceptance-recovery-required',
        'membership-request-accept-in-progress',
        ['open-diagnostics'],
      );
    }

    if (discardedRequestId) {
      this.requestTicketRelations.deletePendingForRequest(connection, discardedRequestId);
      connection.run(
        `UPDATE change_requests
         SET status = 'discarded', updated_at = ?
         WHERE request_id = ? AND status = 'open'`,
        [input.terminatedAt, discardedRequestId],
      );
    }
    this.ticketMentions.deleteForMember(connection, input.targetMemberId);
    connection.run(
      `UPDATE members
       SET status = ?, revoked_at = ?
       WHERE member_id = ? AND role = ? AND status = 'active'`,
      [input.status, input.terminatedAt, input.targetMemberId, input.expectedRole],
    );

    const updated = connection.get(
      'SELECT role, status, revoked_at FROM members WHERE member_id = ?',
      [input.targetMemberId],
    );
    const request = discardedRequestId
      ? connection.get('SELECT status, merged_oid FROM change_requests WHERE request_id = ?', [
        discardedRequestId,
      ])
      : null;
    if (
      !updated
      || updated.role !== input.expectedRole
      || updated.status !== input.status
      || updated.revoked_at !== input.terminatedAt
      || (request && (request.status !== 'discarded' || request.merged_oid !== null))
    ) {
      throw membershipError('authority-integrity-error', 'membership-termination-failed');
    }
    return {
      discardedRequestId,
      memberId: input.targetMemberId,
      projectId: input.projectId,
      status: input.status,
    };
  }
}
