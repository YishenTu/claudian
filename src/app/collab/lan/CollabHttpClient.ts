import { randomUUID, X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect as connectTls, type DetailedPeerCertificate } from 'node:tls';

import { isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  type CollabControlOperationBinding,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  InvitationCodec,
  type LanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import {
  COLLAB_CONTROL_MAX_BODY_BYTES,
  COLLAB_CONTROL_PROTOCOL_VERSION,
} from '@/app/collab/lan/LanCollabConstants';
import { fingerprintCertificatePem } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const DEFAULT_TIMEOUT_MS = 10_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CollabTrustedHost {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: string;
}

export interface CollabTrustedEndpointCandidate {
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: string;
}

export interface CollabHostTrustStore {
  read(projectId: string): Promise<CollabTrustedHost | null>;
  save(trust: CollabTrustedHost): Promise<'ca-mismatch' | 'saved'>;
}

export interface CollabHttpClientOptions {
  readonly invitationCodec?: InvitationCodec;
  readonly timeoutMs?: number;
}

export interface CollabHttpOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CollabJsonRequest<T> {
  readonly body?: unknown;
  readonly decode: (value: unknown) => T;
  readonly idempotencyKey?: string;
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  readonly path: string;
}

type AuthenticationKind = 'invitation' | 'member' | 'public';

const REQUEST_STATE_ERROR_CODES = new Set([
  'idempotency-conflict',
  'request-head-not-pushed',
  'request-not-open',
  'stale-main',
  'stale-project-selection',
  'stale-request-head',
  'stale-request-metadata',
  'stale-ticket',
]);

const STRUCTURED_ERROR_CODES = new Set([
  ...REQUEST_STATE_ERROR_CODES,
  'project-retired',
]);

function transportError(
  code:
    | 'authentication-failed'
    | 'authorization-denied'
    | 'cancelled'
    | 'endpoint-unreachable'
    | 'invitation-revoked'
    | 'membership-revoked'
    | 'operation-failed'
    | 'operation-timeout'
    | 'project-not-found'
    | 'project-retired'
    | 'protocol-payload-invalid'
    | 'tls-ca-mismatch'
    | 'tls-untrusted',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'tls-ca-mismatch'
      ? ['open-diagnostics']
      : code === 'cancelled'
        ? ['retry']
        : code === 'invitation-revoked'
          ? ['refresh-invitation']
          : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const parsed = new URL(endpoint);
  return { host: parsed.hostname, port: Number(parsed.port) };
}

function normalizeCaPem(raw: Buffer): string {
  return `${new X509Certificate(raw).toString().trim()}\n`;
}

function sameRawCertificate(
  left: DetailedPeerCertificate,
  right: DetailedPeerCertificate,
): boolean {
  return Buffer.isBuffer(left.raw)
    && Buffer.isBuffer(right.raw)
    && left.raw.equals(right.raw);
}

function readPresentedRoot(peer: DetailedPeerCertificate): Buffer {
  if (!Buffer.isBuffer(peer.raw) || peer.raw.length === 0) {
    throw transportError('tls-untrusted', 'tls-peer-certificate-missing');
  }
  const seen = new Set<string>();
  let current = peer;
  while (true) {
    const fingerprint = current.fingerprint256 ?? current.fingerprint ?? '';
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    const issuer = current.issuerCertificate;
    if (
      !issuer
      || !Buffer.isBuffer(issuer.raw)
      || issuer.raw.length === 0
      || sameRawCertificate(current, issuer)
    ) {
      break;
    }
    current = issuer;
  }
  const root = new X509Certificate(current.raw);
  if (!root.ca || !root.verify(root.publicKey)) {
    throw transportError('tls-untrusted', 'tls-presented-root-invalid');
  }
  return Buffer.from(current.raw);
}

function isTlsValidationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  return code.includes('CERT')
    || code.includes('TLS')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw transportError('operation-failed', 'transport-timeout-invalid');
  }
  return Math.floor(timeoutMs);
}

