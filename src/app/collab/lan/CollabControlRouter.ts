import { randomUUID } from 'node:crypto';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';

import { isCollabProjectId } from '@claudian/collab-protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  COLLAB_CONTROL_MAX_BODY_BYTES,
  COLLAB_CONTROL_PROTOCOL_VERSION,
} from '@/app/collab/lan/LanCollabConstants';
import {
  type LifecycleGatewayPort,
  TerminalLifecycleGateway,
} from '@/app/collab/lan/lifecycle/LifecycleGateway';
import { handleJoinRoute } from '@/app/collab/lan/routes/JoinRoutes';
import {
  handleLifecycleRoute,
  isLifecycleControlRoute,
} from '@/app/collab/lan/routes/LifecycleRoutes';
import { handleMembershipRoute } from '@/app/collab/lan/routes/MembershipRoutes';
import { handleProjectRoute } from '@/app/collab/lan/routes/ProjectRoutes';
import { handleRequestRoute } from '@/app/collab/lan/routes/RequestRoutes';
import type {
  CollabControlProjectService,
  CollabControlRouteRequest,
  CollabControlRouteResult,
  CollabTerminalControlRouteRequest,
  CollabTerminalProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import { handleTicketRoute } from '@/app/collab/lan/routes/TicketRoutes';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CONTROL_URL_LENGTH = 2_048;

export type { CollabControlProjectService } from './routes/RouteTypes';
export type { CollabTerminalProjectService } from './routes/RouteTypes';

export interface CollabEventAuthenticationInput {
  readonly authorization?: string;
  readonly lastSequence?: string;
  readonly url?: string;
}

export interface CollabEventAuthentication {
  readonly lastSequence: number;
  readonly memberId: string;
  readonly projectId: string;
}

export interface CollabControlAdmissionPort {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

interface RegisteredProject {
  readonly routing: CollabActiveProjectRouting;
  readonly service: CollabControlProjectService;
}

export interface CollabActiveProjectRouting {
  readonly admission?: CollabControlAdmissionPort;
  readonly lifecycle: LifecycleGatewayPort;
}

interface RegisteredTerminalProject {
  readonly lifecycle: LifecycleGatewayPort;
  readonly service: CollabTerminalProjectService;
}

function routerError(
  code:
    | 'authentication-failed'
    | 'cancelled'
    | 'operation-failed'
    | 'project-not-found'
    | 'protocol-payload-invalid',
  reason: string,
): CollabError {
  return new CollabError({ code, safeContext: { reason } });
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

function requestId(headers: IncomingHttpHeaders): string {
  const supplied = singleHeader(headers, 'x-request-id');
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function parseProjectUrl(rawUrl: string | undefined): {
  readonly projectId: string;
  readonly protocolVersion: number;
  readonly query: Readonly<Record<string, string>>;
  readonly segments: readonly string[];
} {
  if (!rawUrl || rawUrl.length > MAX_CONTROL_URL_LENGTH) {
    throw routerError('protocol-payload-invalid', 'control-url-invalid');
  }
  let url: URL;
  try {
    url = new URL(rawUrl, 'https://claudian.invalid');
  } catch {
    throw routerError('protocol-payload-invalid', 'control-url-invalid');
  }
  if (url.hash.length > 0) {
    throw routerError('protocol-payload-invalid', 'control-url-query-forbidden');
  }
  const match = /^\/v(\d+)\/projects\/([^/]+)\/(.+)$/
    .exec(url.pathname);
  if (!match || !isCollabProjectId(match[2])) {
    throw routerError('project-not-found', 'control-route-not-found');
  }
  const protocolVersion = Number(match[1]);
  if (!Number.isSafeInteger(protocolVersion)) {
    throw routerError('project-not-found', 'control-route-not-found');
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) {
      throw routerError('protocol-payload-invalid', 'control-url-query-duplicate');
    }
    query[key] = value;
  }
  return {
    projectId: match[2],
    protocolVersion,
    query,
    segments: match[3].split('/'),
  };
}

function assertRouteVersion(
  protocolVersion: number,
): void {
  if (protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION) {
    throw routerError('project-not-found', 'control-route-version-unsupported');
  }
}

function statusForError(error: CollabError): number {
  const reason = error.safeContext.reason;
  if (reason === 'control-request-too-large') return 413;
  switch (error.code) {
    case 'authentication-failed': return 401;
    case 'authorization-denied': return 403;
    case 'project-not-found': return 404;
    case 'invitation-expired':
    case 'invitation-revoked':
    case 'membership-revoked': return 410;
    case 'project-retired': return 410;
    case 'operation-timeout': return 408;
    case 'idempotency-conflict':
    case 'request-head-not-pushed':
    case 'request-not-open':
    case 'stale-request-metadata':
    case 'stale-ticket':
    case 'stale-main':
    case 'stale-project-selection':
    case 'stale-request-head': return 409;
    case 'ticket-not-found': return 404;
    case 'path-invalid':
    case 'path-not-portable':
    case 'quota-exceeded':
    case 'unsupported-file-type': return 422;
    case 'protocol-payload-invalid':
    case 'invitation-invalid': return 400;
    default: return 500;
  }
}

function asCollabError(error: unknown): CollabError {
  return error instanceof CollabError
    ? error
    : routerError('operation-failed', 'control-route-failed');
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  requestIdValue: string,
  body: unknown,
): void {
  if (response.headersSent || response.destroyed) return;
  let bytes = Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.length > COLLAB_CONTROL_MAX_BODY_BYTES) {
    // Final-serialization backstop: contract-bounded pages always fit, so an
    // oversized body is a producer defect and must fail closed rather than
    // emit a response the client will reject mid-stream.
    statusCode = 500;
    bytes = Buffer.from(JSON.stringify({
      error: new CollabError({
        code: 'operation-failed',
        recoveryActions: ['open-diagnostics'],
        safeContext: { reason: 'control-response-too-large' },
      }).toJSON(),
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      requestId: requestIdValue,
    }), 'utf8');
  }
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestIdValue,
  });
  response.end(bytes);
}

