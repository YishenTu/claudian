import { createHash, randomUUID } from 'node:crypto';

import { type AcceptRequest, type AcceptResponse, COLLAB_MAIN_REF, type CollabMemberId, type CollabRequestTicketRelation, isCollabGitOid } from '@claudian-collab/protocol';

import {
  AcceptOperationRepository,
  type AuthorityAcceptOperation,
} from '@/app/collab/authority/AcceptOperationRepository';
import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { decodeAuthorityChangeRequest } from '@/app/collab/authority/RequestEnsureRepository';
import type { RequestEnsureDatabasePort } from '@/app/collab/authority/RequestEnsureService';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AcceptCoordinatorGitPort {
  commitTree(input: {
    readonly identity: { readonly email: string; readonly name: string };
    readonly message: string;
    readonly parents: readonly string[];
    readonly treeOid: string;
  }): Promise<string>;
  compareAndSwapRef(
    ref: string,
    nextOid: string,
    expectedOid: string,
  ): Promise<{ readonly currentOid: string | null; readonly updated: boolean }>;
  isAncestor(ancestorOid: string, descendantOid: string): Promise<boolean>;
  mergeTree(
    acceptedOid: string,
    memberOid: string,
  ): Promise<
    | { readonly kind: 'clean'; readonly treeOid: string }
    | { readonly kind: 'conflicting'; readonly treeOid: string | null }
  >;
  resolveRef(ref: string): Promise<string | null>;
  validateTree(treeishOid: string): Promise<void>;
}

export type AcceptCoordinatorFailurePoint =
  | 'after-prepared'
  | 'after-result-persisted'
  | 'after-ref-updated'
  | 'after-completed';

export interface AcceptCoordinatorOptions {
  readonly createOperationId?: () => string;
  readonly failAfter?: (point: AcceptCoordinatorFailurePoint) => void;
  readonly now?: () => Date;
}

const ACCEPT_IDENTITY = Object.freeze({
  email: 'collab@claudian.local',
  name: 'Claudian Collab',
});

function acceptError(
  code:
    | 'acceptance-recovery-required'
    | 'authority-integrity-error'
    | 'content-conflict'
    | 'stale-main'
    | 'stale-request-metadata'
    | 'stale-request-head',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'content-conflict'
      ? ['review-conflicts']
      : code === 'acceptance-recovery-required'
        ? ['open-diagnostics']
        : ['retry'],
    safeContext: { reason },
  });
}

function fingerprint(request: AcceptRequest): string {
  return createHash('sha256').update(JSON.stringify({
    expectedHeadOid: request.expectedHeadOid,
    expectedMainOid: request.expectedMainOid,
    expectedRequestRevision: request.expectedRequestRevision,
    expectedResolvingTickets: [...request.expectedResolvingTickets]
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId)),
    projectId: request.projectId,
    requestId: request.requestId,
  })).digest('hex');
}

function decodeStoredRelations(value: unknown): readonly CollabRequestTicketRelation[] {
  if (!Array.isArray(value)) {
    throw acceptError('authority-integrity-error', 'accept-ticket-relations-invalid');
  }
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw acceptError('authority-integrity-error', 'accept-ticket-relations-invalid');
    }
    const relation = entry as Readonly<Record<string, unknown>>;
    if (
      typeof relation.id !== 'string'
      || typeof relation.ticketId !== 'string'
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
      throw acceptError('authority-integrity-error', 'accept-ticket-relations-invalid');
    }
    return relation as unknown as CollabRequestTicketRelation;
  });
}