async function openTlsConnection(
  endpoint: string,
  options: {
    readonly caCertificatePem?: string;
    readonly rejectUnauthorized: boolean;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<DetailedPeerCertificate> {
  if (options.signal?.aborted) {
    throw transportError('cancelled', 'transport-aborted');
  }
  const { host, port } = parseEndpoint(endpoint);
  return new Promise<DetailedPeerCertificate>((resolve, reject) => {
    let settled = false;
    const socket = connectTls({
      ...(options.caCertificatePem ? { ca: options.caCertificatePem } : {}),
      host,
      minVersion: 'TLSv1.2',
      port,
      rejectUnauthorized: options.rejectUnauthorized,
    });
    const cleanup = () => {
      window.clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('error', onError);
    };
    const fail = (error: CollabError) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(transportError('cancelled', 'transport-aborted'));
    const onError = (error: Error) => fail(transportError(
      options.rejectUnauthorized && isTlsValidationError(error)
        ? 'tls-untrusted'
        : 'endpoint-unreachable',
      options.rejectUnauthorized && isTlsValidationError(error)
        ? 'tls-validation-failed'
        : 'tls-connection-failed',
    ));
    const timer = window.setTimeout(() => {
      fail(transportError('operation-timeout', 'tls-connection-timeout'));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      if (settled) return;
      let peer: DetailedPeerCertificate;
      try {
        peer = socket.getPeerCertificate(true);
      } catch {
        fail(transportError('tls-untrusted', 'tls-peer-certificate-invalid'));
        return;
      }
      settled = true;
      cleanup();
      socket.end();
      resolve(peer);
    });
  });
}

function validateTrustedHost(
  trust: CollabTrustedHost,
  invitationCodec?: InvitationCodec,
): void {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(trust.caCertificatePem);
  } catch {
    throw transportError('tls-untrusted', 'stored-ca-certificate-invalid');
  }
  if (
    !isCollabProjectId(trust.projectId)
    || !certificate.ca
    || !certificate.verify(certificate.publicKey)
    || fingerprintCertificatePem(trust.caCertificatePem) !== trust.caFingerprint
  ) {
    throw transportError('tls-untrusted', 'stored-ca-fingerprint-invalid');
  }
  if (invitationCodec) {
    try {
      invitationCodec.normalizeEndpoint(trust.endpoint);
    } catch {
      throw transportError('tls-untrusted', 'stored-endpoint-invalid');
    }
  }
}

function isCanonicalCredential(credential: string): boolean {
  if (!BASE64URL_PATTERN.test(credential)) return false;
  try {
    const decoded = Buffer.from(credential, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === credential;
  } catch {
    return false;
  }
}

function validateRequestPath(
  projectId: string,
  method: CollabJsonRequest<unknown>['method'],
  requestPath: string,
): CollabControlOperationBinding {
  const encodedProjectId = encodeURIComponent(projectId);
  let parsed: URL;
  try {
    parsed = new URL(requestPath, 'https://claudian.invalid');
  } catch {
    throw transportError('operation-failed', 'control-request-path-invalid');
  }
  const match = /^\/v(\d+)\/projects\/([^/]+)\/(.+)$/.exec(parsed.pathname);
  const operationMatch = match
    ? matchCollabControlOperation(method, match[3].split('/'))
    : null;
  const binding = operationMatch
    ? COLLAB_CONTROL_OPERATION_BINDINGS[operationMatch.operation]
    : null;
  if (
    parsed.origin !== 'https://claudian.invalid'
    || `${parsed.pathname}${parsed.search}` !== requestPath
    || match?.[2] !== encodedProjectId
    || Number(match?.[1]) !== binding?.version
    || !binding
    || requestPath.startsWith('//')
    || requestPath.includes('#')
    || (parsed.search.length > 0 && binding.requestSource !== 'path-and-query')
  ) {
    throw transportError('operation-failed', 'control-request-path-invalid');
  }
  return binding;
}

function responseStatusError(
  statusCode: number,
  authenticationKind: AuthenticationKind,
): CollabError {
  if (statusCode === 401) {
    return transportError('authentication-failed', 'control-authentication-failed');
  }
  if (statusCode === 403) {
    return transportError('authorization-denied', 'control-authorization-denied');
  }
  if (statusCode === 404) {
    return transportError('project-not-found', 'control-project-not-found');
  }
  if (statusCode === 410) {
    if (authenticationKind === 'public') {
      return transportError('project-not-found', 'control-project-not-found');
    }
    return transportError(
      authenticationKind === 'invitation' ? 'invitation-revoked' : 'membership-revoked',
      authenticationKind === 'invitation'
        ? 'control-invitation-revoked'
        : 'control-membership-revoked',
    );
  }
  if (statusCode === 408 || statusCode === 504) {
    return transportError('operation-timeout', 'control-request-timeout');
  }
  return transportError('operation-failed', 'control-request-failed');
}

function protocolStructuredError(value: unknown): CollabError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Readonly<Record<string, unknown>>;
  if (
    envelope.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
    || typeof envelope.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(envelope.requestId)
    || !envelope.error
    || typeof envelope.error !== 'object'
    || Array.isArray(envelope.error)
  ) {
    return null;
  }
  const error = envelope.error as Readonly<Record<string, unknown>>;
  if (typeof error.code !== 'string' || !STRUCTURED_ERROR_CODES.has(error.code)) {
    return null;
  }
  const safeContext = error.safeContext;
  return new CollabError({
    code: error.code as
      | 'idempotency-conflict'
      | 'project-retired'
      | 'request-head-not-pushed'
      | 'request-not-open'
      | 'stale-main'
      | 'stale-project-selection'
      | 'stale-request-head'
      | 'stale-request-metadata'
      | 'stale-ticket',
    recoveryActions: ['retry'],
    ...(safeContext && typeof safeContext === 'object' && !Array.isArray(safeContext)
      ? { safeContext: safeContext as Readonly<Record<string, unknown>> }
      : {}),
  });
}

export class PinnedCollabHttpClient {
  constructor(
    readonly trust: CollabTrustedHost,
    private readonly defaultTimeoutMs: number,
  ) {
    validateTrustedHost(trust);
  }

  requestWithInvitation<T>(
    request: CollabJsonRequest<T>,
    invitationSecret: string,
    options: CollabHttpOperationOptions = {},
  ): Promise<T> {
    return this.requestJson(
      request,
      'invitation',
      `Claudian-Invitation ${invitationSecret}`,
      options,
    );
  }

  requestWithMember<T>(
    request: CollabJsonRequest<T>,
    memberCredential: string,
    options: CollabHttpOperationOptions = {},
  ): Promise<T> {
    return this.requestJson(request, 'member', `Bearer ${memberCredential}`, options);
  }

  requestPublic<T>(
    request: CollabJsonRequest<T>,
    options: CollabHttpOperationOptions = {},
  ): Promise<T> {
    return this.requestJson(request, 'public', null, options);
  }

  private async requestJson<T>(
    request: CollabJsonRequest<T>,
    authenticationKind: AuthenticationKind,
    authorization: string | null,
    options: CollabHttpOperationOptions,
  ): Promise<T> {
    const binding = validateRequestPath(this.trust.projectId, request.method, request.path);
    const expectedAuthentication: AuthenticationKind = binding.authentication === 'invitation'
      ? 'invitation'
      : binding.authentication === 'public'
        ? 'public'
        : 'member';
    if (authenticationKind !== expectedAuthentication) {
      throw transportError('authentication-failed', 'control-authentication-mode-invalid');
    }
    if (options.signal?.aborted) {
      throw transportError('cancelled', 'transport-aborted');
    }
    if (authorization !== null) {
      const credential = authorization.slice(authorization.indexOf(' ') + 1);
      if (!isCanonicalCredential(credential)) {
        throw transportError('authentication-failed', 'control-credential-invalid');
      }
    }
    if (
      request.idempotencyKey !== undefined
      && !isCollabOpaqueId(request.idempotencyKey)
    ) {
      throw transportError('operation-failed', 'idempotency-key-invalid');
    }
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    let body: Buffer | null;
    try {
      body = request.body === undefined
        ? null
        : Buffer.from(JSON.stringify(request.body), 'utf8');
    } catch {
      throw transportError('protocol-payload-invalid', 'control-request-json-invalid');
    }
    if (
      body
      && (binding.requestSource === 'path' || binding.requestSource === 'path-and-query')
    ) {
      throw transportError('protocol-payload-invalid', 'control-request-body-forbidden');
    }
    if (body && body.length > COLLAB_CONTROL_MAX_BODY_BYTES) {
      throw transportError('protocol-payload-invalid', 'control-request-too-large');
    }
    const endpoint = new URL(this.trust.endpoint);
    const responseValue = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        operation();
      };
      const nodeRequest = httpsRequest({
        ca: this.trust.caCertificatePem,
        headers: {
          accept: 'application/json',
          ...(authorization ? { authorization } : {}),
          ...(body ? {
            'content-length': String(body.length),
            'content-type': 'application/json',
          } : {}),
          ...(request.idempotencyKey
            ? { 'idempotency-key': request.idempotencyKey }
            : {}),
          'x-request-id': randomUUID(),
        },
        hostname: endpoint.hostname,
        method: request.method,
        minVersion: 'TLSv1.2',
        path: request.path,
        port: Number(endpoint.port),
        rejectUnauthorized: true,
      }, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > COLLAB_CONTROL_MAX_BODY_BYTES) {
            response.destroy();
            finish(() => reject(transportError(
              'protocol-payload-invalid',
              'control-response-too-large',
            )));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', () => {
          finish(() => reject(transportError(
            'endpoint-unreachable',
            'control-response-failed',
          )));
        });
        response.once('end', () => {
          if (settled) return;
          const statusCode = response.statusCode ?? 0;
          try {
            const contents = Buffer.concat(chunks).toString('utf8');
            const parsed: unknown = contents.length === 0
              ? null
              : JSON.parse(contents) as unknown;
            if (statusCode < 200 || statusCode >= 300) {
              const stateError = statusCode === 409 || statusCode === 410
                ? protocolStructuredError(parsed)
                : null;
              finish(() => reject(
                stateError ?? responseStatusError(statusCode, authenticationKind),
              ));
              return;
            }
            finish(() => resolve(parsed));
          } catch {
            finish(() => reject(
              statusCode < 200 || statusCode >= 300
                ? responseStatusError(statusCode, authenticationKind)
                : transportError(
                  'protocol-payload-invalid',
                  'control-response-json-invalid',
                ),
            ));
          }
        });
      });
      const onAbort = () => {
        finish(() => {
          nodeRequest.destroy();
          reject(transportError('cancelled', 'transport-aborted'));
        });
      };
      const timer = window.setTimeout(() => {
        finish(() => {
          nodeRequest.destroy();
          reject(transportError('operation-timeout', 'control-request-timeout'));
        });
      }, timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      nodeRequest.once('error', error => {
        finish(() => reject(transportError(
          isTlsValidationError(error) ? 'tls-untrusted' : 'endpoint-unreachable',
          isTlsValidationError(error)
            ? 'control-tls-validation-failed'
            : 'control-connection-failed',
        )));
      });
      if (body) nodeRequest.write(body);
      nodeRequest.end();
    });
    try {
      return request.decode(responseValue);
    } catch {
      throw transportError('protocol-payload-invalid', 'control-response-shape-invalid');
    }
  }
}