function invokeAfterResponseFlush(
  response: ServerResponse,
  callback: (() => void) | undefined,
): void {
  if (!callback) return;
  let closedBeforeFinish = false;
  let invoked = false;
  response.once('close', () => {
    if (!response.writableFinished) closedBeforeFinish = true;
  });
  response.once('finish', () => {
    if (closedBeforeFinish || invoked) return;
    invoked = true;
    queueMicrotask(callback);
  });
}

function invokeAfterResponseSettles(
  response: ServerResponse,
  callback: (() => void) | undefined,
): void {
  if (!callback) return;
  let invoked = false;
  const invoke = () => {
    if (invoked) return;
    invoked = true;
    queueMicrotask(callback);
  };
  if (response.destroyed || response.writableFinished) {
    invoke();
    return;
  }
  response.once('finish', invoke);
  response.once('close', invoke);
}

interface CollabControlRequestBody {
  readonly present: boolean;
  readonly value: unknown;
}

function readJsonBody(request: IncomingMessage): Promise<CollabControlRequestBody> {
  const contentLength = request.headers['content-length'];
  if (
    typeof contentLength === 'string'
    && Number(contentLength) > COLLAB_CONTROL_MAX_BODY_BYTES
  ) {
    request.resume();
    return Promise.reject(routerError(
      'protocol-payload-invalid',
      'control-request-too-large',
    ));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      operation();
    };
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > COLLAB_CONTROL_MAX_BODY_BYTES) {
        request.resume();
        finish(() => reject(routerError(
          'protocol-payload-invalid',
          'control-request-too-large',
        )));
        return;
      }
      chunks.push(buffer);
    });
    request.once('aborted', () => {
      finish(() => reject(routerError('cancelled', 'control-request-aborted')));
    });
    request.once('error', () => {
      finish(() => reject(routerError('operation-failed', 'control-request-read-failed')));
    });
    request.once('end', () => {
      if (settled) return;
      const contents = Buffer.concat(chunks).toString('utf8');
      if (contents.length === 0) {
        finish(() => resolve({ present: false, value: {} }));
        return;
      }
      if (!request.headers['content-type']?.toLocaleLowerCase('en-US').startsWith(
        'application/json',
      )) {
        finish(() => reject(routerError(
          'protocol-payload-invalid',
          'control-content-type-invalid',
        )));
        return;
      }
      try {
        const value: unknown = JSON.parse(contents) as unknown;
        finish(() => resolve({ present: true, value }));
      } catch {
        finish(() => reject(routerError(
          'protocol-payload-invalid',
          'control-request-json-invalid',
        )));
      }
    });
  });
}

