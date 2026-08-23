import { createHash, randomUUID } from 'node:crypto';

import { type CollabMemberId, type CollabParsedTicketReference, type CollabRequestTicketRelation, type EnsureMyRequestRequest, type EnsureMyRequestResponse, isCollabGitOid, isCollabOpaqueId, parseCollabTicketReferences, type UpdateMyRequestMetadataRequest, type UpdateMyRequestMetadataResponse } from '@claudian-collab/protocol';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import {
  decodeAuthorityChangeRequest,
  RequestEnsureRepository,
} from '@/app/collab/authority/RequestEnsureRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketRepository } from '@/app/collab/authority/TicketRepository';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RequestEnsureDatabasePort {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface RequestEnsureHeadPolicyInput {
  readonly expectedMainOid: string;
  readonly headOid: string;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly projectId: string;
}

export interface RequestEnsureHeadPolicyPort {
  validate(input: RequestEnsureHeadPolicyInput): Promise<{ readonly mainOid: string }>;
}

export interface RequestEnsureServiceOptions {
  readonly createRelationId?: () => string;
  readonly createRequestId?: () => string;
  readonly now?: () => Date;
}

function serviceError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function requestFingerprint(request: EnsureMyRequestRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      expectedMainOid: request.expectedMainOid,
      headOid: request.headOid,
      projectId: request.projectId,
      description: request.description,
    }))
    .digest('hex');
}

function normalizeDescription(description: string): string {
  const normalizedLines = description.replace(/\r\n?/g, '\n').split('\n');
  while (normalizedLines[0]?.trim().length === 0) normalizedLines.shift();
  while (normalizedLines.at(-1)?.trim().length === 0) normalizedLines.pop();
  const normalized = normalizedLines.join('\n');
  if (normalized.trim().length === 0) {
    throw new CollabError({ code: 'description-required' });
  }
  if (new TextEncoder().encode(normalized).byteLength >
    CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes) {
    throw new CollabError({ code: 'quota-exceeded' });
  }
  return normalized;
}

function decodeStoredRelations(value: unknown): readonly CollabRequestTicketRelation[] {
  if (!Array.isArray(value)) throw serviceError('request-relations-invalid');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw serviceError('request-relations-invalid');
    }
    const relation = entry as Readonly<Record<string, unknown>>;
    if (
      typeof relation.id !== 'string'
      || !isCollabOpaqueId(relation.id)
      || typeof relation.ticketId !== 'string'
      || !isCollabOpaqueId(relation.ticketId)
      || typeof relation.ticketNumber !== 'number'
      || !Number.isSafeInteger(relation.ticketNumber)
      || relation.ticketNumber < 1
      || typeof relation.ticketTitle !== 'string'
      || typeof relation.ticketRevision !== 'number'
      || !Number.isSafeInteger(relation.ticketRevision)
      || relation.ticketRevision < 1
      || typeof relation.commitOid !== 'string'
      || !isCollabGitOid(relation.commitOid)
      || (relation.kind !== 'references' && relation.kind !== 'resolves')
      || (relation.state !== 'pending' && relation.state !== 'accepted')
    ) {
      throw serviceError('request-relations-invalid');
    }
    return relation as unknown as CollabRequestTicketRelation;
  });
}

function decodeResponse(value: unknown): EnsureMyRequestResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('request-idempotency-response-invalid');
  }
  const request = (value as Readonly<Record<string, unknown>>).request;
  const mainOid = (value as Readonly<Record<string, unknown>>).mainOid;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw serviceError('request-idempotency-response-invalid');
  }
  const row = request as Readonly<Record<string, unknown>>;
  if (!isCollabGitOid(mainOid)) {
    throw serviceError('request-idempotency-response-invalid');
  }
  return {
    mainOid,
    request: decodeAuthorityChangeRequest({
      ...row,
      comment_count: row.commentCount,
      created_at: row.createdAt,
      description: row.description,
      first_base_oid: row.firstBaseOid,
      latest_head_oid: row.latestHeadOid,
      member_id: row.memberId,
      merged_oid: row.mergedOid ?? null,
      request_id: row.id,
      revision: row.revision,
      updated_at: row.updatedAt,
    }, decodeStoredRelations(row.ticketRelations)),
  };
}

