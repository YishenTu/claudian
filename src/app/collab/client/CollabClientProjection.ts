import { randomUUID } from 'node:crypto';

import { type AcceptResponse, COLLAB_LIMITS, type CollabComment, type CollabCommentPage, type CollabRequestDetail, type CollabResolvingTicketExpectation, type CollabTicketAcceptedRelationPage, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketPage, isCollabOpaqueId } from '@claudian-collab/protocol';

import {
  type CollabProjectResource,
  CollabProjectWorkSessionRegistry,
} from '@/app/collab/activity/CollabProjectWorkSession';
import {
  ProjectEventClient,
  type ProjectEventClientInput,
  type ProjectEventInvalidation,
} from '@/app/collab/client/ProjectEventClient';
import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectDocumentBase,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { decodeCloudProjectSnapshotCache } from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import type { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import type {
  CollabManagerResponsibilityOfferSummary,
  CollabProjectSnapshot,
} from '@/core/collab';
import { isCollabLanProjectSnapshot } from '@/core/collab';
import { type CollabCoordinationSnapshot, type CollabListTicketsRequest, type CollabOperationOptions, type CollabTicketDetailProjection, type CollabTicketPageProjection } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CACHE_SCHEMA_VERSION = 4 as const;
const OBSOLETE_CACHE_SCHEMA_VERSIONS = new Set<unknown>([2, 3]);
const MAX_CACHED_TICKET_PAGES = 16;
const MAX_CACHED_TICKET_DETAILS = 32;

interface CachedTicketPage {
  readonly cachedAt: string;
  readonly key: string;
  readonly page: CollabTicketPage;
}

interface CachedTicketDetail {
  readonly cachedAt: string;
  readonly detail: CollabTicketDetail;
  readonly ticketId: string;
}

interface CollabSnapshotCache extends CollabLocalProjectDocumentBase {
  readonly cachedAt: string;
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly snapshot: CollabProjectSnapshot;
  readonly ticketDetails: readonly CachedTicketDetail[];
  readonly ticketPages: readonly CachedTicketPage[];
}

interface ObsoleteCollabSnapshotCache extends CollabLocalProjectDocumentBase {
  readonly schemaVersion: 2 | 3;
}

type DecodedCollabSnapshotCache = CollabSnapshotCache | ObsoleteCollabSnapshotCache;

export interface CollabClientProjectionStore {
  loadMembership(projectId: string): Promise<CollabLocalMembershipRecord | null>;
  loadProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: string,
    kind: 'cache',
    decode: (value: unknown) => T,
  ): Promise<T | null>;
  saveProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: string,
    kind: 'cache',
    document: T,
  ): Promise<void>;
  removeProjectDocument(projectId: string, kind: 'cache'): Promise<boolean>;
  updateMembershipProjection(
    projectId: string,
    memberId: string,
    role: CollabLocalMembershipRecord['member']['role'],
    sequence: number,
  ): Promise<CollabLocalMembershipRecord>;
}

export type CollabClientProjectionControlPort = CollabAuthorityControlPort;

export interface CollabClientCommentInput {
  readonly body: string;
  readonly idempotencyKey?: string;
  readonly projectId: string;
  readonly requestId: string;
}

export interface CollabClientProjectionEventPort {
  dispose(): void;
  start(): void;
}

export type CollabClientProjectionEventFactory = (
  input: ProjectEventClientInput,
  onInvalidation: (invalidation: ProjectEventInvalidation) => Promise<number>,
) => CollabClientProjectionEventPort;

interface CollabClientProjectionBaseOptions {
  readonly authoritySessions?: CollabAuthoritySessionFactory;
  readonly createEventClient?: CollabClientProjectionEventFactory;
  readonly managerResponsibility?: CollabManagerResponsibilityProjectionPort;
  readonly now?: () => Date;
  readonly sessions?: CollabProjectWorkSessionRegistry;
}

export type CollabClientProjectionOptions = CollabClientProjectionBaseOptions & (
  | {
      readonly retirement?: undefined;
      readonly retirementAdmission?: undefined;
    }
  | {
      readonly retirement: Pick<RetirementClientHandler, 'handle'>;
      readonly retirementAdmission: CollabClientRetirementAdmission;
    }
);

export type CollabClientRetirementAdmission = (
  projectId: string,
  operation: () => Promise<void>,
) => Promise<void>;

