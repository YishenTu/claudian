import { randomUUID } from 'node:crypto';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferOperation,
  type CollabAuthorityTransferOperationMap,
  type CollabCloudAuthorityTransferArtifact,
  collabCloudAuthorityTransferArtifactRoute,
  collabCloudCapabilitiesRoute,
  type CollabCloudCapability,
  type CollabCloudCapabilityDocument,
  collabCloudCapabilitySupported,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  type CollabControlOperation,
  collabControlOperationCodec,
  type CollabControlOperationMap,
  collabMemberRef,
  type CollabProjectMembershipOperationMap,
  type CollabProjectRetirementOperation,
  type CollabProjectRetirementOperationMap,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudProjectEventMessage,
  decodeCollabCloudSuccessEnvelope,
  isCollabMemberId,
  isCollabProjectId,
} from '@claudian-collab/protocol';
import { type RawData, WebSocket } from 'ws';

import type {
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import {
  cloudAuthorityError,
  cloudAuthorityOperationError,
  cloudAuthorityProtocolError,
  CloudAuthorityRejection,
} from '@/app/collab/remote-authority/CloudAuthorityError';
import {
  cloudProjectGitRemoteUrl,
  resolveCloudRoute,
  validateCloudServerUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';
import {
  CloudPersonalRefReader,
  type CloudPersonalRefReadInput,
} from '@/app/collab/remote-authority/CloudPersonalRefReader';
import { decodeCloudAuthorityProjectSnapshot } from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type {
  CollabAuthorityLifecyclePort,
} from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';
import type { CloudAuthorityMembershipControlPort, CloudMembershipBinding, CloudMembershipOperation } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type {
  CollabAuthorityAdapter,
  CollabAuthorityEventConnectionInput,
  CollabAuthorityEventInvalidation,
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import { completeRequestDetail, completeTicketDetail } from '@/app/collab/remote-authority/completeCollabDetails';
import {
  type CloudAuthorityArtifactTransport,
  NodeCloudAuthorityArtifactTransport,
} from '@/app/collab/remote-authority/NodeCloudAuthorityArtifactTransport';
import {
  type CloudAuthorityHttpRequest,
  type CloudAuthorityHttpResponse,
  type CloudAuthorityHttpTransport,
  NodeCloudAuthorityHttpTransport,
} from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import type { CollabCloudProjectSnapshot, CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const IMPLEMENTED_CLOUD_CAPABILITIES: ReadonlySet<CollabCloudCapability> = new Set([
  'accept',
  'authority-transfer',
  'cloud-imported-membership-claims',
  'cloud-project-invitations',
  'cloud-project-leave',
  'cloud-project-manager-responsibility',
  'cloud-project-membership',
  'git-receive-pack-personal-ref',
  'git-upload-pack',
  'project-events',
  'project-retirement',
  'project-snapshot',
  'requests',
  'tickets',
]);

function cloudCapabilityImplemented(
  document: CollabCloudCapabilityDocument,
  capability: CollabCloudCapability,
): boolean {
  return IMPLEMENTED_CLOUD_CAPABILITIES.has(capability)
    && collabCloudCapabilitySupported(document, capability);
}

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
  readonly projectId: string;
  readonly serverUrl: string;
}

export interface CloudAuthorityAdapterOptions {
  readonly artifacts?: CloudAuthorityArtifactTransport;
  readonly createEventClient?: (
    input: CloudProjectEventClientInput,
    onInvalidation: (invalidation: CollabAuthorityEventInvalidation) => Promise<number>,
  ) => { dispose(): void; start(): void };
  readonly request?: CloudAuthorityHttpTransport;
  readonly requestIdFactory?: () => string;
  readonly readPersonalRef?: (input: CloudPersonalRefReadInput) => Promise<string>;
}

export interface CloudAuthorityConnectionInput {
  readonly projectId: string;
  readonly serverUrl: string;
}

export interface CloudPendingLeaveConnectionInput extends CloudAuthorityConnectionInput {
  readonly authorityGeneration: number;
  readonly memberId: string;
  readonly personalRef: string;
}

export type CloudPendingRetirementConnectionInput = CloudPendingLeaveConnectionInput;

export interface CloudPendingLeaveConnection {
  dispose(): void;
  getManagerResponsibilityOffer(
    request: CollabProjectMembershipOperationMap['getManagerResponsibilityOffer']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['getManagerResponsibilityOffer']['response']>;
  leaveProject(
    request: CollabProjectMembershipOperationMap['leaveProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['leaveProject']['response']>;
  listProjectMembers(
    request: CollabProjectMembershipOperationMap['listProjectMembers']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['listProjectMembers']['response']>;
  readPersonalRefOid(
    personalRef: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  readSnapshot(
    projectId: string,
    options?: Parameters<CollabAuthorityControlPort['readSnapshot']>[1],
  ): Promise<CollabCloudProjectSnapshot>;
}

export interface CloudPendingRetirementConnection {
  dispose(): void;
  listProjectMembers(
    request: CollabProjectMembershipOperationMap['listProjectMembers']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['listProjectMembers']['response']>;
  readSnapshot(
    projectId: string,
    options?: Parameters<CollabAuthorityControlPort['readSnapshot']>[1],
  ): Promise<CollabCloudProjectSnapshot>;
  retireProject(
    request: CollabProjectRetirementOperationMap['retireProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectRetirementOperationMap['retireProject']['response']>;
}

export interface CloudAuthorityConnection {
  joinProject(
    input: CollabControlOperationMap['joinCloudProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabControlOperationMap['joinCloudProject']['response']>;
  createProject(
    input: CollabControlOperationMap['createCloudProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabControlOperationMap['createCloudProject']['response']>;
  dispose(): void;
  readonly git: CollabAuthoritySession['git'];
  readonly lifecycle: CollabAuthorityLifecyclePort;
  readonly projectId: string;
  readSnapshot(
    projectId: string,
    options?: Parameters<CollabAuthorityControlPort['readSnapshot']>[1],
  ): Promise<CollabCloudProjectSnapshot>;
  readonly serverUrl: string;
  supports(capability: CollabCloudCapability): boolean;
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

function controlIntegrityError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertResponseRequestId(actual: string, expected: string): void {
  if (actual !== expected) {
    throw controlIntegrityError('cloud-control-response-request-id-mismatch');
  }
}

function assertJsonResponse(response: CloudAuthorityHttpResponse): void {
  if (
    response.contentType === null
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(response.contentType)
  ) {
    throw cloudAuthorityProtocolError('cloud-authority-content-type-invalid');
  }
}

function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw cloudAuthorityError('cancelled', 'cloud-authority-request-cancelled');
  }
}

class CloudAuthorityControl implements CollabAuthorityControlPort, CollabAuthorityLifecyclePort, CloudAuthorityMembershipControlPort {
  readonly authorityKind = 'cloud' as const;
  readonly #lifetime = new AbortController();

  constructor(
    private readonly artifacts: CloudAuthorityArtifactTransport,
    private readonly capabilities: ReadonlySet<string>,
    private readonly capabilityLimits: Readonly<{
      readonly maxCheckpointCoordinationBytes: number;
      readonly maxCheckpointManifestUtf8Bytes: number;
      readonly maxCheckpointRepositoryBundleBytes: number;
    }>,
    private readonly identity: Readonly<{
      readonly authorityGeneration: number;
      readonly memberId: string;
      readonly personalRef: string;
    }> | null,
    private readonly origin: string,
    private readonly projectId: string,
    private readonly transport: CloudAuthorityHttpTransport,
    private readonly requestId: () => string,
  ) {}

  dispose(): void {
    this.#lifetime.abort();
  }

  assertActive(): void {
    assertRequestActive(this.#lifetime.signal);
  }

  cloudMembership<Operation extends CloudMembershipOperation>(
    operation: Operation,
    request: CollabProjectMembershipOperationMap[Operation]['request'],
    binding: CloudMembershipBinding,
    options: CollabOperationOptions = {},
  ): Promise<CollabProjectMembershipOperationMap[Operation]['response']> {
    if (!this.identity || binding.serverUrl !== this.origin || binding.projectId !== this.projectId
      || binding.memberId !== this.identity.memberId
      || binding.authorityGeneration !== this.identity.authorityGeneration) {
      throw cloudAuthorityOperationError('cloud-membership-binding-mismatch');
    }
    switch (operation) {
      case 'listProjectMembers': return this.execute('cloud-project-membership', operation, request, options);
      case 'demoteManager': return this.execute('cloud-project-membership', operation, request, options);
      case 'removeMember': return this.execute('cloud-project-membership', operation, request, options);
      case 'promoteManager': return this.execute('cloud-project-membership', operation, request, options);
      case 'reissueTransferredMembershipClaim': return this.execute('cloud-imported-membership-claims', operation, request, options);
      case 'revokeTransferredMembershipClaim': return this.execute('cloud-imported-membership-claims', operation, request, options);
      case 'createManagerResponsibilityOffer': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'getManagerResponsibilityOffer': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'listCurrentManagerResponsibilityOffers': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'cancelManagerResponsibilityOffer': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'acknowledgeManagerResponsibility': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'declineManagerResponsibility': return this.execute('cloud-project-manager-responsibility', operation, request, options);
      case 'createProjectInvitation': return this.execute('cloud-project-invitations', operation, request, options);
      case 'listProjectInvitations': return this.execute('cloud-project-invitations', operation, request, options);
      case 'revokeProjectInvitation': return this.execute('cloud-project-invitations', operation, request, options);
      case 'leaveProject': return this.execute('cloud-project-leave', operation, request, options);
      default: throw cloudAuthorityOperationError('cloud-membership-operation-unavailable');
    }
  }

  private signal(caller?: AbortSignal): AbortSignal {
    return caller ? AbortSignal.any([this.#lifetime.signal, caller]) : this.#lifetime.signal;
  }

  private async request(input: CloudAuthorityHttpRequest): Promise<CloudAuthorityHttpResponse> {
    const signal = this.signal(input.signal);
    assertRequestActive(signal);
    const response = await this.transport({ ...input, signal });
    assertRequestActive(signal);
    return response;
  }

  async createProject(
    input: CollabControlOperationMap['createCloudProject']['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabControlOperationMap['createCloudProject']['response']> {
    const response = await this.execute('cloud-project-create', 'createCloudProject', input, options);
    if (response.projectId !== this.projectId) {
      throw controlIntegrityError('cloud-control-created-project-mismatch');
    }
    return response;
  }

  async joinProject(
    input: CollabControlOperationMap['joinCloudProject']['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabControlOperationMap['joinCloudProject']['response']> {
    const response = await this.execute('cloud-project-join', 'joinCloudProject', input, options);
    if (response.projectId !== this.projectId) throw controlIntegrityError('cloud-control-joined-project-mismatch');
    return response;
  }

  authorityTransfer<Operation extends CollabAuthorityTransferOperation>(
    operation: Operation,
    request: CollabAuthorityTransferOperationMap[Operation]['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabAuthorityTransferOperationMap[Operation]['response']> {
    return this.execute('authority-transfer', operation, request, options);
  }

  retirement<Operation extends CollabProjectRetirementOperation>(
    operation: Operation,
    request: CollabProjectRetirementOperationMap[Operation]['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabProjectRetirementOperationMap[Operation]['response']> {
    return this.execute('project-retirement', operation, request, options);
  }

  async uploadAuthorityTransferArtifact(
    input: Parameters<CollabAuthorityLifecyclePort['uploadAuthorityTransferArtifact']>[0],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    this.#requireCapability('authority-transfer');
    this.#assertProject(input.projectId);
    const route = collabCloudAuthorityTransferArtifactRoute(
      input.projectId,
      input.transferId,
      'upload',
      input.artifact,
    );
    const signal = this.signal(options.signal);
    const response = await this.artifacts.upload({
      body: input.body,
      byteCount: input.byteCount,
      headers: {},
      maximumBytes: this.#artifactLimit(input.artifact),
      signal,
      url: resolveCloudRoute(this.origin, route.target),
    });
    assertRequestActive(signal);
    if (response.status === 204) return;
    this.#throwArtifactResponse(response);
  }

  async downloadAuthorityTransferArtifact(
    input: Parameters<CollabAuthorityLifecyclePort['downloadAuthorityTransferArtifact']>[0],
    options: { readonly signal?: AbortSignal } = {},
  ): ReturnType<CollabAuthorityLifecyclePort['downloadAuthorityTransferArtifact']> {
    this.#requireCapability('authority-transfer');
    this.#assertProject(input.projectId);
    const route = collabCloudAuthorityTransferArtifactRoute(
      input.projectId,
      input.transferId,
      'download',
      input.artifact,
    );
    const signal = this.signal(options.signal);
    const response = await this.artifacts.download({
      headers: {},
      maximumBytes: this.#artifactLimit(input.artifact),
      signal,
      url: resolveCloudRoute(this.origin, route.target),
    });
    if ('byteCount' in response && signal.aborted) response.body.destroy();
    assertRequestActive(signal);
    if ('byteCount' in response) {
      return { body: response.body, byteCount: response.byteCount };
    }
    this.#throwArtifactResponse(response);
  }

  async readSnapshot(
    projectId: string,
    options: Parameters<CollabAuthorityControlPort['readSnapshot']>[1] = {},
  ): Promise<CollabCloudProjectSnapshot> {
    this.#requireCapability('project-snapshot');
    if (projectId !== this.projectId) {
      throw new CollabError({ code: 'project-not-found' });
    }
    const route = collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot');
    const decoded = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeRequest({ projectId });
    if (decoded.status !== 'ok') throw decoded.error;
    const requestId = this.requestId();
    const response = await this.request({
      body: {
        data: decoded.value,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        requestId,
      },
      headers: {},
      method: route.method,
      ...(options.signal ? { signal: options.signal } : {}),
      url: resolveCloudRoute(this.origin, route.target),
    });
    assertJsonResponse(response);
    if (response.status < 200 || response.status >= 300) {
      const envelope = decodeCollabCloudErrorEnvelope(response.body);
      assertResponseRequestId(envelope.requestId, requestId);
      throw new CollabError(envelope.error);
    }
    const envelope = decodeCollabCloudSuccessEnvelope(response.body);
    assertResponseRequestId(envelope.requestId, requestId);
    const snapshot = decodeCloudAuthorityProjectSnapshot(envelope.data);
    if (
      snapshot.project.id !== projectId
      || (this.identity !== null && (
        snapshot.currentMember.id !== this.identity.memberId
        || snapshot.currentMember.personalRef !== this.identity.personalRef
        || snapshot.project.authorityGeneration !== this.identity.authorityGeneration
      ))
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
      response.request.memberId !== this.identity?.memberId
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
      response.comment.authorMemberId !== this.identity?.memberId
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
    if (response.ticket.ticket.authorMemberId !== this.identity?.memberId) {
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
    return this.#checkedTicketMutation(request.ticketId, response.ticket);
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
      response.comment.authorMemberId !== this.identity?.memberId
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
    return this.#checkedTicketMutation(request.ticketId, response.ticket);
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
    return this.#checkedTicketMutation(request.ticketId, response.ticket);
  }
  updateRequestMetadata(
    request: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[0],
    idempotencyKey: string,
    options: Parameters<CollabAuthorityControlPort['updateRequestMetadata']>[2] = {},
  ) {
    return this.#updateRequest(request, idempotencyKey, options);
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
    const detail = await this.#readRequestDetail(projectId, requestId, options);
    return completeRequestDetail(
      detail,
      (cursor, limit) => this.listRequestComments(projectId, requestId, { cursor, limit }, options),
      reason => controlIntegrityError(`cloud-control-${reason}`),
    );
  }
  readRequestPage(
    projectId: string,
    requestId: string,
    options: Parameters<CollabAuthorityControlPort['readRequestPage']>[2] = {},
  ) { return this.#readRequestDetail(projectId, requestId, options); }
  async readTicket(
    projectId: string,
    ticketId: string,
    options: Parameters<CollabAuthorityControlPort['readTicket']>[2] = {},
  ) {
    const detail = await this.#readTicketDetail(projectId, ticketId, options);
    return completeTicketDetail(
      detail,
      (cursor, limit) => this.listTicketComments(projectId, ticketId, { cursor, limit }, options),
      (cursor, limit) => this.listTicketAcceptedRelations(projectId, ticketId, { cursor, limit }, options),
      reason => controlIntegrityError(`cloud-control-${reason}`),
    );
  }
  readTicketPage(
    projectId: string,
    ticketId: string,
    options: Parameters<CollabAuthorityControlPort['readTicketPage']>[2] = {},
  ) { return this.#readTicketDetail(projectId, ticketId, options); }

  #requireCapability(capability: CollabCloudCapability): void {
    this.assertActive();
    if (!this.capabilities.has(capability)) {
      throw cloudAuthorityOperationError('cloud-authority-capability-unavailable');
    }
  }

   #assertProject(projectId: string): void {
    if (projectId !== this.projectId) throw new CollabError({ code: 'project-not-found' });
  }

   #artifactLimit(
    artifact: CollabCloudAuthorityTransferArtifact,
  ): number {
    switch (artifact) {
      case 'checkpoint.json': return this.capabilityLimits.maxCheckpointManifestUtf8Bytes;
      case 'coordination.ndjson': return this.capabilityLimits.maxCheckpointCoordinationBytes;
      case 'repository.bundle': return this.capabilityLimits.maxCheckpointRepositoryBundleBytes;
    }
  }

   #throwArtifactResponse(response: CloudAuthorityHttpResponse): never {
    assertJsonResponse(response);
    const envelope = decodeCollabCloudErrorEnvelope(response.body);
    throw new CollabError(envelope.error);
  }

  private async execute<Operation extends CollabControlOperation>(
    capability: CollabCloudCapability,
    operation: Operation,
    input: CollabControlOperationMap[Operation]['request'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabControlOperationMap[Operation]['response']> {
    this.#requireCapability(capability);
    if (input.projectId !== this.projectId) {
      throw new CollabError({ code: 'project-not-found' });
    }
    const codec = collabControlOperationCodec(operation);
    const decoded = codec.decodeRequest(input);
    if (decoded.status !== 'ok') throw decoded.error;
    const route = collabCloudProjectOperationRoute(input.projectId, operation);
    const requestId = this.requestId();
    const response = await this.request({
      body: {
        data: decoded.value,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        requestId,
      },
      headers: {},
      method: route.method,
      ...(options.signal ? { signal: options.signal } : {}),
      url: resolveCloudRoute(this.origin, route.target),
    });
    assertJsonResponse(response);
    if (response.status < 200 || response.status >= 300) {
      const envelope = decodeCollabCloudErrorEnvelope(response.body);
      assertResponseRequestId(envelope.requestId, requestId);
      throw new CloudAuthorityRejection(envelope.error);
    }
    const envelope = decodeCollabCloudSuccessEnvelope(response.body);
    assertResponseRequestId(envelope.requestId, requestId);
    return codec.decodeResponse(envelope.data);
  }

   async #readRequestDetail(
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

   async #readTicketDetail(
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

   #checkedTicketMutation<Ticket extends { readonly id: string }>(
    ticketId: string,
    ticket: Ticket,
  ): Ticket {
    if (ticket.id !== ticketId) {
      throw controlIntegrityError('cloud-control-ticket-mutation-mismatch');
    }
    return ticket;
  }

   async #updateRequest(
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
    if (response.request.id !== request.requestId || response.request.memberId !== this.identity?.memberId) {
      throw controlIntegrityError('cloud-control-request-metadata-mismatch');
    }
    return response.request;
  }

}

export class CloudProjectEventClient {
   #activeRefresh: Promise<void> | null = null;
   #acknowledgedSequence: number;
  private readonly clearTimeout: (handle: number) => void;
   readonly #createSocket: NonNullable<CloudProjectEventClientOptions['createSocket']>;
  private disposed = false;
   #observedSequence: number;
  private readonly origin: string;
   readonly #random: () => number;
   #reconnectAfterRefresh = false;
   #reconnectAttempt = 0;
   #reconnectHandle: number | null = null;
   #pendingInvalidation: CollabAuthorityEventInvalidation | null = null;
  private readonly setTimeout: (callback: () => void, milliseconds: number) => number;
   #socket: CloudProjectEventSocket | null = null;

  constructor(
    private readonly input: CloudProjectEventClientInput,
    private readonly onInvalidation: (
      invalidation: CollabAuthorityEventInvalidation,
    ) => Promise<number>,
    options: CloudProjectEventClientOptions = {},
  ) {
    this.#acknowledgedSequence = input.afterSequence;
    this.#observedSequence = input.afterSequence;
    this.origin = validateCloudServerUrl(input.serverUrl, 'serverUrl');
    this.clearTimeout = options.clearTimeout ?? (handle => window.clearTimeout(handle));
    this.#createSocket = options.createSocket ?? createDefaultEventSocket;
    this.#random = options.random ?? Math.random;
    this.setTimeout = options.setTimeout
      ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
  }

  start(): void {
    if (this.disposed || this.#socket) return;
    const route = collabCloudProjectEventsRoute(
      this.input.projectId,
      this.#acknowledgedSequence,
    );
    const url = new URL(resolveCloudRoute(this.origin, route.target));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.#createSocket({
      headers: {},
      url: url.toString(),
    });
    this.#socket = socket;
    socket.onOpen(() => {
      if (this.#socket !== socket) return;
      this.#reconnectAttempt = 0;
      this.request({ kind: 'snapshot', sequence: this.#acknowledgedSequence });
    });
    socket.onMessage(data => {
      if (this.#socket === socket) this.#handleMessage(data);
    });
    socket.onError(() => {
      if (this.#socket === socket) socket.close(1011, 'Event connection failed');
    });
    socket.onClose(code => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (code === 1008) {
        this.#pendingInvalidation = null;
      } else {
        this.#reconnectAfterRefresh = true;
        this.#scheduleReconnectWhenIdle();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#pendingInvalidation = null;
    this.#reconnectAfterRefresh = false;
    if (this.#reconnectHandle !== null) {
      this.clearTimeout(this.#reconnectHandle);
      this.#reconnectHandle = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, 'Client stopped');
  }

   #handleMessage(data: string): void {
    let message: ReturnType<typeof decodeCollabCloudProjectEventMessage>;
    try {
      message = decodeCollabCloudProjectEventMessage(JSON.parse(data) as unknown);
    } catch {
      this.request({ kind: 'snapshot', sequence: this.#observedSequence });
      return;
    }
    if (message.kind === 'snapshot.required') {
      this.#observedSequence = Math.max(this.#observedSequence, message.latestSequence);
      this.request({ kind: 'snapshot', sequence: message.latestSequence });
      return;
    }
    if (message.projectId !== this.input.projectId || message.sequence <= this.#observedSequence) {
      if (message.projectId !== this.input.projectId) {
        this.request({ kind: 'snapshot', sequence: this.#observedSequence });
      }
      return;
    }
    if (message.sequence !== this.#observedSequence + 1) {
      this.#observedSequence = message.sequence;
      this.request({ kind: 'snapshot', sequence: message.sequence });
      return;
    }
    this.#observedSequence = message.sequence;
    if (message.kind === 'project.retired') {
      this.request({
        kind: 'retired',
        retiredAt: message.payload.retiredAt,
        retirementId: message.payload.retirementId,
        sequence: message.sequence,
      });
      return;
    }
    const requestId = 'requestId' in message.payload ? message.payload.requestId : undefined;
    this.request(requestId === undefined
      ? { kind: 'snapshot', sequence: message.sequence }
      : { kind: 'request', requestId, sequence: message.sequence });
  }

  private request(invalidation: CollabAuthorityEventInvalidation): void {
    if (this.disposed) return;
    if (this.#activeRefresh) {
      this.#pendingInvalidation = this.#coalescePendingInvalidation(
        this.#pendingInvalidation,
        invalidation,
      );
      return;
    }
    this.#startRefresh(invalidation);
  }

   #startRefresh(invalidation: CollabAuthorityEventInvalidation): void {
    const refresh = Promise.resolve().then(async () => {
      if (this.disposed) return;
      const applied = await this.onInvalidation(invalidation);
      if (this.disposed) return;
      if (!Number.isSafeInteger(applied) || applied < invalidation.sequence) {
        throw cloudAuthorityOperationError('cloud-event-cursor-not-applied');
      }
      this.#acknowledgedSequence = Math.max(this.#acknowledgedSequence, applied);
      this.#observedSequence = Math.max(this.#observedSequence, applied);
    }).catch(() => {
      if (this.disposed) return;
      this.#pendingInvalidation = null;
      const socket = this.#socket;
      if (socket) socket.close(1011, 'Event refresh failed');
    }).finally(() => {
      if (this.#activeRefresh !== refresh) return;
      this.#activeRefresh = null;
      if (this.disposed) {
        this.#pendingInvalidation = null;
        return;
      }
      const pending = this.#pendingInvalidation;
      this.#pendingInvalidation = null;
      if (pending && pending.sequence > this.#acknowledgedSequence) {
        this.#startRefresh(pending);
        return;
      }
      this.#scheduleReconnectWhenIdle();
    });
    this.#activeRefresh = refresh;
  }

   #coalescePendingInvalidation(
    current: CollabAuthorityEventInvalidation | null,
    incoming: CollabAuthorityEventInvalidation,
  ): CollabAuthorityEventInvalidation {
    if (!current) return incoming;
    if (incoming.kind === 'retired') return incoming;
    if (current.kind === 'retired') return current;
    return {
      kind: 'snapshot',
      sequence: Math.max(current.sequence, incoming.sequence),
    };
  }

   #scheduleReconnectWhenIdle(): void {
    if (!this.#reconnectAfterRefresh || this.#activeRefresh) return;
    this.#reconnectAfterRefresh = false;
    this.#scheduleReconnect();
  }

   #scheduleReconnect(): void {
    if (this.disposed || this.#reconnectHandle !== null) return;
    const ceiling = Math.min(
      MAX_RECONNECT_DELAY_MS,
      MIN_RECONNECT_DELAY_MS * (2 ** this.#reconnectAttempt),
    );
    this.#reconnectAttempt += 1;
    this.#reconnectHandle = this.setTimeout(() => {
      this.#reconnectHandle = null;
      this.start();
    }, Math.floor(this.#random() * ceiling));
  }
}

export class CloudAuthorityAdapter implements CollabAuthorityAdapter {
  readonly authorityKind = 'cloud' as const;
   readonly #createEventClient: NonNullable<CloudAuthorityAdapterOptions['createEventClient']>;
  private readonly artifacts: CloudAuthorityArtifactTransport;
  private readonly readPersonalRef: NonNullable<CloudAuthorityAdapterOptions['readPersonalRef']>;
  private readonly request: CloudAuthorityHttpTransport;
  private readonly requestId: () => string;

  constructor(options: CloudAuthorityAdapterOptions = {}) {
    this.artifacts = options.artifacts ?? new NodeCloudAuthorityArtifactTransport();
    this.#createEventClient = options.createEventClient
      ?? ((input, onInvalidation) => new CloudProjectEventClient(input, onInvalidation));
    const personalRefs = new CloudPersonalRefReader();
    this.readPersonalRef = options.readPersonalRef ?? (input => personalRefs.read(input));
    this.request = options.request ?? new NodeCloudAuthorityHttpTransport().request;
    this.requestId = options.requestIdFactory
      ?? (() => `cloud-${randomUUID().replaceAll('-', '')}`);
  }

  async create(
    membership: CollabLocalMembershipRecord,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthoritySession> {
    if (!isCollabLocalCloudMembership(membership)) {
      throw new TypeError('Cloud adapter requires a Cloud membership');
    }
    const { authorityGeneration, bindingVersion, gitRemoteUrl, serverUrl, wireVersion } = membership.authority;
    const projectId = membership.project.id;
    const { id: memberId, personalRef } = membership.member;
    if (
      typeof authorityGeneration !== 'number'
      || !Number.isSafeInteger(authorityGeneration)
      || authorityGeneration < 1
      || bindingVersion !== COLLAB_CLOUD_BINDING_VERSION
      || wireVersion !== COLLAB_PROTOCOL_VERSION
      || !isCollabProjectId(projectId)
      || !isCollabMemberId(memberId)
      || personalRef !== collabMemberRef(memberId)
      || gitRemoteUrl !== cloudProjectGitRemoteUrl(serverUrl, projectId)
    ) throw new TypeError('Invalid Cloud authority binding');
    const { document, origin } = await this.#negotiate(serverUrl, options);
    const capabilities = new Set(document.capabilities);
    const control = new CloudAuthorityControl(
      this.artifacts,
      capabilities,
      document.limits,
      {
        authorityGeneration,
        memberId,
        personalRef,
      },
      origin,
      projectId,
      this.request,
      this.requestId,
    );
    try {
      await control.readSnapshot(projectId, options);
    } catch (error) {
      control.dispose();
      throw error;
    }
    let eventConnection: { dispose(): void } | null = null;
    return {
      authorityKind: 'cloud',
      control,
      dispose: () => {
        control.dispose();
        eventConnection?.dispose();
      },
      events: {
        connect: ({ afterSequence, onInvalidation }: CollabAuthorityEventConnectionInput) => {
          control.assertActive();
          if (!collabCloudCapabilitySupported(document, 'project-events')) {
            throw cloudAuthorityOperationError('cloud-authority-capability-unavailable');
          }
          const client = this.#createEventClient({
            afterSequence,
            projectId,
            serverUrl: origin,
          }, onInvalidation);
          const connection = {
            dispose: () => {
              if (eventConnection !== connection) return;
              eventConnection = null;
              client.dispose();
            },
          };
          eventConnection?.dispose();
          eventConnection = connection;
          try {
            client.start();
            return connection;
          } catch (error) {
            connection.dispose();
            throw error;
          }
        },
      },
      git: {
        headers: [],
        remoteUrl: gitRemoteUrl,
      },
      lifecycle: control,
      membership: control,
      supports: capability => cloudCapabilityImplemented(document, capability),
    };
  }

  async connectPendingLeave(
    binding: CloudPendingLeaveConnectionInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudPendingLeaveConnection> {
    if (
      !isCollabProjectId(binding.projectId)
      || !isCollabMemberId(binding.memberId)
      || binding.personalRef !== collabMemberRef(binding.memberId)
      || !Number.isSafeInteger(binding.authorityGeneration)
      || binding.authorityGeneration < 1
    ) throw new TypeError('Invalid Cloud pending Leave binding');
    const { document, origin } = await this.#negotiate(binding.serverUrl, options);
    const capabilities = new Set(document.capabilities);
    const control = new CloudAuthorityControl(
      this.artifacts,
      capabilities,
      document.limits,
      {
        authorityGeneration: binding.authorityGeneration,
        memberId: binding.memberId,
        personalRef: binding.personalRef,
      },
      origin,
      binding.projectId,
      this.request,
      this.requestId,
    );
    const membershipBinding: CloudMembershipBinding = {
      authorityGeneration: binding.authorityGeneration,
      memberId: binding.memberId,
      projectId: binding.projectId,
      serverUrl: origin,
    };
    const lifetime = new AbortController();
    const requestOptions = (
      caller: { readonly signal?: AbortSignal } = {},
    ): { readonly signal: AbortSignal } => ({
      signal: caller.signal
        ? AbortSignal.any([lifetime.signal, caller.signal])
        : lifetime.signal,
    });
    return {
      dispose: () => {
        lifetime.abort();
        control.dispose();
      },
      getManagerResponsibilityOffer: (request, requestOptionsInput) => (
        control.cloudMembership(
          'getManagerResponsibilityOffer',
          request,
          membershipBinding,
          requestOptions(requestOptionsInput),
        )
      ),
      leaveProject: (request, requestOptionsInput) => control.cloudMembership(
        'leaveProject',
        request,
        membershipBinding,
        requestOptions(requestOptionsInput),
      ),
      listProjectMembers: (request, requestOptionsInput) => control.cloudMembership(
        'listProjectMembers',
        request,
        membershipBinding,
        requestOptions(requestOptionsInput),
      ),
      readPersonalRefOid: (personalRef, requestOptionsInput) => {
        if (
          personalRef !== binding.personalRef
          || !cloudCapabilityImplemented(document, 'git-upload-pack')
        ) throw controlIntegrityError('cloud-pending-leave-personal-ref-mismatch');
        return this.readPersonalRef({
          personalRef,
          projectId: binding.projectId,
          serverUrl: origin,
          ...requestOptions(requestOptionsInput),
        });
      },
      readSnapshot: (projectId, requestOptionsInput) => control.readSnapshot(
        projectId,
        requestOptions(requestOptionsInput),
      ),
    };
  }

  async connectPendingRetirement(
    binding: CloudPendingRetirementConnectionInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudPendingRetirementConnection> {
    if (
      !isCollabProjectId(binding.projectId)
      || !isCollabMemberId(binding.memberId)
      || binding.personalRef !== collabMemberRef(binding.memberId)
      || !Number.isSafeInteger(binding.authorityGeneration)
      || binding.authorityGeneration < 1
    ) throw new TypeError('Invalid Cloud pending Retirement binding');
    const { document, origin } = await this.#negotiate(binding.serverUrl, options);
    const control = new CloudAuthorityControl(
      this.artifacts,
      new Set(document.capabilities),
      document.limits,
      {
        authorityGeneration: binding.authorityGeneration,
        memberId: binding.memberId,
        personalRef: binding.personalRef,
      },
      origin,
      binding.projectId,
      this.request,
      this.requestId,
    );
    const membershipBinding: CloudMembershipBinding = {
      authorityGeneration: binding.authorityGeneration,
      memberId: binding.memberId,
      projectId: binding.projectId,
      serverUrl: origin,
    };
    const lifetime = new AbortController();
    const requestOptions = (
      caller: { readonly signal?: AbortSignal } = {},
    ): { readonly signal: AbortSignal } => ({
      signal: caller.signal
        ? AbortSignal.any([lifetime.signal, caller.signal])
        : lifetime.signal,
    });
    return {
      dispose: () => {
        lifetime.abort();
        control.dispose();
      },
      listProjectMembers: (request, requestOptionsInput) => control.cloudMembership(
        'listProjectMembers',
        request,
        membershipBinding,
        requestOptions(requestOptionsInput),
      ),
      readSnapshot: (projectId, requestOptionsInput) => control.readSnapshot(
        projectId,
        requestOptions(requestOptionsInput),
      ),
      retireProject: (request, requestOptionsInput) => control.retirement(
        'retireProject',
        request,
        requestOptions(requestOptionsInput),
      ),
    };
  }

  async connect(
    binding: CloudAuthorityConnectionInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudAuthorityConnection> {
    const { projectId, serverUrl } = binding;
    const remoteUrl = cloudProjectGitRemoteUrl(serverUrl, projectId);
    const { document, origin } = await this.#negotiate(serverUrl, options);
    const capabilities = new Set(document.capabilities);
    const lifecycle = new CloudAuthorityControl(
      this.artifacts,
      capabilities,
      document.limits,
      null,
      origin,
      projectId,
      this.request,
      this.requestId,
    );
    return {
      createProject: (input, options) => lifecycle.createProject(input, options),
      joinProject: (input, options) => lifecycle.joinProject(input, options),
      dispose: () => lifecycle.dispose(),
      git: { headers: [], remoteUrl },
      lifecycle,
      projectId,
      readSnapshot: (projectId, options) => lifecycle.readSnapshot(projectId, options),
      serverUrl: origin,
      supports: capability => cloudCapabilityImplemented(document, capability),
    };
  }

   async #negotiate(
    serverUrl: string,
    options: CollabOperationOptions,
  ): Promise<{ readonly document: CollabCloudCapabilityDocument; readonly origin: string }> {
    assertRequestActive(options.signal);
    const origin = validateCloudServerUrl(serverUrl, 'serverUrl');
    const route = collabCloudCapabilitiesRoute();
    const response = await this.request({
      headers: {},
      method: route.method,
      ...(options.signal ? { signal: options.signal } : {}),
      url: resolveCloudRoute(origin, route.target),
    });
    assertRequestActive(options.signal);
    assertJsonResponse(response);
    if (response.status !== 200) {
      throw cloudAuthorityOperationError('cloud-capability-negotiation-failed');
    }
    const document = decodeCollabCloudCapabilityDocument(response.body);
    if (
      !document.bindingVersions.includes(COLLAB_CLOUD_BINDING_VERSION)
      || !document.protocolVersions.includes(COLLAB_PROTOCOL_VERSION)
    ) {
      throw new CollabError({
        code: 'protocol-version-unsupported',
        recoveryActions: ['open-diagnostics'],
        safeContext: {
          reason: 'cloud-authority-version-unsupported',
          supportedBindingVersion: COLLAB_CLOUD_BINDING_VERSION,
          supportedProtocolVersion: COLLAB_PROTOCOL_VERSION,
        },
      });
    }
    return { document, origin };
  }
}
