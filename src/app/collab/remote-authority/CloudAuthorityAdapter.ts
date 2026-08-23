import { randomUUID } from 'node:crypto';

import {
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  collabCloudCapabilitiesRoute,
  type CollabCloudCapability,
  collabCloudCapabilitySupported,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  type CollabControlOperation,
  collabControlOperationCodec,
  type CollabControlOperationMap,
  type CollabRequestDetail,
  type CollabTicketDetail,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudProjectEventMessage,
  decodeCollabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';
import { type RawData, WebSocket } from 'ws';

import type {
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { canonicalCloudOrigin } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { decodeCloudAuthorityProjectSnapshot } from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type {
  CollabAuthorityAdapter,
  CollabAuthorityEventConnectionInput,
  CollabAuthorityEventInvalidation,
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { CollabCloudProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const REQUEST_TIMEOUT_MS = 30_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface CloudAuthorityHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface CloudAuthorityHttpResponse {
  readonly body: unknown;
  readonly contentType: string | null;
  readonly status: number;
}

export type CloudAuthorityHttpTransport = (
  input: CloudAuthorityHttpRequest,
) => Promise<CloudAuthorityHttpResponse>;

export interface CloudProjectEventSocket {
  close(code: number, reason: string): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onOpen(listener: () => void): void;
}

export interface CloudProjectEventSocketInput {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

export interface CloudProjectEventClientOptions {
  readonly clearTimeout?: (handle: number) => void;
  readonly createSocket?: (input: CloudProjectEventSocketInput) => CloudProjectEventSocket;
  readonly random?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => number;
}

export interface CloudProjectEventClientInput {
  readonly afterSequence: number;
  readonly developmentActorId: string;
  readonly projectId: string;
  readonly serverUrl: string;
}

export interface CloudAuthorityAdapterOptions {
  readonly createEventClient?: (
    input: CloudProjectEventClientInput,
    onInvalidation: (invalidation: CollabAuthorityEventInvalidation) => Promise<number>,
  ) => { dispose(): void; start(): void };
  readonly request?: CloudAuthorityHttpTransport;
  readonly requestIdFactory?: () => string;
}

class NodeCloudProjectEventSocket implements CloudProjectEventSocket {
  constructor(private readonly socket: WebSocket) {}

  close(code: number, reason: string): void { this.socket.close(code, reason); }
  onClose(listener: (code: number) => void): void {
    this.socket.on('close', code => listener(code));
  }
  onError(listener: () => void): void { this.socket.on('error', listener); }
  onMessage(listener: (data: string) => void): void {
    this.socket.on('message', (data: RawData) => listener(data.toString()));
  }
  onOpen(listener: () => void): void { this.socket.on('open', listener); }
}

function createDefaultEventSocket(input: CloudProjectEventSocketInput): CloudProjectEventSocket {
  return new NodeCloudProjectEventSocket(new WebSocket(input.url, {
    headers: input.headers,
    perMessageDeflate: false,
  }));
}

function adapterError(
  code: 'cancelled' | 'endpoint-unreachable' | 'operation-failed'
    | 'operation-timeout' | 'protocol-payload-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'protocol-payload-invalid'
      ? ['open-diagnostics']
      : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function controlIntegrityError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertCompleteRequestComments(detail: CollabRequestDetail): void {
  if (detail.comments.comments.length > COLLAB_LIMITS.maxRequestComments) {
    throw controlIntegrityError('cloud-control-request-comment-limit-exceeded');
  }
  if (detail.comments.comments.length !== detail.request.commentCount) {
    throw controlIntegrityError('cloud-control-request-comment-count-mismatch');
  }
  if (detail.comments.comments.some(comment => comment.requestId !== detail.request.id)) {
    throw controlIntegrityError('cloud-control-request-comment-owner-mismatch');
  }
}

function assertCompleteTicketCollections(detail: CollabTicketDetail): void {
  if (detail.comments.comments.length !== detail.ticket.commentCount) {
    throw controlIntegrityError('cloud-control-ticket-comment-count-mismatch');
  }
  if (detail.comments.comments.length > COLLAB_LIMITS.maxTicketComments) {
    throw controlIntegrityError('cloud-control-ticket-comment-limit-exceeded');
  }
  if (
    detail.acceptedRelations.acceptedRelations.length
    > COLLAB_LIMITS.maxTicketAcceptedRelations
  ) {
    throw controlIntegrityError('cloud-control-ticket-relation-limit-exceeded');
  }
  if (
    detail.acceptedRelations.acceptedRelations.length
    !== detail.ticket.acceptedRelationCount
  ) {
    throw controlIntegrityError('cloud-control-ticket-relation-count-mismatch');
  }
}

function assertJsonResponse(response: CloudAuthorityHttpResponse): void {
  if (
    response.contentType === null
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(response.contentType)
  ) {
    throw adapterError('protocol-payload-invalid', 'cloud-authority-content-type-invalid');
  }
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
        await reader.cancel('response-too-large');
        throw adapterError('protocol-payload-invalid', 'cloud-authority-response-too-large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function defaultHttpTransport(
  input: CloudAuthorityHttpRequest,
): Promise<CloudAuthorityHttpResponse> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort('cancelled');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input.url, {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers: {
        ...input.headers,
        ...(input.body === undefined
          ? {}
          : { 'content-type': 'application/json; charset=utf-8' }),
      },
      method: input.method,
      signal: controller.signal,
    });
    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null
      && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)
        || Number(contentLength) > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes)
    ) {
      await response.body?.cancel('response-too-large').catch(() => undefined);
      throw adapterError('protocol-payload-invalid', 'cloud-authority-response-too-large');
    }
    const bytes = await readBoundedResponseBody(response);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw adapterError('protocol-payload-invalid', 'cloud-authority-response-invalid');
    }
    return {
      body,
      contentType: response.headers.get('content-type'),
      status: response.status,
    };
  } catch (error: unknown) {
    if (error instanceof CollabError) throw error;
    if (controller.signal.aborted) {
      throw controller.signal.reason === 'timeout'
        ? adapterError('operation-timeout', 'cloud-authority-request-timeout')
        : adapterError('cancelled', 'cloud-authority-request-cancelled');
    }
    throw adapterError('endpoint-unreachable', 'cloud-authority-request-failed');
  } finally {
    window.clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

class CloudAuthorityControl implements CollabAuthorityControlPort {
  constructor(
    private readonly actorId: string,
    private readonly capabilities: ReadonlySet<string>,
    private readonly memberId: string,
    private readonly origin: string,
    private readonly personalRef: string,
    private readonly projectId: string,
    private readonly request: CloudAuthorityHttpTransport,
    private readonly requestId: () => string,
  ) {}

  async readSnapshot(
    projectId: string,
    options: Parameters<CollabAuthorityControlPort['readSnapshot']>[1] = {},
  ): Promise<CollabCloudProjectSnapshot> {
    this.requireCapability('project-snapshot');
    if (projectId !== this.projectId) {
      throw new CollabError({ code: 'project-not-found' });
    }
    const route = collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot');
    const decoded = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeRequest({ projectId });
    if (decoded.status !== 'ok') throw decoded.error;
    const response = await this.request({
      body: {
        data: decoded.value,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        requestId: this.requestId(),
      },
      headers: { 'x-claudian-development-actor': this.actorId },
      method: route.method,
      ...(options.signal ? { signal: options.signal } : {}),
      url: new URL(route.target, this.origin).toString(),
    });
    assertJsonResponse(response);
    if (response.status < 200 || response.status >= 300) {
      const envelope = decodeCollabCloudErrorEnvelope(response.body);
      throw new CollabError(envelope.error);
    }
    const envelope = decodeCollabCloudSuccessEnvelope(response.body);
    const snapshot = decodeCloudAuthorityProjectSnapshot(envelope.data);
    if (
      snapshot.project.id !== projectId
      || snapshot.currentMember.id !== this.memberId
      || snapshot.currentMember.personalRef !== this.personalRef
    ) {
      throw controlIntegrityError('cloud-control-snapshot-response-mismatch');
    }
    return snapshot;
  }

  async ensure(input: Parameters<CollabAuthorityControlPort['ensure']>[0]) {
    const { signal, ...request } = input;
    const response = await this.execute(
      'requests',
      'ensureMyRequest',
      request,
      signal ? { signal } : {},
    );
    if (
      response.request.memberId !== this.memberId
      || response.request.latestHeadOid !== input.headOid
      || response.request.status !== 'open'
      || response.mainOid !== input.expectedMainOid
    ) {
      throw controlIntegrityError('cloud-control-request-response-mismatch');
    }
    return response.request;
  }
  async acceptRequest(input: Parameters<CollabAuthorityControlPort['acceptRequest']>[0]) {
    const { signal, ...request } = input;
    const response = await this.execute(
      'accept',
      'acceptRequest',
      request,
      signal ? { signal } : {},
    );
    if (
      response.request.id !== input.requestId
      || response.request.latestHeadOid !== input.expectedHeadOid
      || response.request.revision !== input.expectedRequestRevision
    ) {
      throw controlIntegrityError('cloud-control-accept-response-mismatch');
    }
    return response;
  }
  async createComment(input: Parameters<CollabAuthorityControlPort['createComment']>[0]) {
    const { signal, ...request } = input;
    const response = await this.execute(
      'requests',
      'createComment',
      request,
      signal ? { signal } : {},
    );
    if (
      response.comment.authorMemberId !== this.memberId
      || response.comment.requestId !== input.requestId
      || response.request.id !== input.requestId
    ) {
      throw controlIntegrityError('cloud-control-comment-response-mismatch');
    }
    return { comment: response.comment };
  }
  async createTicket(
    request: Parameters<CollabAuthorityControlPort['createTicket']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['createTicket']>[2] = {},
  ) {
    const response = await this.execute('tickets', 'createTicket', {
      body: request.body,
      idempotencyKey,
      projectId: request.projectId,
      title: request.title,
    }, options);
    if (response.ticket.ticket.authorMemberId !== this.memberId) {
      throw controlIntegrityError('cloud-control-ticket-create-mismatch');
    }
    return response.ticket;
  }
  async updateTicketContent(
    request: Parameters<CollabAuthorityControlPort['updateTicketContent']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['updateTicketContent']>[2] = {},
  ) {
    const response = await this.execute('tickets', 'updateTicketContent', {
      body: request.body,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      projectId: request.projectId,
      ticketId: request.ticketId,
      title: request.title,
    }, options);
    return this.checkedTicketMutation(request.ticketId, response.ticket);
  }
  async addTicketComment(
    request: Parameters<CollabAuthorityControlPort['addTicketComment']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['addTicketComment']>[2] = {},
  ) {
    const response = await this.execute('tickets', 'createTicketComment', {
      body: request.body,
      idempotencyKey,
      projectId: request.projectId,
      ticketId: request.ticketId,
    }, options);
    if (
      response.comment.authorMemberId !== this.memberId
      || response.comment.ticketId !== request.ticketId
      || response.ticket.id !== request.ticketId
    ) {
      throw controlIntegrityError('cloud-control-ticket-comment-mismatch');
    }
    return response.comment;
  }
  async closeTicket(
    request: Parameters<CollabAuthorityControlPort['closeTicket']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['closeTicket']>[2] = {},
  ) {
    const response = await this.execute('tickets', 'closeTicket', {
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      projectId: request.projectId,
      ticketId: request.ticketId,
    }, options);
    return this.checkedTicketMutation(request.ticketId, response.ticket);
  }
  async reopenTicket(
    request: Parameters<CollabAuthorityControlPort['reopenTicket']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['reopenTicket']>[2] = {},
  ) {
    const response = await this.execute('tickets', 'reopenTicket', {
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      projectId: request.projectId,
      ticketId: request.ticketId,
    }, options);
    return this.checkedTicketMutation(request.ticketId, response.ticket);
  }
  updateRequestMetadata(
    request: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[2] = {},
  ) {
    return this.updateRequest(request, idempotencyKey, options);
  }
  listTickets(
    request: Parameters<CollabAuthorityControlPort['listTickets']>[0],
    options: Parameters<CollabAuthorityControlPort['listTickets']>[1] = {},
  ) { return this.execute('tickets', 'listTickets', request, options); }
  async listRequestComments(
    projectId: string,
    requestId: string,
    query: Parameters<CollabAuthorityControlPort['listRequestComments']>[2],
    options: Parameters<CollabAuthorityControlPort['listRequestComments']>[3] = {},
  ) {
    const page = await this.execute('requests', 'listRequestComments', {
      ...query,
      projectId,
      requestId,
    }, options);
    if (page.comments.some(comment => comment.requestId !== requestId)) {
      throw controlIntegrityError('cloud-control-request-comment-owner-mismatch');
    }
    return page;
  }
  async listTicketComments(
    projectId: string,
    ticketId: string,
    query: Parameters<CollabAuthorityControlPort['listTicketComments']>[2],
    options: Parameters<CollabAuthorityControlPort['listTicketComments']>[3] = {},
  ) {
    const page = await this.execute('tickets', 'listTicketComments', {
      ...query,
      projectId,
      ticketId,
    }, options);
    if (page.comments.some(comment => comment.ticketId !== ticketId)) {
      throw controlIntegrityError('cloud-control-ticket-comment-owner-mismatch');
    }
    return page;
  }
  listTicketAcceptedRelations(
    projectId: string,
    ticketId: string,
    query: Parameters<CollabAuthorityControlPort['listTicketAcceptedRelations']>[2],
    options: Parameters<CollabAuthorityControlPort['listTicketAcceptedRelations']>[3] = {},
  ) {
    return this.execute('tickets', 'listTicketAcceptedRelations', {
      ...query,
      projectId,
      ticketId,
    }, options);
  }
  async readRequest(
    projectId: string,
    requestId: string,
    options: Parameters<CollabAuthorityControlPort['readRequest']>[2] = {},
  ) {
    const detail = await this.readRequestDetail(projectId, requestId, options);
    if (!detail.comments.nextCursor) {
      assertCompleteRequestComments(detail);
      return detail;
    }
    const comments = [...detail.comments.comments];
    const visited = new Set<string>();
    let cursor: string | undefined = detail.comments.nextCursor;
    while (cursor) {
      if (visited.has(cursor)) {
        throw controlIntegrityError('cloud-control-comment-cursor-cycled');
      }
      visited.add(cursor);
      const page = await this.listRequestComments(projectId, requestId, {
        cursor,
        limit: COLLAB_LIMITS.maxCommentPageSize,
      }, options);
      comments.push(...page.comments);
      if (comments.length > COLLAB_LIMITS.maxRequestComments) {
        throw controlIntegrityError('cloud-control-request-comment-limit-exceeded');
      }
      cursor = page.nextCursor;
    }
    const complete = { ...detail, comments: { comments } };
    assertCompleteRequestComments(complete);
    return complete;
  }
  readRequestPage(
    projectId: string,
    requestId: string,
    options: Parameters<CollabAuthorityControlPort['readRequestPage']>[2] = {},
  ) { return this.readRequestDetail(projectId, requestId, options); }
  async readTicket(
    projectId: string,
    ticketId: string,
    options: Parameters<CollabAuthorityControlPort['readTicket']>[2] = {},
  ) {
    const detail = await this.readTicketDetail(projectId, ticketId, options);
    if (!detail.comments.nextCursor && !detail.acceptedRelations.nextCursor) {
      assertCompleteTicketCollections(detail);
      return detail;
    }
    const comments = [...detail.comments.comments];
    const acceptedRelations = [...detail.acceptedRelations.acceptedRelations];
    const visited = new Set<string>();
    let commentCursor: string | undefined = detail.comments.nextCursor;
    while (commentCursor) {
      if (visited.has(commentCursor)) {
        throw controlIntegrityError('cloud-control-comment-cursor-cycled');
      }
      visited.add(commentCursor);
      const page = await this.listTicketComments(projectId, ticketId, {
        cursor: commentCursor,
        limit: COLLAB_LIMITS.maxCommentPageSize,
      }, options);
      comments.push(...page.comments);
      if (comments.length > COLLAB_LIMITS.maxTicketComments) {
        throw controlIntegrityError('cloud-control-ticket-comment-limit-exceeded');
      }
      commentCursor = page.nextCursor;
    }
    let relationCursor: string | undefined = detail.acceptedRelations.nextCursor;
    while (relationCursor) {
      if (visited.has(relationCursor)) {
        throw controlIntegrityError('cloud-control-relation-cursor-cycled');
      }
      visited.add(relationCursor);
      const page = await this.listTicketAcceptedRelations(projectId, ticketId, {
        cursor: relationCursor,
        limit: COLLAB_LIMITS.maxRelationsPerPage,
      }, options);
      acceptedRelations.push(...page.acceptedRelations);
      if (acceptedRelations.length > COLLAB_LIMITS.maxTicketAcceptedRelations) {
        throw controlIntegrityError('cloud-control-ticket-relation-limit-exceeded');
      }
      relationCursor = page.nextCursor;
    }
    const complete = {
      ...detail,
      acceptedRelations: { acceptedRelations },
      comments: { comments },
    };
    assertCompleteTicketCollections(complete);
    return complete;
  }
  readTicketPage(
    projectId: string,
    ticketId: string,
    options: Parameters<CollabAuthorityControlPort['readTicketPage']>[2] = {},
  ) { return this.readTicketDetail(projectId, ticketId, options); }

  private requireCapability(capability: CollabCloudCapability): void {
    if (!this.capabilities.has(capability)) {
      throw adapterError('operation-failed', 'cloud-authority-capability-unavailable');
    }
  }

  private async execute<Operation extends CollabControlOperation>(
    capability: CollabCloudCapability,
    operation: Operation,
    input: CollabControlOperationMap[Operation]['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabControlOperationMap[Operation]['response']> {
    this.requireCapability(capability);
    if (input.projectId !== this.projectId) {
      throw new CollabError({ code: 'project-not-found' });
    }
    const codec = collabControlOperationCodec(operation);
    const decoded = codec.decodeRequest(input);
    if (decoded.status !== 'ok') throw decoded.error;
    const route = collabCloudProjectOperationRoute(input.projectId, operation);
    const response = await this.request({
      body: {
        data: decoded.value,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        requestId: this.requestId(),
      },
      headers: { 'x-claudian-development-actor': this.actorId },
      method: route.method,
      ...(options.signal ? { signal: options.signal } : {}),
      url: new URL(route.target, this.origin).toString(),
    });
    assertJsonResponse(response);
    if (response.status < 200 || response.status >= 300) {
      const envelope = decodeCollabCloudErrorEnvelope(response.body);
      throw new CollabError(envelope.error);
    }
    const envelope = decodeCollabCloudSuccessEnvelope(response.body);
    return codec.decodeResponse(envelope.data);
  }

  private async readRequestDetail(
    projectId: string,
    requestId: string,
    options: { readonly signal?: AbortSignal },
  ) {
    const detail = await this.execute('requests', 'getRequest', {
      projectId,
      requestId,
    }, options);
    if (detail.request.id !== requestId) {
      throw controlIntegrityError('cloud-control-request-detail-mismatch');
    }
    return detail;
  }

  private async readTicketDetail(
    projectId: string,
    ticketId: string,
    options: { readonly signal?: AbortSignal },
  ) {
    const detail = await this.execute('tickets', 'getTicket', {
      projectId,
      ticketId,
    }, options);
    if (detail.ticket.id !== ticketId) {
      throw controlIntegrityError('cloud-control-ticket-detail-mismatch');
    }
    return detail;
  }

  private checkedTicketMutation<Ticket extends { readonly id: string }>(
    ticketId: string,
    ticket: Ticket,
  ): Ticket {
    if (ticket.id !== ticketId) {
      throw controlIntegrityError('cloud-control-ticket-mutation-mismatch');
    }
    return ticket;
  }

  private async updateRequest(
    request: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[0],
    idempotencyKey: string,
    options: { readonly signal?: AbortSignal },
  ) {
    const response = await this.execute('requests', 'updateMyRequestMetadata', {
      description: request.description,
      expectedHeadOid: request.expectedHeadOid,
      expectedRequestRevision: request.expectedRequestRevision,
      idempotencyKey,
      projectId: request.projectId,
      requestId: request.requestId,
    }, options);
    if (response.request.id !== request.requestId || response.request.memberId !== this.memberId) {
      throw controlIntegrityError('cloud-control-request-metadata-mismatch');
    }
    return response.request;
  }

}

export class CloudProjectEventClient {
  private activeRefresh: Promise<void> | null = null;
  private acknowledgedSequence: number;
  private readonly clearTimeout: (handle: number) => void;
  private readonly createSocket: NonNullable<CloudProjectEventClientOptions['createSocket']>;
  private disposed = false;
  private observedSequence: number;
  private readonly origin: string;
  private readonly random: () => number;
  private reconnectAfterRefresh = false;
  private reconnectAttempt = 0;
  private reconnectHandle: number | null = null;
  private pendingInvalidation: CollabAuthorityEventInvalidation | null = null;
  private readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  private socket: CloudProjectEventSocket | null = null;

  constructor(
    private readonly input: CloudProjectEventClientInput,
    private readonly onInvalidation: (
      invalidation: CollabAuthorityEventInvalidation,
    ) => Promise<number>,
    options: CloudProjectEventClientOptions = {},
  ) {
    this.acknowledgedSequence = input.afterSequence;
    this.observedSequence = input.afterSequence;
    this.origin = canonicalCloudOrigin(input.serverUrl, 'serverUrl');
    this.clearTimeout = options.clearTimeout ?? (handle => window.clearTimeout(handle));
    this.createSocket = options.createSocket ?? createDefaultEventSocket;
    this.random = options.random ?? Math.random;
    this.setTimeout = options.setTimeout
      ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
  }

  start(): void {
    if (this.disposed || this.socket) return;
    const route = collabCloudProjectEventsRoute(
      this.input.projectId,
      this.acknowledgedSequence,
    );
    const url = new URL(route.target, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.createSocket({
      headers: { 'x-claudian-development-actor': this.input.developmentActorId },
      url: url.toString(),
    });
    this.socket = socket;
    socket.onOpen(() => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.request({ kind: 'snapshot', sequence: this.acknowledgedSequence });
    });
    socket.onMessage(data => {
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.onError(() => {
      if (this.socket === socket) socket.close(1011, 'Event connection failed');
    });
    socket.onClose(code => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (code === 1008) {
        this.pendingInvalidation = null;
      } else {
        this.reconnectAfterRefresh = true;
        this.scheduleReconnectWhenIdle();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingInvalidation = null;
    this.reconnectAfterRefresh = false;
    if (this.reconnectHandle !== null) {
      this.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Client stopped');
  }

  private handleMessage(data: string): void {
    let message: ReturnType<typeof decodeCollabCloudProjectEventMessage>;
    try {
      message = decodeCollabCloudProjectEventMessage(JSON.parse(data) as unknown);
    } catch {
      this.request({ kind: 'snapshot', sequence: this.observedSequence });
      return;
    }
    if (message.kind === 'snapshot.required') {
      this.observedSequence = Math.max(this.observedSequence, message.latestSequence);
      this.request({ kind: 'snapshot', sequence: message.latestSequence });
      return;
    }
    if (message.projectId !== this.input.projectId || message.sequence <= this.observedSequence) {
      if (message.projectId !== this.input.projectId) {
        this.request({ kind: 'snapshot', sequence: this.observedSequence });
      }
      return;
    }
    if (message.sequence !== this.observedSequence + 1) {
      this.observedSequence = message.sequence;
      this.request({ kind: 'snapshot', sequence: message.sequence });
      return;
    }
    this.observedSequence = message.sequence;
    const requestId = 'requestId' in message.payload ? message.payload.requestId : undefined;
    this.request(requestId === undefined
      ? { kind: 'snapshot', sequence: message.sequence }
      : { kind: 'request', requestId, sequence: message.sequence });
  }

  private request(invalidation: CollabAuthorityEventInvalidation): void {
    if (this.disposed) return;
    if (this.activeRefresh) {
      this.pendingInvalidation = this.coalescePendingInvalidation(
        this.pendingInvalidation,
        invalidation,
      );
      return;
    }
    this.startRefresh(invalidation);
  }

  private startRefresh(invalidation: CollabAuthorityEventInvalidation): void {
    const refresh = Promise.resolve().then(async () => {
      if (this.disposed) return;
      const applied = await this.onInvalidation(invalidation);
      if (this.disposed) return;
      if (!Number.isSafeInteger(applied) || applied < invalidation.sequence) {
        throw adapterError('operation-failed', 'cloud-event-cursor-not-applied');
      }
      this.acknowledgedSequence = Math.max(this.acknowledgedSequence, applied);
      this.observedSequence = Math.max(this.observedSequence, applied);
    }).catch(() => {
      if (this.disposed) return;
      this.pendingInvalidation = null;
      const socket = this.socket;
      if (socket) socket.close(1011, 'Event refresh failed');
    }).finally(() => {
      if (this.activeRefresh !== refresh) return;
      this.activeRefresh = null;
      if (this.disposed) {
        this.pendingInvalidation = null;
        return;
      }
      const pending = this.pendingInvalidation;
      this.pendingInvalidation = null;
      if (pending && pending.sequence > this.acknowledgedSequence) {
        this.startRefresh(pending);
        return;
      }
      this.scheduleReconnectWhenIdle();
    });
    this.activeRefresh = refresh;
  }

  private coalescePendingInvalidation(
    current: CollabAuthorityEventInvalidation | null,
    incoming: CollabAuthorityEventInvalidation,
  ): CollabAuthorityEventInvalidation {
    if (!current) return incoming;
    return {
      kind: 'snapshot',
      sequence: Math.max(current.sequence, incoming.sequence),
    };
  }

  private scheduleReconnectWhenIdle(): void {
    if (!this.reconnectAfterRefresh || this.activeRefresh) return;
    this.reconnectAfterRefresh = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectHandle !== null) return;
    const ceiling = Math.min(
      MAX_RECONNECT_DELAY_MS,
      MIN_RECONNECT_DELAY_MS * (2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectHandle = this.setTimeout(() => {
      this.reconnectHandle = null;
      this.start();
    }, Math.floor(this.random() * ceiling));
  }
}

export class CloudAuthorityAdapter implements CollabAuthorityAdapter {
  readonly authorityKind = 'cloud' as const;
  private readonly createEventClient: NonNullable<CloudAuthorityAdapterOptions['createEventClient']>;
  private readonly request: CloudAuthorityHttpTransport;
  private readonly requestId: () => string;

  constructor(options: CloudAuthorityAdapterOptions = {}) {
    this.createEventClient = options.createEventClient
      ?? ((input, onInvalidation) => new CloudProjectEventClient(input, onInvalidation));
    this.request = options.request ?? defaultHttpTransport;
    this.requestId = options.requestIdFactory
      ?? (() => `cloud-${randomUUID().replaceAll('-', '')}`);
  }

  async create(membership: CollabLocalMembershipRecord): Promise<CollabAuthoritySession> {
    if (!isCollabLocalCloudMembership(membership)) {
      throw new TypeError('Cloud adapter requires a Cloud membership');
    }
    const origin = canonicalCloudOrigin(membership.authority.serverUrl, 'serverUrl');
    const route = collabCloudCapabilitiesRoute();
    const response = await this.request({
      headers: {
        'x-claudian-development-actor': membership.authority.developmentActorId,
      },
      method: route.method,
      url: new URL(route.target, origin).toString(),
    });
    assertJsonResponse(response);
    if (response.status !== 200) {
      throw adapterError('operation-failed', 'cloud-capability-negotiation-failed');
    }
    const document = decodeCollabCloudCapabilityDocument(response.body);
    const capabilities = new Set(document.capabilities);
    const control = new CloudAuthorityControl(
      membership.authority.developmentActorId,
      capabilities,
      membership.member.id,
      origin,
      membership.member.personalRef,
      membership.project.id,
      this.request,
      this.requestId,
    );
    return {
      authorityKind: 'cloud',
      control,
      dispose: () => undefined,
      events: {
        connect: ({ afterSequence, onInvalidation }: CollabAuthorityEventConnectionInput) => {
          if (!collabCloudCapabilitySupported(document, 'project-events')) {
            throw adapterError('operation-failed', 'cloud-authority-capability-unavailable');
          }
          const client = this.createEventClient({
            afterSequence,
            developmentActorId: membership.authority.developmentActorId,
            projectId: membership.project.id,
            serverUrl: origin,
          }, onInvalidation);
          client.start();
          return client;
        },
      },
      git: {
        headers: [{
          name: 'X-Claudian-Development-Actor',
          sensitive: false,
          value: membership.authority.developmentActorId,
        }],
        remoteUrl: membership.authority.gitRemoteUrl,
      },
      supports: capability => collabCloudCapabilitySupported(document, capability),
    };
  }
}