export interface CollabManagerResponsibilityProjectionPort {
  reconcileSnapshot(
    snapshot: CollabProjectSnapshot,
  ): Promise<CollabManagerResponsibilityOfferSummary | null>;
}

interface ProjectionEventSession {
  readonly client: CollabProjectResource;
  readonly listeners: Set<(snapshot: CollabProjectSnapshot) => void>;
  dispose(): void;
}

function projectionError(
  code: 'cancelled' | 'host-stopped' | 'project-not-found',
  reason: string,
): CollabError {
  return new CollabError({ code, safeContext: { reason } });
}

function decodeCache(value: unknown): DecodedCollabSnapshotCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Collab snapshot cache');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const projectId = source.projectId;
  if (
    OBSOLETE_CACHE_SCHEMA_VERSIONS.has(source.schemaVersion)
    && typeof projectId === 'string'
  ) {
    return { projectId, schemaVersion: source.schemaVersion as 2 | 3 };
  }
  const cachedAt = source.cachedAt;
  if (
    source.schemaVersion !== CACHE_SCHEMA_VERSION
    || typeof projectId !== 'string'
    || typeof cachedAt !== 'string'
    || Number.isNaN(Date.parse(cachedAt))
    || new Date(cachedAt).toISOString() !== cachedAt
  ) {
    throw new TypeError('Invalid Collab snapshot cache');
  }
  const snapshotProject = source.snapshot && typeof source.snapshot === 'object'
    && !Array.isArray(source.snapshot)
    ? (source.snapshot as Readonly<Record<string, unknown>>).project
    : undefined;
  const authorityKind = snapshotProject && typeof snapshotProject === 'object'
    && !Array.isArray(snapshotProject)
    ? (snapshotProject as Readonly<Record<string, unknown>>).authorityKind
    : undefined;
  const snapshot = authorityKind === 'cloud'
    ? decodeCloudProjectSnapshotCache(source.snapshot)
    : lanCollabControlOperationCodec('getSnapshot').decodeResponse({
      data: source.snapshot,
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      requestId: 'cache-decode',
    });
  if (snapshot.project.id !== projectId) {
    throw new TypeError('Invalid Collab snapshot cache');
  }
  if (!Array.isArray(source.ticketPages) || !Array.isArray(source.ticketDetails)) {
    throw new TypeError('Invalid Collab Ticket cache');
  }
  const ticketPages = source.ticketPages.map(decodeCachedTicketPage);
  const ticketDetails = source.ticketDetails.map(decodeCachedTicketDetail);
  if (
    ticketPages.length > MAX_CACHED_TICKET_PAGES
    || ticketDetails.length > MAX_CACHED_TICKET_DETAILS
    || new Set(ticketPages.map(entry => entry.key)).size !== ticketPages.length
    || new Set(ticketDetails.map(entry => entry.ticketId)).size !== ticketDetails.length
  ) {
    throw new TypeError('Invalid Collab Ticket cache');
  }
  return {
    cachedAt,
    projectId,
    schemaVersion: CACHE_SCHEMA_VERSION,
    snapshot,
    ticketDetails,
    ticketPages,
  };
}

function decodeCachedTicketPage(value: unknown): CachedTicketPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid cached Ticket page');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const cachedAt = cacheTimestamp(source.cachedAt);
  if (typeof source.key !== 'string' || source.key.length > 1_024) {
    throw new TypeError('Invalid cached Ticket page');
  }
  return {
    cachedAt,
    key: source.key,
    page: lanCollabControlOperationCodec('listTickets').decodeResponse(cacheEnvelope(source.page)),
  };
}