function decodeMetadataResponse(value: unknown): UpdateMyRequestMetadataResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('request-idempotency-response-invalid');
  }
  const request = (value as Readonly<Record<string, unknown>>).request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw serviceError('request-idempotency-response-invalid');
  }
  const row = request as Readonly<Record<string, unknown>>;
  return {
    request: decodeAuthorityChangeRequest({
      ...row,
      comment_count: row.commentCount,
      created_at: row.createdAt,
      description: row.description,
      first_base_oid: row.firstBaseOid,
      latest_head_oid: row.latestHeadOid,
      member_id: row.memberId,
      merged_oid: row.mergedOid ?? null,
      request_id: row.id,
      revision: row.revision,
      updated_at: row.updatedAt,
    }, decodeStoredRelations(row.ticketRelations)),
  };
}

export class RequestEnsureService {
  private readonly createRequestId: () => string;
  private readonly createRelationId: () => string;
  private readonly events = new AuthorityEventRepository();
  private readonly idempotency = new AuthorityIdempotencyRepository();
  private readonly now: () => Date;
  private readonly requests = new RequestEnsureRepository();
  private readonly tickets = new TicketRepository();

  constructor(
    private readonly database: RequestEnsureDatabasePort,
    private readonly headPolicy: RequestEnsureHeadPolicyPort,
    options: RequestEnsureServiceOptions = {},
  ) {
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.createRelationId = options.createRelationId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async ensure(
    actorMemberId: CollabMemberId,
    request: EnsureMyRequestRequest,
  ): Promise<EnsureMyRequestResponse> {
    const description = normalizeDescription(request.description);
    const parsed = parseCollabTicketReferences(description);
    if (parsed.status === 'invalid') {
      throw new CollabError({
        code: parsed.reason === 'description-too-large'
          ? 'quota-exceeded'
          : 'protocol-payload-invalid',
        safeContext: { field: 'description' },
      });
    }
    const normalizedRequest = { ...request, description };
    const fingerprint = requestFingerprint(normalizedRequest);
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'publish' as const,
      requestFingerprint: fingerprint,
    };
    const initial = await this.database.read(connection => ({
      actor: this.requests.requireActiveMember(connection, request.projectId, actorMemberId),
      replay: this.idempotency.find<unknown>(connection, idempotencyInput),
    }));
    if (initial.replay) return decodeResponse(initial.replay.response);
    const actor = initial.actor;
    const validated = await this.headPolicy.validate({
      expectedMainOid: request.expectedMainOid,
      headOid: request.headOid,
      memberId: actorMemberId,
      personalRef: actor.personalRef,
      projectId: request.projectId,
    });
    if (validated.mainOid !== request.expectedMainOid) {
      throw new CollabError({
        code: 'stale-main',
        recoveryActions: ['retry'],
        safeContext: { reason: 'request-policy-main-mismatch' },
      });
    }
    const createdAt = this.now().toISOString();
    const requestId = this.createRequestId();
    const mutation = await this.database.mutate(connection => {
      const concurrentReplay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (concurrentReplay) return decodeResponse(concurrentReplay.response);
      const transactionActor = this.requests.requireActiveMember(
        connection,
        request.projectId,
        actorMemberId,
      );
      if (transactionActor.personalRef !== actor.personalRef) {
        throw serviceError('request-personal-ref-changed');
      }
      const ensured = this.requests.ensure(connection, {
        createdAt,
        description,
        firstBaseOid: validated.mainOid,
        headOid: request.headOid,
        memberId: actorMemberId,
        relations: this.resolveRelations(
          connection,
          parsed.references,
        ),
        requestId,
      });
      const response: EnsureMyRequestResponse = {
        mainOid: validated.mainOid,
        request: ensured.request,
      };
      if (ensured.change !== 'unchanged') {
        this.events.append(connection, {
          actorMemberId,
          createdAt,
          kind: `request.${ensured.change}`,
          payload: {
            headOid: request.headOid,
            memberId: actorMemberId,
            requestId: ensured.request.id,
          },
        });
      }
      const stored = this.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt,
        response,
      });
      return stored.status === 'existing' ? decodeResponse(stored.response) : response;
    });
    return mutation.value;
  }

  async updateMetadata(
    actorMemberId: CollabMemberId,
    request: UpdateMyRequestMetadataRequest,
  ): Promise<UpdateMyRequestMetadataResponse> {
    const description = normalizeDescription(request.description);
    const parsed = parseCollabTicketReferences(description);
    if (parsed.status === 'invalid') {
      throw new CollabError({
        code: parsed.reason === 'description-too-large'
          ? 'quota-exceeded'
          : 'protocol-payload-invalid',
        safeContext: { field: 'description' },
      });
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      description,
      expectedHeadOid: request.expectedHeadOid,
      expectedRequestRevision: request.expectedRequestRevision,
      projectId: request.projectId,
      requestId: request.requestId,
    })).digest('hex');
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'update-request-metadata' as const,
      requestFingerprint: fingerprint,
    };
    const initial = await this.database.read(connection => ({
      actor: this.requests.requireActiveMember(connection, request.projectId, actorMemberId),
      replay: this.idempotency.find<unknown>(connection, idempotencyInput),
    }));
    if (initial.replay) return decodeMetadataResponse(initial.replay.response);
    const updatedAt = this.now().toISOString();
    const mutation = await this.database.mutate(connection => {
      const replay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeMetadataResponse(replay.response);
      this.requests.requireActiveMember(connection, request.projectId, actorMemberId);
      const updated = this.requests.updateMetadata(connection, {
        actorMemberId,
        description,
        expectedHeadOid: request.expectedHeadOid,
        expectedRequestRevision: request.expectedRequestRevision,
        relations: this.resolveRelations(
          connection,
          parsed.references,
        ),
        requestId: request.requestId,
        updatedAt,
      });
      const response = { request: updated.request };
      if (updated.change !== 'unchanged') {
        this.events.append(connection, {
          actorMemberId,
          createdAt: updatedAt,
          kind: 'request.updated',
          payload: { memberId: actorMemberId, requestId: updated.request.id },
        });
      }
      const stored = this.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt: updatedAt,
        response,
      });
      return stored.status === 'existing'
        ? decodeMetadataResponse(stored.response)
        : response;
    });
    return mutation.value;
  }

  private resolveRelations(
    connection: AuthorityDatabaseConnection,
    references: readonly CollabParsedTicketReference[],
  ) {
    const tickets = this.tickets.findByNumbers(
      connection,
      references.map(reference => reference.ticketNumber),
    );
    const byNumber = new Map(tickets.map(ticket => [ticket.number, ticket]));
    const relations = [];
    for (const reference of references) {
      const ticket = byNumber.get(reference.ticketNumber);
      if (!ticket) {
        if (reference.kind === 'resolves') {
          throw new CollabError({
            code: 'resolving-ticket-reference-not-found',
            safeContext: { ticketNumber: reference.ticketNumber },
          });
        }
        continue;
      }
      relations.push({
        kind: reference.kind,
        relationId: this.createRelationId(),
        ticketId: ticket.id,
      });
    }
    if (relations.length > CLAUDIAN_COLLAB_LIMITS.maxRequestTicketRelations) {
      throw new CollabError({ code: 'quota-exceeded' });
    }
    return relations;
  }
}
