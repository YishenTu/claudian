import { randomUUID } from 'node:crypto';

import type { ResolveTicketNumberRequest, ResolveTicketNumberResponse } from '@claudian-collab/protocol';
import { type AcceptResponse, COLLAB_LIMITS, type CollabComment, type CollabCommentPage, type CollabResolvingTicketExpectation, type CollabTicketAcceptedRelationPage, type CollabTicketCommentPage, type CollabTicketDetail, type CollabTicketPage, isCollabOpaqueId } from '@claudian-collab/protocol';

import type {
  CollabProjectResource,
  CollabProjectWorkSessionRegistry,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectDocumentBase,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type { CollabEventConnectionState } from '@/app/collab/reconnect/CollabProjectConnection';
import { decodeCloudProjectSnapshotCache } from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type { CollabAuthorityEventInvalidation, CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import type { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import type { CollabProjectSnapshot } from '@/core/collab';
import { isCollabLanProjectSnapshot } from '@/core/collab';
import { type CollabCoordinationSnapshot, type CollabListTicketsRequest, type CollabOperationOptions, type CollabTicketDetailProjection, type CollabTicketPageProjection } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CACHE_SCHEMA_VERSION = 6 as const;
const OBSOLETE_CACHE_SCHEMA_VERSIONS = new Set<unknown>([2, 3, 4, 5]);
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
  readonly authorityBinding: string;
  readonly cachedAt: string;
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly snapshot: CollabProjectSnapshot;
}

interface CollabTicketCache extends CollabSnapshotCache {
  readonly ticketDetails: readonly CachedTicketDetail[];
  readonly ticketPages: readonly CachedTicketPage[];
}

interface ObsoleteCollabSnapshotCache extends CollabLocalProjectDocumentBase {
  readonly schemaVersion: 2 | 3 | 4 | 5;
}

type DecodedCollabSnapshotCache = CollabSnapshotCache | ObsoleteCollabSnapshotCache;

export interface CollabClientProjectionStore {
  loadMembership(projectId: string): Promise<CollabLocalMembershipRecord | null>;
  loadProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: string,
    kind: 'cache' | 'ticket-cache',
    decode: (value: unknown) => T,
  ): Promise<T | null>;
  saveProjectDocument<T extends CollabLocalProjectDocumentBase>(
    projectId: string,
    kind: 'cache' | 'ticket-cache',
    document: T,
  ): Promise<void>;
  removeProjectDocument(projectId: string, kind: 'cache' | 'ticket-cache'): Promise<boolean>;
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

interface CollabClientProjectionBaseOptions {
  readonly onSnapshotResult?: (projectId: string, error?: CollabError) => void;
  readonly onEventConnectionState?: (projectId: string, state: CollabEventConnectionState) => void;
  readonly authoritySessions: CollabAuthoritySessionFactory;
  readonly managerResponsibility?: CollabManagerResponsibilityProjectionPort;
  readonly now?: () => Date;
  readonly sessions: CollabProjectWorkSessionRegistry;
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
    assertCurrent: () => void,
  ): void;
}

interface ProjectionEventSession {
  readonly ready: Promise<void>;
  readonly failed: boolean;
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

function cacheAuthorityBinding(membership: CollabLocalMembershipRecord): string {
  const authority = membership.authority;
  return JSON.stringify(authority.kind === 'cloud'
    ? [authority.kind, authority.authorityGeneration, authority.serverUrl, authority.gitRemoteUrl]
    : [authority.kind, authority.authorityGeneration, authority.endpoint, authority.hostCaFingerprint, authority.gitRemoteUrl]);
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
    return { projectId, schemaVersion: source.schemaVersion as 2 | 3 | 4 | 5 };
  }
  const cachedAt = source.cachedAt;
  if (
    source.schemaVersion !== CACHE_SCHEMA_VERSION
    || typeof source.authorityBinding !== 'string'
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
  return { authorityBinding: source.authorityBinding, cachedAt, projectId, schemaVersion: CACHE_SCHEMA_VERSION, snapshot };
}

function decodeTicketCache(value: unknown): CollabTicketCache | ObsoleteCollabSnapshotCache {
  const base = decodeCache(value);
  if (base.schemaVersion !== CACHE_SCHEMA_VERSION) return base;
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > CLAUDIAN_COLLAB_LIMITS.maxTicketCacheBytes) {
    throw new TypeError('Oversized Ticket cache');
  }
  const source = value as Readonly<Record<string, unknown>>;
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
  return { ...base, ticketDetails, ticketPages };
}

function boundTicketCache(cache: CollabTicketCache): CollabTicketCache {
  const ticketDetails = [...cache.ticketDetails];
  const ticketPages = [...cache.ticketPages];
  const bounded = { ...cache, ticketDetails, ticketPages };
  let bytes = Buffer.byteLength(JSON.stringify(bounded, null, 2));
  const emptyArrayBytes = Buffer.byteLength(JSON.stringify({ entries: [] }, null, 2));
  while (bytes > CLAUDIAN_COLLAB_LIMITS.maxTicketCacheBytes) {
    const detail = ticketDetails.at(-1);
    const page = ticketPages.at(-1);
    if (!detail && !page) break;
    const entries = detail && (!page || detail.cachedAt <= page.cachedAt) ? ticketDetails : ticketPages;
    const removed = entries.pop();
    // The wrapper preserves the entry's indentation inside a top-level array.
    // Emptying an array also removes the two spaces before its closing bracket;
    // otherwise the removed comma and newline take their place.
    const singleEntryBytes = Buffer.byteLength(JSON.stringify({ entries: [removed] }, null, 2)) - emptyArrayBytes;
    bytes -= singleEntryBytes - (entries.length > 0 ? 2 : 0);
  }
  return bounded;
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
  // A complete collection spans byte-bounded wire pages. Validate each item
  // without reconstructing a count-sized page that could exceed its byte limit.
  const comments = rawComments.flatMap(comment => (
    lanCollabControlOperationCodec('listTicketComments').decodeResponse(cacheEnvelope({
      comments: [comment],
    })).comments
  ));
  const acceptedRelations = rawRelations.flatMap(relation => (
    lanCollabControlOperationCodec('listTicketAcceptedRelations')
      .decodeResponse(cacheEnvelope({
        acceptedRelations: [relation],
      })).acceptedRelations
  ));
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
   readonly #authoritySessions: CollabAuthoritySessionFactory;
  private disposed = false;
  private readonly managerResponsibility?: CollabManagerResponsibilityProjectionPort;
  private readonly now: () => Date;
  private readonly retirement?: Pick<RetirementClientHandler, 'handle'>;
  private readonly retirementAdmission?: CollabClientRetirementAdmission;
  private readonly sessions: CollabProjectWorkSessionRegistry;

  constructor(
    private readonly store: CollabClientProjectionStore,
    private readonly control: CollabClientProjectionControlPort,
    private readonly options: CollabClientProjectionOptions,
  ) {
    this.#authoritySessions = options.authoritySessions;
    this.managerResponsibility = options.managerResponsibility;
    this.now = options.now ?? (() => new Date());
    this.retirement = options.retirement;
    this.retirementAdmission = options.retirementAdmission;
    this.sessions = options.sessions;
  }

  async readPresentationSnapshot(
    projectId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabCoordinationSnapshot> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const work = this.sessions.acquire(projectId);
    const snapshot = work.retainedSnapshot;
    if (!snapshot || !work.hasObservers) return this.readSnapshot(projectId, options);
    const failure = work.connectionFailure;
    if (failure && !canUseCache(failure)) throw failure;
    const stale = work.retainedSnapshotSource === 'cache' || work.connectionStatus !== 'connected';
    return {
      snapshot,
      source: stale ? 'cache' : 'online',
      stale,
      syncState: {
        eventSequence: snapshot.eventSequence,
        generation: work.generation,
        projectId,
        status: stale ? 'offline' : 'synchronized',
      },
    };
  }

  async readSnapshot(
    projectId: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabCoordinationSnapshot> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const work = this.sessions.acquire(projectId);
    const generation = work.generation;
    try {
      const snapshot = await this.#readOnlineCoalesced(projectId);
      throwIfCancelled(options.signal);
      work.assertGeneration(generation);
      return {
        snapshot,
        source: 'online',
        stale: false,
        syncState: {
          eventSequence: snapshot.eventSequence,
          generation,
          projectId,
          status: 'synchronized',
        },
      };
    } catch (error) {
      throwIfCancelled(options.signal);
      const collabError = error instanceof CollabError ? error : null;
      if (!collabError || !canUseCache(collabError)) throw error;
      const cached = await this.#loadCache(projectId);
      throwIfCancelled(options.signal);
      if (!cached) throw error;
      work.assertGeneration(generation);
      work.retainSnapshot(cached.snapshot, generation, 'cache');
      return {
        snapshot: cached.snapshot,
        source: 'cache',
        stale: true,
        syncState: {
          eventSequence: cached.snapshot.eventSequence,
          generation,
          projectId,
          status: 'offline',
        },
      };
    }
  }

  async resolveTicketNumber(
    request: ResolveTicketNumberRequest,
    options: CollabOperationOptions = {},
  ): Promise<ResolveTicketNumberResponse> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const generation = this.#projectGeneration(request.projectId);
    try {
      const result = await this.#runWithRetirementFallback(
        request.projectId,
        () => this.control.resolveTicketNumber(request, options),
      );
      throwIfCancelled(options.signal);
      this.#assertProjectGeneration(request.projectId, generation);
      return result;
    } catch (error) {
      throwIfCancelled(options.signal);
      if (!(error instanceof CollabError) || !canUseCache(error)) throw error;
      const cache = await this.#loadTicketCache(request.projectId);
      const snapshotCache = await this.#loadCache(request.projectId);
      throwIfCancelled(options.signal);
      this.#assertProjectGeneration(request.projectId, generation);
      const ticket = cache?.ticketDetails.find(
        entry => entry.detail.ticket.number === request.ticketNumber,
      )?.detail.ticket ?? cache?.ticketPages.flatMap(entry => entry.page.tickets).find(
        entry => entry.number === request.ticketNumber,
      ) ?? snapshotCache?.snapshot.ticketHighlights.find(entry => entry.number === request.ticketNumber);
      if (!ticket) throw error;
      return { ticketId: ticket.id };
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
      const cache = await this.#loadTicketCache(request.projectId);
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
      const cache = await this.#loadTicketCache(projectId);
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
    if (!session) session = await this.#connectEvents(projectId, new Set());
    session.listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = work.getEventConnection<ProjectionEventSession>();
        if (!current?.listeners.delete(listener)) return;
        if (current && current.listeners.size === 0) {
          work.clearEventConnection(current);
          this.options.onEventConnectionState?.(projectId, 'unsubscribed');
        }
      },
    };
  }

  async reconnectProject(projectId: string, options: CollabOperationOptions = {}): Promise<void> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    const work = this.sessions.acquire(projectId);
    const generation = work.generation;
    await work.currentEventRefresh()?.catch(() => undefined);
    work.assertGeneration(generation);
    throwIfCancelled(options.signal);
    const previous = work.getEventConnection<ProjectionEventSession>();
    if (previous?.failed) {
      work.clearEventConnection(previous);
      const connected = await this.#connectEvents(projectId, previous.listeners);
      await connected.ready;
    } else {
      await this.#readOnlineCoalesced(projectId);
      await previous?.ready;
    }
    work.assertGeneration(generation);
    throwIfCancelled(options.signal);
  }

  async #connectEvents(
    projectId: string,
    listeners: Set<(snapshot: CollabProjectSnapshot) => void>,
  ): Promise<ProjectionEventSession> {
    const work = this.sessions.acquire(projectId);
    const generation = work.generation;
    const observationRevision = work.observationRevision;
    let current = true;
    let failed = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Subscription is nonblocking; a later recovery attempt can await readiness.
    void ready.catch(() => undefined);
    this.options.onEventConnectionState?.(projectId, 'connecting');
    try {
      const membership = await this.store.loadMembership(projectId);
      this.#assertOpen();
      work.assertGeneration(generation);
      if (!membership) throw projectionError('project-not-found', 'projection-membership-missing');
      const authority = await work.ensureAuthoritySession<CollabAuthoritySession>(
        () => this.#authoritySessions.create(membership),
      );
      this.#assertOpen();
      work.assertGeneration(generation);
      const client = authority.events.connect({
        afterSequence: membership.lastEventSequence,
        onConnectionResult: error => {
          if (!current || work.generation !== generation || work.observationRevision !== observationRevision) return;
          failed = error !== undefined;
          if (error) rejectReady(error);
          else resolveReady();
          this.options.onEventConnectionState?.(projectId, error ?? 'connected');
        },
        onInvalidation: invalidation => {
          work.assertGeneration(generation);
          if (!current || work.observationRevision !== observationRevision) throw new CollabError({ code: 'cancelled' });
          return this.#refreshFromEvent(projectId, invalidation);
        },
      });
      const session: ProjectionEventSession = {
        client, listeners, ready,
        get failed() { return failed; },
        dispose: () => {
          current = false;
          rejectReady(new CollabError({ code: 'cancelled' }));
          client.dispose();
        },
      };
      work.adoptEventConnection(session, generation, observationRevision);
      return session;
    } catch (error) {
      current = false;
      rejectReady(error);
      if (!this.disposed && work.generation === generation && work.observationRevision === observationRevision) {
        this.options.onEventConnectionState?.(projectId, error instanceof CollabError ? error
          : new CollabError({ code: 'operation-failed' }));
      }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }

  async closeProject(projectId: string): Promise<void> {
    this.resetProjectConnection(projectId);
    await this.sessions.acquire(projectId).drainCacheUpdates();
  }

  resetProjectConnection(
    projectId: string,
    options: { readonly preserveConnectionAttempt?: boolean } = {},
  ): boolean {
    this.#assertOpen();
    return this.sessions.resetProject(projectId, options);
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
    return session.coalesceSnapshot(() => {
      const generation = session.generation;
      return this.#readOnlineSnapshot(projectId, generation).then(snapshot => {
        session.assertGeneration(generation);
        this.options.onSnapshotResult?.(projectId);
        return snapshot;
      }, error => {
        if (session.generation === generation) {
          this.options.onSnapshotResult?.(projectId, error instanceof CollabError
            ? error : new CollabError({ code: 'operation-failed' }));
        }
        throw error;
      });
    });
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
    await session.enqueueCacheUpdate(async () => {
      session.assertGeneration(generation);
      await this.store.saveProjectDocument(projectId, 'cache', {
        authorityBinding: cacheAuthorityBinding(membership),
        cachedAt: this.now().toISOString(),
        projectId,
        schemaVersion: CACHE_SCHEMA_VERSION,
        snapshot,
      });
    });
    session.assertGeneration(generation);
    await this.store.updateMembershipProjection(
      projectId,
      snapshot.currentMember.id,
      snapshot.currentMember.role,
      snapshot.eventSequence,
    );
    session.assertGeneration(generation);
    const managerResponsibility = this.managerResponsibility;
    let reconcileManagerResponsibility = managerResponsibility !== undefined;
    if (reconcileManagerResponsibility && !isCollabLanProjectSnapshot(snapshot)) {
      const authority = await session.ensureAuthoritySession<CollabAuthoritySession>(() => (
        this.#authoritySessions.create(membership)
      ));
      reconcileManagerResponsibility = authority.supports('cloud-project-manager-responsibility');
    }
    if (reconcileManagerResponsibility && managerResponsibility) {
      managerResponsibility.reconcileSnapshot(
        snapshot,
        () => session.assertGeneration(generation),
      );
    }
    session.retainSnapshot(snapshot, generation);
    return snapshot;
  }

   #refreshFromEvent(
    projectId: string,
    invalidation: CollabAuthorityEventInvalidation,
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
    invalidation: Extract<CollabAuthorityEventInvalidation, { readonly kind: 'retired' }>,
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
    update: (cache: CollabTicketCache | null) => CollabTicketCache | null,
  ): Promise<void> {
    const work = this.sessions.acquire(projectId);
    const generation = work.generation;
    return work.enqueueCacheUpdate(async () => {
      const current = await this.#loadTicketCache(projectId).catch(() => null);
      const snapshot = await this.#loadCache(projectId);
      const cache = snapshot ? {
        ...snapshot,
        ticketDetails: current?.ticketDetails ?? [],
        ticketPages: current?.ticketPages ?? [],
      } : null;
      const next = update(cache);
      work.assertGeneration(generation);
      if (next) await this.store.saveProjectDocument(projectId, 'ticket-cache', boundTicketCache(next));
    });
  }

  async #loadTicketCache(projectId: string): Promise<CollabTicketCache | null> {
    const cache = await this.store.loadProjectDocument(projectId, 'ticket-cache', decodeTicketCache);
    if (cache && cache.schemaVersion !== CACHE_SCHEMA_VERSION) {
      await this.store.removeProjectDocument(projectId, 'ticket-cache');
      return null;
    }
    if (cache && !await this.#cacheMatchesMembership(projectId, cache, false)) {
      await this.store.removeProjectDocument(projectId, 'ticket-cache');
      return null;
    }
    return cache;
  }

   async #loadCache(projectId: string): Promise<CollabSnapshotCache | null> {
    const cache = await this.store.loadProjectDocument(projectId, 'cache', decodeCache);
    if (cache && cache.schemaVersion !== CACHE_SCHEMA_VERSION) {
      await this.store.removeProjectDocument(projectId, 'cache');
      return null;
    }
    if (cache && !await this.#cacheMatchesMembership(projectId, cache, true)) {
      await this.store.removeProjectDocument(projectId, 'cache');
      return null;
    }
    return cache;
  }

  async #cacheMatchesMembership(
    projectId: string,
    cache: CollabSnapshotCache,
    requireCurrentSequence: boolean,
  ): Promise<boolean> {
    const membership = await this.store.loadMembership(projectId);
    return membership !== null
      && cache.authorityBinding === cacheAuthorityBinding(membership)
      && membership.project.id === cache.snapshot.project.id
      && membership.member.id === cache.snapshot.currentMember.id
      && membership.member.displayName === cache.snapshot.currentMember.displayName
      && membership.member.personalRef === cache.snapshot.currentMember.personalRef
      && membership.member.role === cache.snapshot.currentMember.role
      && membership.authority.kind === cache.snapshot.project.authorityKind
      && (!requireCurrentSequence || cache.snapshot.eventSequence >= membership.lastEventSequence);
  }
}