function decodeCachedTicketDetail(value: unknown): CachedTicketDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid cached Ticket detail');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const cachedAt = cacheTimestamp(source.cachedAt);
  if (typeof source.ticketId !== 'string') {
    throw new TypeError('Invalid cached Ticket detail');
  }
  if (!source.detail || typeof source.detail !== 'object' || Array.isArray(source.detail)) {
    throw new TypeError('Invalid cached Ticket detail');
  }
  const rawDetail = source.detail as Readonly<Record<string, unknown>>;
  if (
    !rawDetail.comments
    || typeof rawDetail.comments !== 'object'
    || Array.isArray(rawDetail.comments)
    || !rawDetail.acceptedRelations
    || typeof rawDetail.acceptedRelations !== 'object'
    || Array.isArray(rawDetail.acceptedRelations)
  ) {
    throw new TypeError('Invalid cached Ticket collections');
  }
  const rawCommentsPage = rawDetail.comments as Readonly<Record<string, unknown>>;
  const rawRelationsPage = rawDetail.acceptedRelations as Readonly<Record<string, unknown>>;
  const rawComments = rawCommentsPage.comments;
  const rawRelations = rawRelationsPage.acceptedRelations;
  if (
    rawCommentsPage.nextCursor !== undefined
    || rawRelationsPage.nextCursor !== undefined
    || !Array.isArray(rawComments)
    || rawComments.length > COLLAB_LIMITS.maxTicketComments
    || !Array.isArray(rawRelations)
    || rawRelations.length > COLLAB_LIMITS.maxTicketAcceptedRelations
  ) {
    throw new TypeError('Invalid cached Ticket collections');
  }
  const detail = lanCollabControlOperationCodec('getTicket').decodeResponse(cacheEnvelope({
    ...rawDetail,
    acceptedRelations: { acceptedRelations: [] },
    comments: { comments: [] },
  }));
  const comments = rawComments.flatMap((_item, index) => {
    if (index % COLLAB_LIMITS.maxCommentPageSize !== 0) return [];
    return lanCollabControlOperationCodec('listTicketComments').decodeResponse(cacheEnvelope({
      comments: rawComments.slice(index, index + COLLAB_LIMITS.maxCommentPageSize),
    })).comments;
  });
  const acceptedRelations = rawRelations.flatMap((_item, index) => {
    if (index % COLLAB_LIMITS.maxRelationsPerPage !== 0) return [];
    return lanCollabControlOperationCodec('listTicketAcceptedRelations')
      .decodeResponse(cacheEnvelope({
        acceptedRelations: rawRelations.slice(index, index + COLLAB_LIMITS.maxRelationsPerPage),
      })).acceptedRelations;
  });
  if (
    detail.ticket.id !== source.ticketId
    || comments.length !== detail.ticket.commentCount
    || acceptedRelations.length !== detail.ticket.acceptedRelationCount
    || comments.some(comment => comment.ticketId !== detail.ticket.id)
  ) {
    throw new TypeError('Invalid cached Ticket detail');
  }
  return {
    cachedAt,
    detail: {
      ...detail,
      acceptedRelations: { acceptedRelations },
      comments: { comments },
    },
    ticketId: source.ticketId,
  };
}

function cacheEnvelope(data: unknown): unknown {
  return {
    data,
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    requestId: 'cache-decode',
  };
}

function cacheTimestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Invalid Collab cache timestamp');
  }
  return value;
}

function ticketPageKey(request: CollabListTicketsRequest): string {
  return JSON.stringify([
    request.status,
    request.cursor ?? null,
    request.limit ?? null,
  ]);
}

function canUseCache(error: CollabError): boolean {
  return error.code === 'offline'
    || error.code === 'host-stopped'
    || error.code === 'endpoint-unreachable'
    || error.code === 'local-network-permission-required'
    || error.code === 'operation-timeout';
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw projectionError('cancelled', 'projection-read-cancelled');
  }
}

function retirementResultFromError(
  projectId: string,
  error: unknown,
): {
  readonly projectId: string;
  readonly retiredAt: string;
  readonly retirementId?: string;
} | null {
  if (!(error instanceof CollabError) || error.code !== 'project-retired') return null;
  const contextProjectId = error.safeContext.projectId;
  const retiredAt = error.safeContext.retiredAt;
  const retirementId = error.safeContext.operationId;
  if (
    contextProjectId !== projectId
    || typeof retiredAt !== 'string'
    || Number.isNaN(Date.parse(retiredAt))
    || new Date(retiredAt).toISOString() !== retiredAt
    || (retirementId !== undefined && (
      typeof retirementId !== 'string'
      || !isCollabOpaqueId(retirementId)
    ))
  ) {
    throw new CollabError({
      code: 'authority-integrity-error',
      safeContext: { reason: 'retirement-terminal-result-invalid' },
    });
  }
  return {
    projectId,
    retiredAt,
    ...(retirementId === undefined ? {} : { retirementId }),
  };
}

export class CollabClientProjection {
   readonly #createEventClient: CollabClientProjectionEventFactory;
   readonly #authoritySessions?: CollabAuthoritySessionFactory;
  private disposed = false;
  private readonly managerResponsibility?: CollabManagerResponsibilityProjectionPort;
  private readonly now: () => Date;
   readonly #ownsSessions: boolean;
  private readonly retirement?: Pick<RetirementClientHandler, 'handle'>;
  private readonly retirementAdmission?: CollabClientRetirementAdmission;
  private readonly sessions: CollabProjectWorkSessionRegistry;