export class CollabControlRouter {
  private readonly projects = new Map<string, RegisteredProject>();
  private readonly terminalProjects = new Map<string, RegisteredTerminalProject>();

  registerProject(
    projectId: string,
    service: CollabControlProjectService,
    routing: CollabActiveProjectRouting,
  ): void {
    if (!isCollabProjectId(projectId)) {
      throw routerError('operation-failed', 'host-project-id-invalid');
    }
    const existing = this.projects.get(projectId);
    if (existing && existing.service !== service) {
      throw routerError('operation-failed', 'host-project-already-registered');
    }
    this.projects.set(projectId, {
      routing,
      service,
    });
  }

  unregisterProject(projectId: string): boolean {
    return this.projects.delete(projectId);
  }

  registerTerminalProject(
    projectId: string,
    service: CollabTerminalProjectService,
  ): void {
    if (!isCollabProjectId(projectId)) {
      throw routerError('operation-failed', 'host-project-id-invalid');
    }
    const existing = this.terminalProjects.get(projectId);
    if (existing && existing.service !== service) {
      throw routerError('operation-failed', 'host-terminal-project-already-registered');
    }
    this.terminalProjects.set(projectId, {
      lifecycle: new TerminalLifecycleGateway(service),
      service,
    });
  }

  unregisterTerminalProject(projectId: string): boolean {
    return this.terminalProjects.delete(projectId);
  }

  hasTerminalProject(projectId: string): boolean {
    return this.terminalProjects.has(projectId);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestIdValue = requestId(request.headers);
    try {
      const route = parseProjectUrl(request.url);
      assertRouteVersion(route.protocolVersion);
      const operationMatch = matchCollabControlOperation(request.method, route.segments);
      const operationBinding = operationMatch
        ? COLLAB_CONTROL_OPERATION_BINDINGS[operationMatch.operation]
        : null;
      if (
        Object.keys(route.query).length > 0
        && operationBinding?.requestSource !== 'path-and-query'
      ) {
        throw routerError('protocol-payload-invalid', 'control-url-query-forbidden');
      }
      const requestBody = await readJsonBody(request);
      if (
        requestBody.present
        && (
          operationBinding?.requestSource === 'path'
          || operationBinding?.requestSource === 'path-and-query'
        )
      ) {
        throw routerError('protocol-payload-invalid', 'control-request-body-forbidden');
      }
      const body = requestBody.value;
      const registered = this.projects.get(route.projectId);
      if (!registered) {
        const terminal = this.terminalProjects.get(route.projectId);
        if (!terminal) throw routerError('project-not-found', 'host-project-not-running');
        const result = await this.dispatchTerminal({
          authorization: singleHeader(request.headers, 'authorization'),
          body,
          idempotencyKey: singleHeader(request.headers, 'idempotency-key'),
          method: request.method ?? '',
          ...(operationMatch ? { operationMatch } : {}),
          projectId: route.projectId,
          query: route.query,
          remoteAddress: normalizeRemoteAddress(request.socket.remoteAddress),
          segments: route.segments,
          lifecycle: terminal.lifecycle,
        }, terminal.service);
        invokeAfterResponseFlush(response, result.afterResponseFlushed);
        invokeAfterResponseSettles(response, result.afterResponseSettled);
        writeJson(response, operationBinding?.successStatus ?? 200, requestIdValue, {
          data: result.data,
          protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
          requestId: requestIdValue,
        });
        return;
      }
      const routeRequest: CollabControlRouteRequest = {
        authorization: singleHeader(request.headers, 'authorization'),
        body,
        idempotencyKey: singleHeader(request.headers, 'idempotency-key'),
        lifecycle: registered.routing.lifecycle,
        method: request.method ?? '',
        ...(operationMatch ? { operationMatch } : {}),
        projectId: route.projectId,
        query: route.query,
        remoteAddress: normalizeRemoteAddress(request.socket.remoteAddress),
        segments: route.segments,
        service: registered.service,
      };
      const dispatch = () => this.dispatch(routeRequest);
      const lifecycleRoute = operationBinding
        ? operationBinding.family === 'lifecycle'
        : isLifecycleControlRoute(request.method, route.segments);
      const requiresOuterAdmission = operationBinding
        ? operationBinding.admission === 'active' && !lifecycleRoute
        : !lifecycleRoute;
      const result = registered.routing.admission && requiresOuterAdmission
        ? await registered.routing.admission.run(dispatch)
        : await dispatch();
      if (!result) throw routerError('project-not-found', 'control-route-not-found');
      invokeAfterResponseFlush(response, result.afterResponseFlushed);
      invokeAfterResponseSettles(response, result.afterResponseSettled);
      writeJson(response, operationBinding?.successStatus ?? 200, requestIdValue, {
        data: result.data,
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: requestIdValue,
      });
    } catch (error) {
      const collabError = asCollabError(error);
      writeJson(response, statusForError(collabError), requestIdValue, {
        error: collabError.toJSON(),
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: requestIdValue,
      });
    }
  }