export class CollabHttpClient {
  private readonly defaultTimeoutMs: number;
  private readonly invitationCodec: InvitationCodec;

  constructor(
    private readonly trustStore: CollabHostTrustStore,
    options: CollabHttpClientOptions = {},
  ) {
    this.defaultTimeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.invitationCodec = options.invitationCodec ?? new InvitationCodec();
  }

  async bootstrapInvitation(
    invitation: LanCollabInvitation,
    options: CollabHttpOperationOptions = {},
  ): Promise<PinnedCollabHttpClient> {
    const validated = this.invitationCodec.validateInvitation(invitation);
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const existing = await this.trustStore.read(validated.projectId);
    let caCertificatePem: string;
    if (existing) {
      validateTrustedHost(existing, this.invitationCodec);
      if (existing.caFingerprint !== validated.caFingerprint) {
        throw transportError('tls-ca-mismatch', 'trusted-project-ca-mismatch');
      }
      caCertificatePem = existing.caCertificatePem;
    } else {
      const peer = await openTlsConnection(validated.endpoint, {
        rejectUnauthorized: false,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs,
      });
      caCertificatePem = normalizeCaPem(readPresentedRoot(peer));
      if (fingerprintCertificatePem(caCertificatePem) !== validated.caFingerprint) {
        throw transportError('tls-ca-mismatch', 'probed-ca-fingerprint-mismatch');
      }
    }

    await openTlsConnection(validated.endpoint, {
      caCertificatePem,
      rejectUnauthorized: true,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
    });
    const trust = Object.freeze({
      caCertificatePem,
      caFingerprint: validated.caFingerprint,
      endpoint: validated.endpoint,
      projectId: validated.projectId,
    });
    if (await this.trustStore.save(trust) !== 'saved') {
      throw transportError('tls-ca-mismatch', 'trusted-project-ca-mismatch');
    }
    return new PinnedCollabHttpClient(trust, this.defaultTimeoutMs);
  }