  constructor(
    private readonly store: CollabClientProjectionStore,
    private readonly control: CollabClientProjectionControlPort,
    options: CollabClientProjectionOptions = {},
  ) {
    this.#authoritySessions = options.authoritySessions;
    this.#createEventClient = options.createEventClient
      ?? ((input, onInvalidation) => new ProjectEventClient(input, onInvalidation));
    this.managerResponsibility = options.managerResponsibility;
    this.now = options.now ?? (() => new Date());
    this.#ownsSessions = options.sessions === undefined;
    this.retirement = options.retirement;
    this.retirementAdmission = options.retirementAdmission;
    this.sessions = options.sessions ?? new CollabProjectWorkSessionRegistry();
  }

  async readSnapshot(
    projectId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabCoordinationSnapshot> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    try {
      const snapshot = await this.#readOnlineCoalesced(projectId);
      throwIfCancelled(options.signal);
      return {
        snapshot,
        source: 'online',
        stale: false,
        syncState: {
          eventSequence: snapshot.eventSequence,
          generation: this.#projectGeneration(projectId),
          projectId,
          status: 'synchronized',
        },
      };
    } catch (error) {
      throwIfCancelled(options.signal);
      const collabError = error instanceof CollabError ? error : null;
      if (!collabError || !canUseCache(collabError)) throw error;
      const cached = await this.#loadCache(projectId);
      if (!cached) throw error;
      return {
        snapshot: cached.snapshot,
        source: 'cache',
        stale: true,
        syncState: {
          eventSequence: cached.snapshot.eventSequence,
          generation: this.#projectGeneration(projectId),
          projectId,
          status: 'offline',
        },
      };
    }
  }