function decodeResponse(value: unknown): AcceptResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw acceptError('authority-integrity-error', 'accept-idempotency-response-invalid');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const request = source.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw acceptError('authority-integrity-error', 'accept-idempotency-response-invalid');
  }
  const record = request as Readonly<Record<string, unknown>>;
  const mainOid = source.mainOid;
  const mergeCommitOid = source.mergeCommitOid;
  if (
    typeof mainOid !== 'string'
    || !isCollabGitOid(mainOid)
    || typeof mergeCommitOid !== 'string'
    || mainOid !== mergeCommitOid
  ) {
    throw acceptError('authority-integrity-error', 'accept-idempotency-response-invalid');
  }
    const decodedRequest = decodeAuthorityChangeRequest({
    ...record,
    comment_count: record.commentCount,
    created_at: record.createdAt,
    first_base_oid: record.firstBaseOid,
    latest_head_oid: record.latestHeadOid,
    member_id: record.memberId,
    merged_oid: record.mergedOid ?? null,
    request_id: record.id,
    revision: record.revision,
    updated_at: record.updatedAt,
  }, decodeStoredRelations(record.ticketRelations));
  if (decodedRequest.status !== 'merged' || decodedRequest.mergedOid !== mainOid) {
    throw acceptError('authority-integrity-error', 'accept-idempotency-response-invalid');
  }
  return {
    mainOid,
    mergeCommitOid,
    request: decodedRequest,
  };
}