  async authenticateEvent(
    input: CollabEventAuthenticationInput,
  ): Promise<CollabEventAuthentication> {
    let route: ReturnType<typeof parseProjectUrl>;
    try {
      route = parseProjectUrl(input.url);
    } catch {
      throw routerError('authentication-failed', 'event-route-invalid');
    }
    if (
      route.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
      || route.segments.length !== 1
      || route.segments[0] !== 'events'
    ) {
      throw routerError('authentication-failed', 'event-route-invalid');
    }
    const registered = this.projects.get(route.projectId);
    if (!registered) throw routerError('authentication-failed', 'event-project-not-running');
    const authorization = input.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw routerError('authentication-failed', 'event-authorization-invalid');
    }
    const credential = authorization.slice('Bearer '.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw routerError('authentication-failed', 'event-credential-invalid');
    }
    const lastSequenceValue = input.lastSequence ?? '0';
    if (!/^\d+$/.test(lastSequenceValue)) {
      throw routerError('authentication-failed', 'event-sequence-invalid');
    }
    const lastSequence = Number(lastSequenceValue);
    if (!Number.isSafeInteger(lastSequence)) {
      throw routerError('authentication-failed', 'event-sequence-invalid');
    }
    const authenticate = () => registered.service.authenticateMemberCredential(
      credential,
      ['active'],
    );
    const authenticated = registered.routing.admission
      ? await registered.routing.admission.run(authenticate)
      : await authenticate();
    return { lastSequence, memberId: authenticated.member.id, projectId: route.projectId };
  }

  private async dispatch(
    request: CollabControlRouteRequest,
  ): Promise<CollabControlRouteResult | null> {
    const match = request.operationMatch
      ?? matchCollabControlOperation(request.method, request.segments);
    if (!match) return null;
    switch (COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family) {
      case 'join': return handleJoinRoute(request);
      case 'request': return handleRequestRoute(request);
      case 'ticket': return handleTicketRoute(request);
      case 'lifecycle': return handleLifecycleRoute(request);
      case 'membership': return handleMembershipRoute(request);
      case 'project': return handleProjectRoute(request);
    }
  }

  private async dispatchTerminal(
    request: CollabTerminalControlRouteRequest,
    terminal: CollabTerminalProjectService,
  ): Promise<CollabControlRouteResult> {
    const operation = request.operationMatch?.operation;
    const isAcknowledgement = operation === 'acknowledgeRetirement';
    const isHostTransitions = operation === 'getHostTransitions';
    if (isAcknowledgement || isHostTransitions) {
      const result = await handleLifecycleRoute(request);
      if (result) return result;
    }
    if (!request.authorization?.startsWith('Bearer ')) {
      throw routerError('authentication-failed', 'terminal-authorization-invalid');
    }
    const credential = request.authorization.slice('Bearer '.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw routerError('authentication-failed', 'terminal-credential-invalid');
    }
    const retirement = await terminal.getRetirement(credential);
    throw new CollabError({
      code: 'project-retired',
      safeContext: {
        projectId: retirement.projectId,
        retiredAt: retirement.retiredAt,
      },
    });
  }
}