  async listTickets(
    request: CollabListTicketsRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketPageProjection> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const generation = this.#projectGeneration(request.projectId);
    const key = ticketPageKey(request);
    try {
      const page = await this.#runWithRetirementFallback(
        request.projectId,
        () => this.control.listTickets(request, options),
      );
      throwIfCancelled(options.signal);
      this.#assertProjectGeneration(request.projectId, generation);
      await this.#updateTicketCache(request.projectId, cache => {
        if (!cache) return null;
        const entry = { cachedAt: this.now().toISOString(), key, page };
        return {
          ...cache,
          ticketPages: [
            entry,
            ...cache.ticketPages.filter(candidate => candidate.key !== key),
          ].slice(0, MAX_CACHED_TICKET_PAGES),
        };
      }).catch(() => undefined);
      return { page, source: 'online', stale: false };
    } catch (error) {
      throwIfCancelled(options.signal);
      const collabError = error instanceof CollabError ? error : null;
      if (!collabError || !canUseCache(collabError)) throw error;
      const cache = await this.#loadCache(request.projectId);
      throwIfCancelled(options.signal);
      const page = cache?.ticketPages.find(entry => entry.key === key)?.page;
      if (!page) throw error;
      return { page, source: 'cache', stale: true };
    }
  }

  async readTicket(
    projectId: string,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketDetailProjection> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const generation = this.#projectGeneration(projectId);
    try {
      const detail = await this.#runWithRetirementFallback(
        projectId,
        () => this.control.readTicket(projectId, ticketId, options),
      );
      throwIfCancelled(options.signal);
      this.#assertProjectGeneration(projectId, generation);
      if (detail.ticket.id !== ticketId) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'projection-ticket-detail-mismatch' },
        });
      }
      await this.#updateTicketCache(projectId, cache => {
        if (!cache) return null;
        const entry = { cachedAt: this.now().toISOString(), detail, ticketId };
        return {
          ...cache,
          ticketDetails: [
            entry,
            ...cache.ticketDetails.filter(candidate => candidate.ticketId !== ticketId),
          ].slice(0, MAX_CACHED_TICKET_DETAILS),
        };
      }).catch(() => undefined);
      return { detail, source: 'online', stale: false };
    } catch (error) {
      throwIfCancelled(options.signal);
      const collabError = error instanceof CollabError ? error : null;
      if (!collabError || !canUseCache(collabError)) throw error;
      const cache = await this.#loadCache(projectId);
      throwIfCancelled(options.signal);
      const detail = cache?.ticketDetails.find(entry => entry.ticketId === ticketId)?.detail;
      if (!detail) throw error;
      return { detail, source: 'cache', stale: true };
    }
  }

  async readTicketPage(
    projectId: string,
    ticketId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketDetailProjection> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const detail = await this.#runWithRetirementFallback(
      projectId,
      () => this.control.readTicketPage(projectId, ticketId, options),
    );
    throwIfCancelled(options.signal);
    if (detail.ticket.id !== ticketId) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'projection-ticket-detail-mismatch' },
      });
    }
    return { detail, source: 'online', stale: false };
  }

  async readRequest(
    projectId: string,
    requestId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabRequestDetail> {
    this.#assertOpen();
    return this.#runWithRetirementFallback(
      projectId,
      () => this.control.readRequest(projectId, requestId, options),
    );
  }

  async listRequestComments(
    projectId: string,
    requestId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabCommentPage> {
    this.#assertOpen();
    return this.#runWithRetirementFallback(
      projectId,
      () => this.control.listRequestComments(projectId, requestId, query, options),
    );
  }

  async listTicketComments(
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketCommentPage> {
    this.#assertOpen();
    return this.#runWithRetirementFallback(
      projectId,
      () => this.control.listTicketComments(projectId, ticketId, query, options),
    );
  }

  async listTicketAcceptedRelations(
    projectId: string,
    ticketId: string,
    query: { readonly cursor?: string; readonly limit?: number },
    options: CollabOperationOptions = {},
  ): Promise<CollabTicketAcceptedRelationPage> {
    this.#assertOpen();
    return this.#runWithRetirementFallback(
      projectId,
      () => this.control.listTicketAcceptedRelations(projectId, ticketId, query, options),
    );
  }

  async addComment(
    input: CollabClientCommentInput,
    options: CollabOperationOptions = {},
  ): Promise<CollabComment> {
    this.#assertOpen();
    const response = await this.#runWithRetirementFallback(
      input.projectId,
      () => this.control.createComment({
        body: input.body,
        idempotencyKey: input.idempotencyKey
          ?? `comment-${randomUUID().replaceAll('-', '')}`,
        projectId: input.projectId,
        requestId: input.requestId,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    return response.comment;
  }

  async acceptRequest(
    projectId: string,
    requestId: string,
    expectedMainOid: string,
    expectedHeadOid: string,
    expectedRequestRevision: number,
    expectedResolvingTickets: readonly CollabResolvingTicketExpectation[],
    options: CollabOperationOptions = {},
    idempotencyKey?: string,
  ): Promise<AcceptResponse> {
    this.#assertOpen();
    return this.#runWithRetirementFallback(
      projectId,
      () => this.control.acceptRequest({
        expectedHeadOid,
        expectedMainOid,
        expectedRequestRevision,
        expectedResolvingTickets,
        idempotencyKey: idempotencyKey ?? `accept-${randomUUID().replaceAll('-', '')}`,
        projectId,
        requestId,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
  }

  async subscribe(
    projectId: string,
    listener: (snapshot: CollabProjectSnapshot) => void,
  ): Promise<{ dispose(): void }> {
    this.#assertOpen();
    const work = this.sessions.acquire(projectId);
    let session = work.getEventConnection<ProjectionEventSession>();
    if (!session) {
      const generation = work.generation;
      const membership = await this.store.loadMembership(projectId);
      this.#assertOpen();
      work.assertGeneration(generation);
      if (!membership) {
        throw projectionError('project-not-found', 'projection-membership-missing');
      }
      const listeners = new Set<(snapshot: CollabProjectSnapshot) => void>();
      let client: CollabProjectResource;
      if (this.#authoritySessions) {
        const authority = await work.ensureAuthoritySession<CollabAuthoritySession>(
          () => this.#authoritySessions!.create(membership),
        );
        this.#assertOpen();
        work.assertGeneration(generation);
        client = authority.events.connect({
          afterSequence: membership.lastEventSequence,
          onInvalidation: invalidation => this.#refreshFromEvent(projectId, invalidation),
        });
      } else {
        if (!isCollabLocalLanMembership(membership)) {
          throw projectionError('host-stopped', 'projection-authority-session-unavailable');
        }
        const endpoint = membership.authority.endpoint;
        const caCertificatePem = membership.authority.hostCaCertificatePem;
        if (!endpoint || !caCertificatePem) {
          throw projectionError('host-stopped', 'projection-host-endpoint-unavailable');
        }
        const lanClient = this.#createEventClient({
          caCertificatePem,
          endpoint,
          lastSequence: membership.lastEventSequence,
          memberCredential: membership.member.credential,
          projectId,
        }, invalidation => this.#refreshFromEvent(projectId, invalidation));
        lanClient.start();
        client = lanClient;
      }
      session = { client, dispose: () => client.dispose(), listeners };
      work.adoptEventConnection(session, generation);
    }
    session.listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = work.getEventConnection<ProjectionEventSession>();
        current?.listeners.delete(listener);
        if (current && current.listeners.size === 0) {
          work.clearEventConnection(current);
        }
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.#ownsSessions) void this.sessions.close();
  }

  async closeProject(projectId: string): Promise<void> {
    this.resetProjectConnection(projectId);
    await this.sessions.acquire(projectId).drainCacheUpdates();
  }

  resetProjectConnection(projectId: string): void {
    this.#assertOpen();
    this.sessions.resetProject(projectId);
  }

  async handleRetirement(
    result: {
      readonly projectId: string;
      readonly retiredAt: string;
      readonly retirementId?: string;
    },
    source: 'response' | 'terminal-fallback',
  ): Promise<void> {
    if (!this.retirement || !this.retirementAdmission) return;
    await this.#deliverRetirement(result, source);
  }

   #readOnlineCoalesced(projectId: string): Promise<CollabProjectSnapshot> {
    const session = this.sessions.acquire(projectId);
    return session.coalesceSnapshot(() => (
      this.#readOnlineSnapshot(projectId, session.generation)
    ));
  }

   async #readOnlineSnapshot(
    projectId: string,
    generation: number,
  ): Promise<CollabProjectSnapshot> {
    let snapshot: CollabProjectSnapshot;
    try {
      snapshot = await this.control.readSnapshot(projectId);
    } catch (error) {
      const retirement = retirementResultFromError(projectId, error);
      if (retirement && this.retirement) {
        this.#scheduleRetirement(retirement, 'terminal-fallback');
      }
      throw error;
    }
    const session = this.sessions.acquire(projectId);
    session.assertGeneration(generation);
    if (snapshot.project.id !== projectId) {
      throw new CollabError({ code: 'authority-integrity-error' });
    }
    const membership = await this.store.loadMembership(projectId);
    session.assertGeneration(generation);
    if (!membership) {
      throw projectionError('project-not-found', 'projection-membership-missing');
    }
    if (
      membership.project.id !== projectId
      || membership.member.id !== snapshot.currentMember.id
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'projection-current-member-mismatch' },
      });
    }
    if (snapshot.eventSequence < membership.lastEventSequence) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'projection-event-sequence-regressed' },
      });
    }
    const writeSnapshotCache = async (cachedSnapshot: CollabProjectSnapshot): Promise<void> => {
      await this.#updateTicketCache(projectId, cache => ({
        cachedAt: this.now().toISOString(),
        projectId,
        schemaVersion: CACHE_SCHEMA_VERSION,
        snapshot: cachedSnapshot,
        ticketDetails: cache?.ticketDetails ?? [],
        ticketPages: cache?.ticketPages ?? [],
      }));
    };
    await writeSnapshotCache(snapshot);
    session.assertGeneration(generation);
    await this.store.updateMembershipProjection(
      projectId,
      snapshot.currentMember.id,
      snapshot.currentMember.role,
      snapshot.eventSequence,
    );
    session.assertGeneration(generation);
    const reconciledOffer = isCollabLanProjectSnapshot(snapshot)
      ? await this.managerResponsibility?.reconcileSnapshot(snapshot) ?? null
      : null;
    session.assertGeneration(generation);
    if (reconciledOffer) {
      const originalOffer = isCollabLanProjectSnapshot(snapshot)
        ? snapshot.managerResponsibilityOffer
        : undefined;
      if (
        !originalOffer
        || reconciledOffer.offerId !== originalOffer.offerId
        || reconciledOffer.sourceManagerMemberId !== originalOffer.sourceManagerMemberId
        || reconciledOffer.targetMemberId !== originalOffer.targetMemberId
      ) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'projection-manager-responsibility-mismatch' },
        });
      }
      snapshot = { ...snapshot, managerResponsibilityOffer: reconciledOffer };
      await writeSnapshotCache(snapshot);
      session.assertGeneration(generation);
    }
    return snapshot;
  }

   #refreshFromEvent(
    projectId: string,
    invalidation: ProjectEventInvalidation,
  ): Promise<number> {
    if (invalidation.kind === 'retired') {
      return this.#handleRetirementEvent(projectId, invalidation);
    }
    const work = this.sessions.acquire(projectId);
    const generation = work.generation;
    return work.coalesceEventRefresh(
      invalidation.sequence,
      () => this.#readOnlineCoalesced(projectId).then(snapshot => {
        work.assertGeneration(generation);
        const connection = work.getEventConnection<ProjectionEventSession>();
        for (const listener of connection?.listeners ?? []) {
          try {
            listener(snapshot);
          } catch {
            // Projection observers cannot invalidate authoritative refresh state.
          }
        }
        return snapshot.eventSequence;
      }),
    );
  }

   #handleRetirementEvent(
    projectId: string,
    invalidation: Extract<ProjectEventInvalidation, { readonly kind: 'retired' }>,
  ): Promise<number> {
    // The event callback is owned by this Project session. Detach it before
    // convergence closes and drains that session, then let the lifecycle-owned
    // handler settle independently so the callback cannot await itself.
    this.resetProjectConnection(projectId);
    this.#scheduleRetirement({
      projectId,
      retiredAt: invalidation.retiredAt,
      ...(invalidation.retirementId === undefined
        ? {}
        : { retirementId: invalidation.retirementId }),
    }, 'event');
    return Promise.resolve(invalidation.sequence);
  }

   async #runWithRetirementFallback<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const retirement = retirementResultFromError(projectId, error);
      if (retirement && this.retirement) {
        this.#scheduleRetirement(retirement, 'terminal-fallback');
      }
      throw error;
    }
  }

   #scheduleRetirement(
    result: {
      readonly projectId: string;
      readonly retiredAt: string;
      readonly retirementId?: string;
    },
    source: 'event' | 'terminal-fallback',
  ): void {
    if (!this.retirement || !this.retirementAdmission) return;
    void this.#deliverRetirement(result, source).catch(() => undefined);
  }

   #deliverRetirement(
    result: {
      readonly projectId: string;
      readonly retiredAt: string;
      readonly retirementId?: string;
    },
    source: 'event' | 'response' | 'terminal-fallback',
  ): Promise<void> {
    if (!this.retirement || !this.retirementAdmission) return Promise.resolve();
    return this.retirementAdmission(result.projectId, async () => {
      await this.retirement!.handle(result, source);
    });
  }

   #assertOpen(): void {
    if (this.disposed) throw projectionError('host-stopped', 'projection-disposed');
  }

   #assertProjectGeneration(projectId: string, generation: number): void {
    this.sessions.acquire(projectId).assertGeneration(generation);
  }

   #projectGeneration(projectId: string): number {
    return this.sessions.acquire(projectId).generation;
  }

   #updateTicketCache(
    projectId: string,
    update: (cache: CollabSnapshotCache | null) => CollabSnapshotCache | null,
  ): Promise<void> {
    return this.sessions.acquire(projectId).enqueueCacheUpdate(async () => {
      const cache = await this.#loadCache(projectId).catch(() => null);
      const next = update(cache);
      if (next) await this.store.saveProjectDocument(projectId, 'cache', next);
    });
  }

   async #loadCache(projectId: string): Promise<CollabSnapshotCache | null> {
    const cache = await this.store.loadProjectDocument(projectId, 'cache', decodeCache);
    if (cache && cache.schemaVersion !== CACHE_SCHEMA_VERSION) {
      await this.store.removeProjectDocument(projectId, 'cache');
      return null;
    }
    if (cache) {
      const membership = await this.store.loadMembership(projectId);
      if (
        !membership
        || membership.project.id !== cache.snapshot.project.id
        || membership.member.id !== cache.snapshot.currentMember.id
        || membership.member.displayName !== cache.snapshot.currentMember.displayName
        || membership.member.personalRef !== cache.snapshot.currentMember.personalRef
        || membership.member.role !== cache.snapshot.currentMember.role
        || membership.authority.kind !== cache.snapshot.project.authorityKind
        || cache.snapshot.eventSequence < membership.lastEventSequence
      ) {
        await this.store.removeProjectDocument(projectId, 'cache');
        return null;
      }
    }
    return cache;
  }
}
