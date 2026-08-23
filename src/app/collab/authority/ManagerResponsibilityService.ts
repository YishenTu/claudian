import { createHash, randomUUID } from 'node:crypto';

import { type CollabMemberId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId } from '@claudian-collab/protocol';

import type { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import type { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import {
  ManagerResponsibilityRepository,
} from '@/app/collab/authority/ManagerResponsibilityRepository';
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { MembershipAdminRepository } from '@/app/collab/authority/MembershipAdminRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type {
  AcknowledgeManagerResponsibilityRequest,
  CancelManagerResponsibilityOfferRequest,
  CreateManagerResponsibilityOfferRequest,
  DeclineManagerResponsibilityRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabManagerResponsibilityOfferSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const OFFER_TTL_MS = 10 * 60 * 1_000;

export interface ManagerResponsibilityDatabasePort {
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
}

export interface ManagerResponsibilityPresencePort {
  hasAuthenticatedPresence(
    projectId: CollabProjectId,
    memberId: CollabMemberId,
  ): boolean;
}

export interface ManagerResponsibilityAuthority {
  readonly database: ManagerResponsibilityDatabasePort;
  readonly events: AuthorityEventRepository;
  readonly idempotency: AuthorityIdempotencyRepository;
  readonly presence: ManagerResponsibilityPresencePort;
}

export interface ManagerResponsibilityServiceOptions {
  readonly createOfferId?: () => string;
  readonly now?: () => Date;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function responsibilityError(
  code:
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'manager-responsibility-pending',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error' ? ['open-diagnostics'] : [],
    safeContext: { reason },
  });
}

function decodeSummary(value: unknown): CollabManagerResponsibilityOfferSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw responsibilityError(
      'authority-integrity-error',
      'manager-responsibility-response-invalid',
    );
  }
  const response = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(response).sort();
  const expectedKeys = [
    'expiresAt',
    'offeredAt',
    'offerId',
    'purpose',
    'sourceManagerMemberId',
    'status',
    'targetMemberId',
    ...(response.acknowledgedAt === undefined ? [] : ['acknowledgedAt']),
  ].sort();
  const statuses = new Set([
    'offered',
    'acknowledged',
    'consumed',
    'declined',
    'cancelled',
    'expired',
  ]);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || typeof response.offerId !== 'string'
    || !isCollabOpaqueId(response.offerId)
    || (response.purpose !== 'manager-promotion' && response.purpose !== 'manager-leave')
    || typeof response.sourceManagerMemberId !== 'string'
    || !isCollabMemberId(response.sourceManagerMemberId)
    || typeof response.targetMemberId !== 'string'
    || !isCollabMemberId(response.targetMemberId)
    || typeof response.status !== 'string'
    || !statuses.has(response.status)
    || !isTimestamp(response.offeredAt)
    || !isTimestamp(response.expiresAt)
    || (response.acknowledgedAt !== undefined && !isTimestamp(response.acknowledgedAt))
  ) {
    throw responsibilityError(
      'authority-integrity-error',
      'manager-responsibility-response-invalid',
    );
  }
  return response as unknown as CollabManagerResponsibilityOfferSummary;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export class ManagerResponsibilityService {
  private readonly createOfferId: () => string;
  private readonly managerSet = new ManagerSetRepository();
  private readonly membership = new MembershipAdminRepository();
  private readonly now: () => Date;
  private readonly repository = new ManagerResponsibilityRepository();

  constructor(
    private readonly authority: ManagerResponsibilityAuthority,
    options: ManagerResponsibilityServiceOptions = {},
  ) {
    this.createOfferId = options.createOfferId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async create(
    actorMemberId: CollabMemberId,
    request: CreateManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const offeredAt = this.now().toISOString();
    const expiresAt = new Date(Date.parse(offeredAt) + OFFER_TTL_MS).toISOString();
    const offerId = this.createOfferId();
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'manager-responsibility' as const,
      requestFingerprint: fingerprint({
        action: 'create',
        projectId: request.projectId,
        purpose: request.purpose,
        targetMemberId: request.targetMemberId,
      }),
    };
    return (await this.authority.database.mutate(connection => {
      this.membership.requireActiveActor(
        connection,
        request.projectId,
        actorMemberId,
      );
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeSummary(replay.response);
      this.repository.expireDue(connection, offeredAt);
      this.managerSet.requireActiveManager(connection, actorMemberId);
      this.requirePresence(request.projectId, request.targetMemberId);
      const summary = this.repository.create(connection, {
        expiresAt,
        offeredAt,
        offerId,
        purpose: request.purpose,
        sourceManagerMemberId: actorMemberId,
        targetMemberId: request.targetMemberId,
      });
      this.appendInvalidation(connection, actorMemberId, request.projectId, offeredAt);
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: offeredAt,
        response: summary,
      }).response;
    })).value;
  }

  async getCurrent(
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    const currentAt = this.now().toISOString();
    const summary = await this.authority.database.read(connection => {
      this.membership.requireActiveActor(connection, projectId, actorMemberId);
      return this.repository.findCurrentForActor(connection, actorMemberId);
    });
    if (!summary || Date.parse(summary.expiresAt) > Date.parse(currentAt)) return summary;
    await this.authority.database.mutate(connection => {
      this.membership.requireActiveActor(connection, projectId, actorMemberId);
      this.repository.expireDue(connection, currentAt);
    });
    return null;
  }

  async getById(
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
    offerId: string,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const currentAt = this.now().toISOString();
    const summary = await this.authority.database.read(connection => {
      this.membership.requireActiveActor(connection, projectId, actorMemberId);
      const found = this.repository.findById(connection, offerId);
      if (!found) {
        throw responsibilityError(
          'manager-responsibility-pending',
          'manager-responsibility-offer-not-found',
        );
      }
      this.requireReader(found, actorMemberId);
      return found;
    });
    if (
      (summary.status === 'offered' || summary.status === 'acknowledged')
      && Date.parse(summary.expiresAt) <= Date.parse(currentAt)
    ) {
      return (await this.authority.database.mutate(connection => {
        this.membership.requireActiveActor(connection, projectId, actorMemberId);
        this.repository.expireDue(connection, currentAt);
        const expired = this.repository.findById(connection, offerId);
        if (!expired) {
          throw responsibilityError(
            'manager-responsibility-pending',
            'manager-responsibility-offer-not-found',
          );
        }
        this.requireReader(expired, actorMemberId);
        return expired;
      })).value;
    }
    return summary;
  }

  acknowledge(
    actorMemberId: CollabMemberId,
    request: AcknowledgeManagerResponsibilityRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    return this.transition(actorMemberId, request, 'acknowledge');
  }

  decline(
    actorMemberId: CollabMemberId,
    request: DeclineManagerResponsibilityRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    return this.transition(actorMemberId, request, 'decline');
  }

  async cancel(
    actorMemberId: CollabMemberId,
    request: CancelManagerResponsibilityOfferRequest,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const cancelledAt = this.now().toISOString();
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'manager-responsibility' as const,
      requestFingerprint: fingerprint({
        action: 'cancel',
        offerId: request.offerId,
        projectId: request.projectId,
      }),
    };
    return (await this.authority.database.mutate(connection => {
      this.membership.requireActiveActor(
        connection,
        request.projectId,
        actorMemberId,
      );
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeSummary(replay.response);
      this.managerSet.requireActiveManager(connection, actorMemberId);
      const summary = this.repository.cancel(connection, {
        actorMemberId,
        cancelledAt,
        offerId: request.offerId,
      });
      this.appendInvalidation(connection, actorMemberId, request.projectId, cancelledAt);
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: cancelledAt,
        response: summary,
      }).response;
    })).value;
  }

  private appendInvalidation(
    connection: AuthorityDatabaseConnection,
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
    createdAt: string,
  ): void {
    this.authority.events.append(connection, {
      actorMemberId,
      createdAt,
      kind: 'membership.manager-responsibility-changed',
      payload: { projectId },
    });
  }

  private requirePresence(projectId: CollabProjectId, memberId: CollabMemberId): void {
    if (!this.authority.presence.hasAuthenticatedPresence(projectId, memberId)) {
      throw responsibilityError(
        'manager-responsibility-pending',
        'manager-responsibility-target-offline',
      );
    }
  }

  private requireReader(
    summary: CollabManagerResponsibilityOfferSummary,
    actorMemberId: CollabMemberId,
  ): void {
    if (
      actorMemberId !== summary.sourceManagerMemberId
      && actorMemberId !== summary.targetMemberId
    ) {
      throw responsibilityError(
        'authorization-denied',
        'manager-responsibility-offer-reader-denied',
      );
    }
  }

  private async transition(
    actorMemberId: CollabMemberId,
    request: AcknowledgeManagerResponsibilityRequest,
    action: 'acknowledge' | 'decline',
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const transitionedAt = this.now().toISOString();
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'manager-responsibility' as const,
      requestFingerprint: fingerprint({
        action,
        expectedTargetMemberId: request.expectedTargetMemberId,
        offerId: request.offerId,
        projectId: request.projectId,
      }),
    };
    return (await this.authority.database.mutate(connection => {
      this.membership.requireActiveActor(connection, request.projectId, actorMemberId);
      const replay = this.authority.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeSummary(replay.response);
      const common = {
        actorMemberId,
        expectedTargetMemberId: request.expectedTargetMemberId,
        offerId: request.offerId,
      };
      const summary = action === 'acknowledge'
        ? this.repository.acknowledge(connection, {
          ...common,
          acknowledgedAt: transitionedAt,
        })
        : this.repository.decline(connection, {
          ...common,
          declinedAt: transitionedAt,
        });
      this.appendInvalidation(connection, actorMemberId, request.projectId, transitionedAt);
      return this.authority.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: transitionedAt,
        response: summary,
      }).response;
    })).value;
  }
}