export class AcceptCoordinator {
  private blockedError: CollabError | null = null;
  private readonly createOperationId: () => string;
  private readonly events = new AuthorityEventRepository();
  private readonly failAfter?: (point: AcceptCoordinatorFailurePoint) => void;
  private readonly idempotency = new AuthorityIdempotencyRepository();
  private readonly now: () => Date;
  private readonly operations = new AcceptOperationRepository();
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly database: RequestEnsureDatabasePort,
    private readonly git: AcceptCoordinatorGitPort,
    options: AcceptCoordinatorOptions = {},
  ) {
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.failAfter = options.failAfter;
    this.now = options.now ?? (() => new Date());
  }

  accept(
    actorMemberId: CollabMemberId,
    request: AcceptRequest,
  ): Promise<AcceptResponse> {
    return this.operationQueue.run(() => this.acceptUnlocked(actorMemberId, request));
  }

  recover(): Promise<void> {
    return this.operationQueue.run(async () => {
      this.assertAvailable();
      const operation = await this.database.read(connection => (
        this.operations.findIncomplete(connection)
      ));
      if (operation) {
        await this.recoverOperation(operation);
      }
    });
  }

  private async acceptUnlocked(
    actorMemberId: CollabMemberId,
    request: AcceptRequest,
  ): Promise<AcceptResponse> {
    this.assertAvailable();
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'accept' as const,
      requestFingerprint: fingerprint(request),
    };
    const initial = await this.database.read(connection => {
      this.operations.requireActiveMember(connection, request.projectId, actorMemberId);
      const replay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return { incomplete: null, replay };
      this.operations.requireManager(connection, request.projectId, actorMemberId);
      return {
        incomplete: this.operations.findIncomplete(connection),
        replay: null,
      };
    });
    if (initial.replay) return decodeResponse(initial.replay.response);
    if (initial.incomplete) {
      await this.recoverOperation(initial.incomplete);
      const replay = await this.database.read(connection => {
        this.operations.requireActiveMember(connection, request.projectId, actorMemberId);
        const recoveredReplay = this.idempotency.find<unknown>(connection, idempotencyInput);
        if (recoveredReplay) return recoveredReplay;
        this.operations.requireManager(connection, request.projectId, actorMemberId);
        return null;
      });
      if (replay) return decodeResponse(replay.response);
    }

    const context = await this.database.read(connection => {
      this.operations.requireManager(connection, request.projectId, actorMemberId);
      const loaded = this.operations.loadOpenRequest(connection, request.requestId);
      if (loaded.request.latestHeadOid !== request.expectedHeadOid) {
        throw acceptError('stale-request-head', 'accept-expected-head-mismatch');
      }
      if (loaded.request.revision !== request.expectedRequestRevision) {
        throw acceptError('stale-request-metadata', 'accept-request-revision-mismatch');
      }
      this.operations.validateResolvingTickets(
        connection,
        loaded.request,
        request.expectedResolvingTickets,
      );
      return loaded;
    });
    const [mainOid, personalOid] = await Promise.all([
      this.git.resolveRef(COLLAB_MAIN_REF),
      this.git.resolveRef(context.personalRef),
    ]);
    if (personalOid !== request.expectedHeadOid) {
      throw acceptError('stale-request-head', 'accept-personal-ref-mismatch');
    }
    if (mainOid !== request.expectedMainOid) {
      throw acceptError('stale-main', 'accept-main-mismatch');
    }
    for (const relation of context.request.ticketRelations) {
      if (!await this.git.isAncestor(relation.commitOid, request.expectedHeadOid)) {
        throw acceptError(
          'stale-request-metadata',
          'accept-ticket-relation-commit-not-contained',
        );
      }
    }
    if (await this.git.isAncestor(request.expectedHeadOid, mainOid)) {
      const [revalidatedMainOid, revalidatedPersonalOid] = await Promise.all([
        this.git.resolveRef(COLLAB_MAIN_REF),
        this.git.resolveRef(context.personalRef),
      ]);
      if (revalidatedMainOid !== request.expectedMainOid) {
        throw acceptError('stale-main', 'accept-contained-main-raced');
      }
      if (revalidatedPersonalOid !== request.expectedHeadOid) {
        throw acceptError('stale-request-head', 'accept-contained-personal-ref-raced');
      }
      return this.completeContained(actorMemberId, request, mainOid, idempotencyInput);
    }
    const merge = await this.git.mergeTree(mainOid, request.expectedHeadOid);
    if (merge.kind === 'conflicting') {
      throw acceptError('content-conflict', 'accept-merge-conflicting');
    }
    await this.git.validateTree(merge.treeOid);
    const [revalidatedMainOid, revalidatedPersonalOid] = await Promise.all([
      this.git.resolveRef(COLLAB_MAIN_REF),
      this.git.resolveRef(context.personalRef),
    ]);
    if (revalidatedMainOid !== request.expectedMainOid) {
      throw acceptError('stale-main', 'accept-main-raced-before-prepare');
    }
    if (revalidatedPersonalOid !== request.expectedHeadOid) {
      throw acceptError('stale-request-head', 'accept-personal-ref-raced-before-prepare');
    }

    const createdAt = this.now().toISOString();
    const prepared = (await this.database.mutate<
      | { readonly kind: 'operation'; readonly operation: AuthorityAcceptOperation }
      | { readonly kind: 'replay'; readonly response: AcceptResponse }
    >(connection => {
      this.operations.requireActiveMember(connection, request.projectId, actorMemberId);
      const concurrentReplay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (concurrentReplay) {
        return { kind: 'replay', response: decodeResponse(concurrentReplay.response) };
      }
      this.operations.requireManager(connection, request.projectId, actorMemberId);
      return {
        kind: 'operation',
        operation: this.operations.prepare(connection, {
          completionActorMemberId: actorMemberId,
          createdAt,
          expectedHeadOid: request.expectedHeadOid,
          expectedMainOid: request.expectedMainOid,
          expectedRequestRevision: request.expectedRequestRevision,
          expectedResolvingTickets: request.expectedResolvingTickets,
          idempotencyKey: request.idempotencyKey,
          operationId: this.createOperationId(),
          requestId: request.requestId,
        }),
      };
    })).value;
    if (prepared.kind === 'replay') return prepared.response;
    this.failAfter?.('after-prepared');

    const resultCommitOid = await this.git.commitTree({
      identity: ACCEPT_IDENTITY,
      message: `Accept request ${request.requestId}`,
      parents: [request.expectedMainOid, request.expectedHeadOid],
      treeOid: merge.treeOid,
    });
    const persisted = (await this.database.mutate(connection => (
      this.operations.persistResult(
        connection,
        prepared.operation.operationId,
        resultCommitOid,
        this.now().toISOString(),
      )
    ))).value;
    this.failAfter?.('after-result-persisted');
    await this.updateMainOrBlock(persisted);
    this.failAfter?.('after-ref-updated');
    const response = await this.finalize(persisted);
    this.failAfter?.('after-completed');
    return response;
  }

  private async completeContained(
    actorMemberId: CollabMemberId,
    request: AcceptRequest,
    mainOid: string,
    idempotencyInput: {
      readonly actorMemberId: CollabMemberId;
      readonly key: string;
      readonly operationKind: 'accept';
      readonly requestFingerprint: string;
    },
  ): Promise<AcceptResponse> {
    const createdAt = this.now().toISOString();
    return (await this.database.mutate(connection => {
      this.operations.requireActiveMember(connection, request.projectId, actorMemberId);
      const replay = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (replay) return decodeResponse(replay.response);
      this.operations.requireManager(connection, request.projectId, actorMemberId);
      const operation = this.operations.insertCompleted(connection, {
        completionActorMemberId: actorMemberId,
        createdAt,
        expectedHeadOid: request.expectedHeadOid,
        expectedMainOid: request.expectedMainOid,
        expectedRequestRevision: request.expectedRequestRevision,
        expectedResolvingTickets: request.expectedResolvingTickets,
        idempotencyKey: request.idempotencyKey,
        operationId: this.createOperationId(),
        requestId: request.requestId,
        resultCommitOid: mainOid,
      });
      return this.finalizeInConnection(
        connection,
        operation,
        idempotencyInput,
      );
    })).value;
  }

  private async recoverOperation(
    initial: AuthorityAcceptOperation,
  ): Promise<AcceptResponse> {
    let operation = initial;
    if (operation.state === 'prepared') {
      let context;
      try {
        context = await this.database.read(connection => (
          this.operations.loadOpenRequest(connection, operation.requestId)
        ));
      } catch (error) {
        if (
          error instanceof CollabError
          && [
            'authority-integrity-error',
            'authorization-denied',
            'request-not-open',
          ].includes(error.code)
        ) {
          throw this.block(`accept-preparation-${error.code}`);
        }
        throw error;
      }
      const mainOid = await this.git.resolveRef(COLLAB_MAIN_REF);
      if (
        mainOid !== operation.expectedMainOid
        || context.request.latestHeadOid !== operation.expectedHeadOid
      ) {
        throw this.block('accept-prepared-state-diverged');
      }
      try {
        await this.database.read(connection => this.operations.validateResolvingTickets(
          connection,
          context.request,
          operation.expectedResolvingTickets,
        ));
      } catch (error) {
        if (
          error instanceof CollabError
          && (error.code === 'stale-request-metadata' || error.code === 'stale-ticket')
        ) {
          throw this.block(`accept-preparation-${error.code}`);
        }
        throw error;
      }
      const merge = await this.git.mergeTree(
        operation.expectedMainOid,
        operation.expectedHeadOid,
      );
      if (merge.kind === 'conflicting') {
        throw this.block('accept-prepared-merge-conflicting');
      }
      try {
        await this.git.validateTree(merge.treeOid);
      } catch {
        throw this.block('accept-prepared-tree-invalid');
      }
      const resultCommitOid = await this.git.commitTree({
        identity: ACCEPT_IDENTITY,
        message: `Accept request ${operation.requestId}`,
        parents: [operation.expectedMainOid, operation.expectedHeadOid],
        treeOid: merge.treeOid,
      });
      operation = (await this.database.mutate(connection => (
        this.operations.persistResult(
          connection,
          operation.operationId,
          resultCommitOid,
          this.now().toISOString(),
        )
      ))).value;
    }
    await this.updateMainOrBlock(operation);
    return this.finalize(operation);
  }

  private async updateMainOrBlock(operation: AuthorityAcceptOperation): Promise<void> {
    const resultCommitOid = operation.resultCommitOid;
    if (!resultCommitOid) throw this.block('accept-recovery-result-missing');
    try {
      await this.git.validateTree(resultCommitOid);
    } catch {
      throw this.block('accept-result-tree-invalid');
    }
    const mainOid = await this.git.resolveRef(COLLAB_MAIN_REF);
    if (mainOid === resultCommitOid) return;
    if (mainOid !== operation.expectedMainOid) {
      throw this.block('accept-main-unexpected');
    }
    const updated = await this.git.compareAndSwapRef(
      COLLAB_MAIN_REF,
      resultCommitOid,
      operation.expectedMainOid,
    );
    if (!updated.updated && updated.currentOid !== resultCommitOid) {
      throw this.block('accept-main-cas-raced');
    }
  }

  private async finalize(
    operation: AuthorityAcceptOperation,
  ): Promise<AcceptResponse> {
    try {
      const actorMemberId = operation.completionActorMemberId;
      if (actorMemberId === null) {
        throw acceptError('authority-integrity-error', 'accept-completion-actor-missing');
      }
      const projectId = await this.database.read(connection => (
        this.operations.currentProjectId(connection)
      ));
      const idempotencyInput = {
        actorMemberId,
        key: operation.idempotencyKey,
        operationKind: 'accept' as const,
        requestFingerprint: fingerprint({
          expectedHeadOid: operation.expectedHeadOid,
          expectedMainOid: operation.expectedMainOid,
          expectedRequestRevision: operation.expectedRequestRevision,
          expectedResolvingTickets: operation.expectedResolvingTickets,
          idempotencyKey: operation.idempotencyKey,
          projectId,
          requestId: operation.requestId,
        }),
      };
      return (await this.database.mutate(connection => this.finalizeInConnection(
        connection,
        operation,
        idempotencyInput,
      ))).value;
    } catch (error) {
      if (
        error instanceof CollabError
        && [
          'authority-integrity-error',
          'authorization-denied',
          'idempotency-conflict',
          'quota-exceeded',
          'request-not-open',
          'stale-request-metadata',
          'stale-ticket',
          'stale-request-head',
        ].includes(error.code)
      ) {
        throw this.block(`accept-finalization-${error.code}`);
      }
      throw error;
    }
  }

  private finalizeInConnection(
    connection: Parameters<Parameters<RequestEnsureDatabasePort['mutate']>[0]>[0],
    operation: AuthorityAcceptOperation,
    idempotencyInput: {
      readonly actorMemberId: CollabMemberId;
      readonly key: string;
      readonly operationKind: 'accept';
      readonly requestFingerprint: string;
    },
  ): AcceptResponse {
    const actorMemberId = operation.completionActorMemberId;
    if (actorMemberId === null || idempotencyInput.actorMemberId !== actorMemberId) {
      throw acceptError('authority-integrity-error', 'accept-completion-actor-mismatch');
    }
    const replay = this.idempotency.find<unknown>(connection, idempotencyInput);
    if (replay) return decodeResponse(replay.response);
    const finalizedAt = this.now().toISOString();
    const request = this.operations.finalizeRequest(
      connection,
      operation,
      finalizedAt,
    );
    const mainOid = operation.resultCommitOid!;
    const response: AcceptResponse = {
      mainOid,
      mergeCommitOid: mainOid,
      request,
    };
    this.events.append(connection, {
      actorMemberId,
      createdAt: finalizedAt,
      kind: 'request.accepted',
      payload: { requestId: operation.requestId },
    });
    for (const expectation of operation.expectedResolvingTickets) {
      this.events.append(connection, {
        actorMemberId,
        createdAt: finalizedAt,
        kind: 'ticket.closed',
        payload: { requestId: operation.requestId, ticketId: expectation.ticketId },
      });
    }
    return this.idempotency.store(connection, {
      ...idempotencyInput,
      createdAt: finalizedAt,
      response,
    }).response;
  }

  private block(reason: string): CollabError {
    const error = acceptError('acceptance-recovery-required', reason);
    this.blockedError = error;
    return error;
  }

  private assertAvailable(): void {
    if (this.blockedError) throw this.blockedError;
  }

}
