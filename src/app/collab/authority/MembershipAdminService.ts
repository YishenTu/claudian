import { createHash } from 'node:crypto';

import { type CollabMemberId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import type { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ManagerResponsibilityRepository } from '@/app/collab/authority/ManagerResponsibilityRepository';
import type {
  ManagerResponsibilityPresencePort,
} from '@/app/collab/authority/ManagerResponsibilityService';
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { MembershipAdminRepository } from '@/app/collab/authority/MembershipAdminRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type {
  DemoteManagerRequest,
  DemoteManagerResponse,
  LeaveProjectRequest,
  MembershipTerminationResponse,
  PromoteManagerRequest,
  PromoteManagerResponse,
  RemoveMemberRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface MembershipAdminDatabasePort {
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface MembershipAdminAuthority {
  readonly database: MembershipAdminDatabasePort;
  readonly events: AuthorityEventRepository;
  readonly idempotency: AuthorityIdempotencyRepository;
}

export interface MembershipAdminServiceOptions {
  readonly now?: () => Date;
  readonly onMembershipTerminated?: (
    result: MembershipTerminationResponse,
  ) => void | Promise<void>;
  readonly presence?: ManagerResponsibilityPresencePort;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function serviceError(reason: string, cause?: unknown): CollabError {
  return new CollabError({
    cause,
    code: cause === undefined
      ? 'authority-integrity-error'
      : 'durable-progress-recovery-required',
    recoveryActions: cause === undefined
      ? ['open-diagnostics']
      : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function decodePromote(value: unknown, request: PromoteManagerRequest): PromoteManagerResponse {
  const response = exactRecord(value, [
    'managerSetGeneration',
    'projectId',
    'promotedMemberId',
  ], 'membership-promotion-response-invalid');
  if (
    typeof response.projectId !== 'string'
    || !isCollabProjectId(response.projectId)
    || typeof response.promotedMemberId !== 'string'
    || !isCollabMemberId(response.promotedMemberId)
    || !isGeneration(response.managerSetGeneration)
    || response.projectId !== request.projectId
    || response.promotedMemberId !== request.targetMemberId
  ) {
    throw serviceError('membership-promotion-response-invalid');
  }
  return {
    managerSetGeneration: response.managerSetGeneration,
    projectId: response.projectId,
    promotedMemberId: response.promotedMemberId,
  };
}

function decodeDemote(value: unknown, request: DemoteManagerRequest): DemoteManagerResponse {
  const response = exactRecord(value, [
    'demotedMemberId',
    'managerSetGeneration',
    'projectId',
  ], 'membership-demotion-response-invalid');
  if (
    typeof response.projectId !== 'string'
    || !isCollabProjectId(response.projectId)
    || typeof response.demotedMemberId !== 'string'
    || !isCollabMemberId(response.demotedMemberId)
    || !isGeneration(response.managerSetGeneration)
    || response.projectId !== request.projectId
    || response.demotedMemberId !== request.targetMemberId
  ) {
    throw serviceError('membership-demotion-response-invalid');
  }
  return {
    demotedMemberId: response.demotedMemberId,
    managerSetGeneration: response.managerSetGeneration,
    projectId: response.projectId,
  };
}

function decodeTermination(
  value: unknown,
  expected: {
    readonly memberId: CollabMemberId;
    readonly projectId: string;
    readonly status: 'left' | 'revoked';
  },
): MembershipTerminationResponse {
  const response = exactRecord(value, [
    'discardedRequestId',
    'memberId',
    'projectId',
    'status',
  ], 'membership-termination-response-invalid');
  if (
    typeof response.projectId !== 'string'
    || !isCollabProjectId(response.projectId)
    || typeof response.memberId !== 'string'
    || !isCollabMemberId(response.memberId)
    || (response.status !== 'left' && response.status !== 'revoked')
    || (typeof response.discardedRequestId !== 'string'
      && response.discardedRequestId !== null)
    || (typeof response.discardedRequestId === 'string'
      && !isCollabOpaqueId(response.discardedRequestId))
    || response.projectId !== expected.projectId
    || response.memberId !== expected.memberId
    || response.status !== expected.status
  ) {
    throw serviceError('membership-termination-response-invalid');
  }
  return {
    discardedRequestId: response.discardedRequestId,
    memberId: response.memberId,
    projectId: response.projectId,
    status: response.status,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  reason: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(reason);
  }
  const response = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(response).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    keys.length !== sortedExpected.length
    || keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw serviceError(reason);
  }
  return response;
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class MembershipAdminService {
  private readonly managerResponsibilities = new ManagerResponsibilityRepository();
  private readonly managerSet = new ManagerSetRepository();
  private readonly now: () => Date;
  private readonly onMembershipTerminated?: (
    result: MembershipTerminationResponse,
  ) => void | Promise<void>;
  private readonly presence: ManagerResponsibilityPresencePort;
  private readonly repository = new MembershipAdminRepository();

  constructor(
    private readonly authority: MembershipAdminAuthority,
    options: MembershipAdminServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onMembershipTerminated = options.onMembershipTerminated;
    this.presence = options.presence ?? {
      hasAuthenticatedPresence: () => false,
    };
  }

  async promoteManager(
    actorMemberId: CollabMemberId,
    request: PromoteManagerRequest,
  ): Promise<PromoteManagerResponse> {
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'promote-manager' as const,
      requestFingerprint: fingerprint({
        managerResponsibilityOfferId: request.managerResponsibilityOfferId,
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      }),
    };
    return (await this.authority.database.mutate(connection => {
      this.repository.requireActiveActor(connection, request.projectId, actorMemberId);
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodePromote(replay.response, request);
      this.managerSet.requireActiveManager(connection, actorMemberId);
      this.requirePresence(request.projectId, request.targetMemberId);
      const createdAt = this.now().toISOString();
      const result = this.repository.promoteManager(connection, {
        actorMemberId,
        consumedAt: createdAt,
        managerResponsibilityOfferId: request.managerResponsibilityOfferId,
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      });
      this.authority.events.append(connection, {
        actorMemberId,
        createdAt,
        kind: 'membership.manager-promoted',
        payload: {
          memberId: result.promotedMemberId,
          projectId: result.projectId,
        },
      });
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt,
        response: result,
      }).response;
    })).value;
  }

  async demoteManager(
    actorMemberId: CollabMemberId,
    request: DemoteManagerRequest,
  ): Promise<DemoteManagerResponse> {
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'demote-manager' as const,
      requestFingerprint: fingerprint({
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      }),
    };
    return (await this.authority.database.mutate(connection => {
      this.repository.requireActiveActor(connection, request.projectId, actorMemberId);
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeDemote(replay.response, request);
      this.managerSet.requireActiveManager(connection, actorMemberId);
      const createdAt = this.now().toISOString();
      const result = this.repository.demoteManager(connection, {
        actorMemberId,
        demotedAt: createdAt,
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      });
      this.authority.events.append(connection, {
        actorMemberId,
        createdAt,
        kind: 'membership.manager-demoted',
        payload: {
          memberId: result.demotedMemberId,
          projectId: result.projectId,
        },
      });
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt,
        response: result,
      }).response;
    })).value;
  }

  removeMember(
    actorMemberId: CollabMemberId,
    request: RemoveMemberRequest,
  ): Promise<MembershipTerminationResponse> {
    return this.terminateMember(actorMemberId, request, request.memberId);
  }

  async leaveProject(
    actorMemberId: CollabMemberId,
    request: LeaveProjectRequest,
  ): Promise<MembershipTerminationResponse> {
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'leave-project' as const,
      requestFingerprint: fingerprint({
        expectedHostMemberId: request.expectedHostMemberId,
        expectedManagerMemberId: request.idempotencyManagerMemberId,
        expectedMemberId: request.expectedMemberId,
        managerResponsibilityOfferId: request.managerResponsibilityOfferId ?? null,
        projectId: request.projectId,
      }),
    };
    const result = (await this.authority.database.mutate(connection => {
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeTermination(replay.response, {
        memberId: actorMemberId,
        projectId: request.projectId,
        status: 'left',
      });
      this.repository.requireActiveActor(connection, request.projectId, actorMemberId);
      if (request.managerResponsibilityOfferId) {
        const managerSet = this.managerSet.read(connection);
        if (
          managerSet.managerMemberIds.length === 1
          && managerSet.managerMemberIds[0] === actorMemberId
        ) {
          const offer = this.managerResponsibilities.findById(
            connection,
            request.managerResponsibilityOfferId,
          );
          if (offer) this.requirePresence(request.projectId, offer.targetMemberId);
        }
      }
      const terminatedAt = this.now().toISOString();
      const leave = this.repository.leave(connection, {
        actorMemberId,
        expectedHostMemberId: request.expectedHostMemberId,
        expectedMemberId: request.expectedMemberId,
        ...(request.managerResponsibilityOfferId === undefined ? {} : {
          managerResponsibilityOfferId: request.managerResponsibilityOfferId,
        }),
        projectId: request.projectId,
        terminatedAt,
      });
      if (leave.promotedSuccessor) {
        this.authority.events.append(connection, {
          actorMemberId,
          createdAt: terminatedAt,
          kind: 'membership.manager-promoted',
          payload: {
            memberId: leave.promotedSuccessor.promotedMemberId,
            projectId: leave.promotedSuccessor.projectId,
          },
        });
      }
      this.authority.events.append(connection, {
        actorMemberId,
        createdAt: terminatedAt,
        kind: 'membership.left',
        payload: {
          discardedRequestId: leave.termination.discardedRequestId,
          memberId: leave.termination.memberId,
        },
      });
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: terminatedAt,
        response: leave.termination,
      }).response;
    })).value;
    await this.notifyTermination(result);
    return result;
  }

  private async terminateMember(
    actorMemberId: CollabMemberId,
    request: RemoveMemberRequest,
    targetMemberId: CollabMemberId,
  ): Promise<MembershipTerminationResponse> {
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'remove-member' as const,
      requestFingerprint: fingerprint({
        memberId: targetMemberId,
        projectId: request.projectId,
      }),
    };
    const result = (await this.authority.database.mutate(connection => {
      this.repository.requireActiveActor(connection, request.projectId, actorMemberId);
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeTermination(replay.response, {
        memberId: targetMemberId,
        projectId: request.projectId,
        status: 'revoked',
      });
      this.managerSet.requireActiveManager(connection, actorMemberId);
      const terminatedAt = this.now().toISOString();
      const termination = this.repository.terminate(connection, {
        actorMemberId,
        projectId: request.projectId,
        status: 'revoked',
        targetMemberId,
        terminatedAt,
      });
      this.authority.events.append(connection, {
        actorMemberId,
        createdAt: terminatedAt,
        kind: 'membership.revoked',
        payload: {
          discardedRequestId: termination.discardedRequestId,
          memberId: termination.memberId,
        },
      });
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: terminatedAt,
        response: termination,
      }).response;
    })).value;
    await this.notifyTermination(result);
    return result;
  }

  private async notifyTermination(result: MembershipTerminationResponse): Promise<void> {
    try {
      await this.onMembershipTerminated?.(result);
    } catch (error) {
      throw serviceError('membership-termination-cleanup-failed', error);
    }
  }

  private requirePresence(projectId: string, memberId: CollabMemberId): void {
    if (!this.presence.hasAuthenticatedPresence(projectId, memberId)) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        recoveryActions: [],
        safeContext: { reason: 'manager-responsibility-target-offline' },
      });
    }
  }
}