  async bootstrapTrustedEndpoint(
    candidate: CollabTrustedEndpointCandidate,
    options: CollabHttpOperationOptions = {},
  ): Promise<PinnedCollabHttpClient> {
    const endpoint = this.invitationCodec.normalizeEndpoint(candidate.endpoint);
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const existing = await this.trustStore.read(candidate.projectId);
    if (!existing) {
      throw transportError('tls-untrusted', 'trusted-project-ca-missing');
    }
    validateTrustedHost(existing, this.invitationCodec);
    if (
      existing.projectId !== candidate.projectId
      || existing.caFingerprint !== candidate.caFingerprint
    ) {
      throw transportError('tls-ca-mismatch', 'trusted-project-ca-mismatch');
    }
    await openTlsConnection(endpoint, {
      caCertificatePem: existing.caCertificatePem,
      rejectUnauthorized: true,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
    });
    const trust = Object.freeze({ ...existing, endpoint });
    if (await this.trustStore.save(trust) !== 'saved') {
      throw transportError('tls-ca-mismatch', 'trusted-project-ca-mismatch');
    }
    return new PinnedCollabHttpClient(trust, this.defaultTimeoutMs);
  }

  async bootstrapPublicEndpoint(
    candidate: CollabTrustedEndpointCandidate,
    options: CollabHttpOperationOptions = {},
  ): Promise<PinnedCollabHttpClient> {
    const endpoint = this.invitationCodec.normalizeEndpoint(candidate.endpoint);
    if (!isCollabProjectId(candidate.projectId)) {
      throw transportError('project-not-found', 'candidate-project-invalid');
    }
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const peer = await openTlsConnection(endpoint, {
      rejectUnauthorized: false,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
    });
    const caCertificatePem = normalizeCaPem(readPresentedRoot(peer));
    if (fingerprintCertificatePem(caCertificatePem) !== candidate.caFingerprint) {
      throw transportError('tls-ca-mismatch', 'probed-ca-fingerprint-mismatch');
    }
    await openTlsConnection(endpoint, {
      caCertificatePem,
      rejectUnauthorized: true,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
    });
    return new PinnedCollabHttpClient({
      caCertificatePem,
      caFingerprint: candidate.caFingerprint,
      endpoint,
      projectId: candidate.projectId,
    }, this.defaultTimeoutMs);
  }

  async fromStoredTrust(projectId: string): Promise<PinnedCollabHttpClient> {
    const trust = await this.trustStore.read(projectId);
    if (!trust) throw transportError('tls-untrusted', 'trusted-project-ca-missing');
    validateTrustedHost(trust, this.invitationCodec);
    return new PinnedCollabHttpClient(trust, this.defaultTimeoutMs);
  }
}
