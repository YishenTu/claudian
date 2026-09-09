import { randomUUID, X509Certificate } from 'node:crypto';

import {
  type ClaimTransferredMembershipRequest,
  COLLAB_ERROR_CODES,
  COLLAB_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferOperation,
  type CollabAuthorityTransferOperationMap,
  type CollabErrorCode as SharedCollabErrorCode,
  type CollabProjectId,
  type CollabRecoveryAction as SharedCollabRecoveryAction,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferOperationResponse,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { CollabLanDiscoveryPort } from '@/app/collab/discovery/CollabLanDiscoveryService';
import {
  COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
  collabLanAuthorityTransferIdentityPath,
  collabLanAuthorityTransferOperationPath,
  decodeLanAuthorityTransferEndpointIdentity,
  type LanAuthorityTransferEndpointIdentity,
  matchesLanAuthorityTransferEndpointIdentity,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferBinding';
import { HttpsRequestError, requestHttpsBytes } from '@/app/collab/lan/httpsRequest';
import { fingerprintCertificatePem } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const DEFAULT_TIMEOUT_MS = 10_000;
const MEMBER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHARED_ERROR_CODE_SET: ReadonlySet<string> = new Set(COLLAB_ERROR_CODES);
const SHARED_RECOVERY_ACTION_SET: ReadonlySet<string> = new Set([
  'request-access',
  'retry',
  'review-conflicts',
]);

export type LanAuthorityTransferMemberOperation =
  | 'acceptLanToCloudTransferTarget'
  | 'acknowledgeTransferredMembershipClaimRedemption'
  | 'cancelProjectAuthorityTransfer'
  | 'getProjectAuthorityTransfer'
  | 'getTransferredMembershipClaim'
  | 'requestLanToCloudTransfer';

export type LanAuthorityTransferStagedOperation =
  | 'acceptCloudToLanTransferTarget'
  | 'confirmCloudToLanTargetActive'
  | 'getProjectAuthorityTransfer'
  | 'reportCloudToLanTargetStaged';

type OperationRequest<Operation extends CollabAuthorityTransferOperation> =
  CollabAuthorityTransferOperationMap[Operation]['request'];
type OperationResponse<Operation extends CollabAuthorityTransferOperation> =
  CollabAuthorityTransferOperationMap[Operation]['response'];
type LanClaimTransferredMembershipRequest = Extract<
  ClaimTransferredMembershipRequest,
  { readonly credentialHash: string }
>;

export interface LanAuthorityTransferTrustedHost {
  readonly authorityGeneration?: number;
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface LanAuthorityTransferClientOptions {
  readonly discovery?: Pick<CollabLanDiscoveryPort, 'discoverProjectCandidates'>;
  readonly timeoutMs?: number;
}

export interface LanAuthorityTransferOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RequestAuthentication {
  readonly authorization: string;
}

function clientError(
  code:
    | 'authentication-failed'
    | 'cancelled'
    | 'endpoint-unreachable'
    | 'operation-failed'
    | 'operation-timeout'
    | 'protocol-payload-invalid'
    | 'protocol-version-unsupported'
    | 'tls-ca-mismatch'
    | 'tls-untrusted',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['retry', 'open-diagnostics'],
    safeContext: { reason, ...safeContext },
  });
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw clientError('operation-failed', 'authority-transfer-timeout-invalid');
  }
  return Math.floor(timeoutMs);
}

function validateCredential(credential: string): void {
  if (!MEMBER_CREDENTIAL_PATTERN.test(credential)) {
    throw clientError('authentication-failed', 'authority-transfer-credential-invalid');
  }
  const decoded = Buffer.from(credential, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== credential) {
    throw clientError('authentication-failed', 'authority-transfer-credential-invalid');
  }
}

interface ValidatedTrust {
  readonly caCertificatePem: string;
  readonly endpoint: URL;
}

function validateTrust(trust: LanAuthorityTransferTrustedHost): ValidatedTrust {
  if (!isCollabProjectId(trust.projectId)) {
    throw clientError('operation-failed', 'authority-transfer-project-id-invalid');
  }
  const certificateBlocks = trust.caCertificatePem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  const contentOutsideCertificate = trust.caCertificatePem.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    '',
  );
  if (certificateBlocks?.length !== 1 || contentOutsideCertificate.trim().length > 0) {
    throw clientError('tls-ca-mismatch', 'authority-transfer-ca-mismatch');
  }
  const caCertificatePem = `${certificateBlocks[0].trim()}\n`;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(caCertificatePem);
  } catch {
    throw clientError('tls-untrusted', 'authority-transfer-ca-invalid');
  }
  if (
    !certificate.ca
    || !certificate.verify(certificate.publicKey)
    || fingerprintCertificatePem(caCertificatePem) !== trust.caFingerprint
  ) {
    throw clientError('tls-ca-mismatch', 'authority-transfer-ca-mismatch');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(trust.endpoint);
  } catch {
    throw clientError('operation-failed', 'authority-transfer-endpoint-invalid');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.pathname !== '/'
    || endpoint.search.length > 0
    || endpoint.hash.length > 0
    || endpoint.port.length === 0
  ) {
    throw clientError('operation-failed', 'authority-transfer-endpoint-invalid');
  }
  return { caCertificatePem, endpoint };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const set = new Set(expected);
  return keys.length === expected.length && keys.every(key => set.has(key));
}

function responseVersionError(
  envelope: Readonly<Record<string, unknown>>,
): CollabError | null {
  if (envelope.bindingVersion !== COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION) {
    return clientError(
      'protocol-version-unsupported',
      'authority-transfer-binding-version-unsupported',
      {
        receivedVersion: typeof envelope.bindingVersion === 'number'
          ? envelope.bindingVersion
          : 0,
        supportedVersion: COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
      },
    );
  }
  if (envelope.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
    return clientError(
      'protocol-version-unsupported',
      'authority-transfer-protocol-version-unsupported',
      {
        receivedVersion: typeof envelope.protocolVersion === 'number'
          ? envelope.protocolVersion
          : 0,
        supportedVersion: COLLAB_PROTOCOL_VERSION,
      },
    );
  }
  return null;
}

function decodeErrorEnvelope(
  value: unknown,
  requestId: string,
): CollabError | null {
  const envelope = record(value);
  if (!envelope) return null;
  const versionError = responseVersionError(envelope);
  if (versionError) return versionError;
  if (
    !exactKeys(envelope, [
      'bindingVersion',
      'error',
      'protocolVersion',
      'requestId',
    ])
    || typeof envelope.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(envelope.requestId)
    || envelope.requestId !== requestId
  ) return null;
  const error = record(envelope.error);
  if (
    !error
    || typeof error.code !== 'string'
    || !SHARED_ERROR_CODE_SET.has(error.code)
  ) return null;
  const safeContext = record(error.safeContext) ?? {};
  const recoveryActions = Array.isArray(error.recoveryActions)
    ? error.recoveryActions.filter(
      (action): action is SharedCollabRecoveryAction => (
        typeof action === 'string' && SHARED_RECOVERY_ACTION_SET.has(action)
      ),
    )
    : [];
  return new CollabError({
    code: error.code as SharedCollabErrorCode,
    recoveryActions,
    safeContext,
  });
}

function statusError(statusCode: number): CollabError {
  if (statusCode === 401) {
    return clientError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  if (statusCode === 404) {
    return clientError('operation-failed', 'authority-transfer-route-not-found');
  }
  if (statusCode === 408 || statusCode === 504) {
    return clientError('operation-timeout', 'authority-transfer-request-timeout');
  }
  if (statusCode === 426) {
    return clientError(
      'protocol-version-unsupported',
      'authority-transfer-binding-version-unsupported',
    );
  }
  return clientError('operation-failed', 'authority-transfer-request-rejected');
}

export class LanAuthorityTransferClient {
  private readonly caCertificatePem: string;
  private readonly defaultTimeoutMs: number;
  private endpoint: URL;

  constructor(
    private readonly trust: LanAuthorityTransferTrustedHost,
    private readonly options: LanAuthorityTransferClientOptions = {},
  ) {
    const validatedTrust = validateTrust(trust);
    this.caCertificatePem = validatedTrust.caCertificatePem;
    this.endpoint = validatedTrust.endpoint;
    this.defaultTimeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  get currentEndpoint(): string {
    return this.endpoint.origin;
  }

  async resolveCurrentAuthorityEndpoint(
    authorityGeneration: number,
    options: LanAuthorityTransferOperationOptions = {},
  ): Promise<string> {
    const expected = decodeLanAuthorityTransferEndpointIdentity({
      authorityGeneration, projectId: this.trust.projectId, transferId: null,
    });
    if (await this.probeEndpoint(expected, this.endpoint, options)) return this.currentEndpoint;
    const endpoint = this.options.discovery ? await this.resolveEndpoint(expected, options) : null;
    if (!endpoint) throw clientError('endpoint-unreachable', 'authority-transfer-connection-failed');
    this.endpoint = endpoint;
    return this.currentEndpoint;
  }

  requestWithMember<Operation extends LanAuthorityTransferMemberOperation>(
    operation: Operation,
    request: OperationRequest<Operation>,
    memberCredential: string,
    options: LanAuthorityTransferOperationOptions = {},
  ): Promise<OperationResponse<Operation>> {
    validateCredential(memberCredential);
    return this.request(operation, request, {
      authorization: `Bearer ${memberCredential}`,
    }, options);
  }

  requestWithTransferCredential<Operation extends LanAuthorityTransferStagedOperation>(
    operation: Operation,
    request: OperationRequest<Operation>,
    transferCredential: string,
    options: LanAuthorityTransferOperationOptions = {},
  ): Promise<OperationResponse<Operation>> {
    validateCredential(transferCredential);
    return this.request(operation, request, {
      authorization: `Claudian-Authority-Transfer ${transferCredential}`,
    }, options);
  }

  claimTransferredMembership(
    request: LanClaimTransferredMembershipRequest,
    options: LanAuthorityTransferOperationOptions = {},
  ): Promise<OperationResponse<'claimTransferredMembership'>> {
    return this.request('claimTransferredMembership', request, {
      authorization: `Claudian-Transfer-Claim ${request.claim}`,
    }, options);
  }

  private async request<Operation extends CollabAuthorityTransferOperation>(
    operation: Operation,
    request: OperationRequest<Operation>,
    authentication: RequestAuthentication,
    options: LanAuthorityTransferOperationOptions,
  ): Promise<OperationResponse<Operation>> {
    if (options.signal?.aborted) {
      throw clientError('cancelled', 'authority-transfer-request-cancelled');
    }
    let decodedRequest: OperationRequest<Operation>;
    try {
      decodedRequest = decodeCollabAuthorityTransferOperationRequest(
        operation,
        request,
      );
    } catch {
      throw clientError('protocol-payload-invalid', 'authority-transfer-request-invalid');
    }
    if (decodedRequest.projectId !== this.trust.projectId) {
      throw clientError('operation-failed', 'authority-transfer-project-mismatch');
    }
    const body = Buffer.from(JSON.stringify(decodedRequest), 'utf8');
    if (body.byteLength > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
      throw clientError('protocol-payload-invalid', 'authority-transfer-request-too-large');
    }
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const requestId = randomUUID();
    const send = (endpoint: URL) => this.requestAtEndpoint(
      operation, decodedRequest, authentication, { body, endpoint, requestId, signal: options.signal, timeoutMs },
    );
    try {
      return await send(this.endpoint);
    } catch (error) {
      if (!this.options.discovery || !(error instanceof CollabError)
        || (error.code !== 'endpoint-unreachable' && error.code !== 'operation-timeout'
          && error.code !== 'tls-untrusted')) throw error;
      const expected = decodeLanAuthorityTransferEndpointIdentity({
        authorityGeneration: this.trust.authorityGeneration
          ?? ('expectedAuthorityGeneration' in decodedRequest ? decodedRequest.expectedAuthorityGeneration : null),
        projectId: this.trust.projectId,
        transferId: 'transferId' in decodedRequest ? decodedRequest.transferId : null,
      });
      const endpoint = await this.resolveEndpoint(expected, options);
      if (!endpoint) throw error;
      this.endpoint = endpoint;
      return send(endpoint);
    }
  }

  private async resolveEndpoint(
    expected: LanAuthorityTransferEndpointIdentity,
    options: LanAuthorityTransferOperationOptions,
  ): Promise<URL | null> {
    const candidates = await this.options.discovery!.discoverProjectCandidates(
      this.trust.projectId, this.trust.caFingerprint, options,
    );
    if (options.signal?.aborted) throw clientError('cancelled', 'authority-transfer-request-cancelled');
    if (candidates.length > 8) throw clientError('operation-failed', 'authority-transfer-endpoint-ambiguous');
    const endpoints = new Map<string, URL>();
    for (const candidate of candidates) {
      if (candidate.projectId !== this.trust.projectId || candidate.caFingerprint !== this.trust.caFingerprint) continue;
      try {
        const validated = validateTrust({ ...this.trust, endpoint: candidate.endpoint });
        endpoints.set(validated.endpoint.origin, validated.endpoint);
      } catch { /* Discovery metadata is untrusted. */ }
    }
    const probes = await Promise.all([...endpoints.values()].map(async endpoint => (
      await this.probeEndpoint(expected, endpoint, options) ? endpoint : null
    )));
    const verified = probes.filter((endpoint): endpoint is URL => endpoint !== null);
    if (verified.length > 1) throw clientError('operation-failed', 'authority-transfer-endpoint-ambiguous');
    return verified[0] ?? null;
  }

  private async probeEndpoint(
    expected: LanAuthorityTransferEndpointIdentity,
    endpoint: URL,
    options: LanAuthorityTransferOperationOptions,
  ): Promise<boolean> {
    const requestId = randomUUID();
    const body = Buffer.from(JSON.stringify(expected), 'utf8');
    const response = await requestHttpsBytes({
      ca: this.caCertificatePem,
      headers: {
        accept: 'application/json', 'content-length': String(body.byteLength),
        'content-type': 'application/json', 'x-request-id': requestId,
      },
      hostname: endpoint.hostname, method: 'POST',
      path: collabLanAuthorityTransferIdentityPath(this.trust.projectId), port: Number(endpoint.port),
    }, {
      body, maxResponseBytes: 4_096, signal: options.signal,
      timeoutMs: Math.min(2_000, options.timeoutMs ?? this.defaultTimeoutMs),
    }).catch((error: unknown) => {
      if (!(error instanceof HttpsRequestError)) throw error;
      if (error.reason === 'cancelled') throw clientError('cancelled', 'authority-transfer-request-cancelled');
      if (error.reason === 'response-too-large') {
        throw clientError('protocol-payload-invalid', 'authority-transfer-endpoint-identity-mismatch');
      }
      return null;
    });
    if (!response) return false;
    const contentType = response.headers['content-type'];
    let envelope: Record<string, unknown> | null = null;
    try { envelope = record(JSON.parse(response.body.toString('utf8'))); } catch { /* Reject below. */ }
    if (envelope) {
      const versionError = responseVersionError(envelope);
      if (versionError) throw versionError;
    }
    if (response.statusCode !== 200 || !envelope || typeof contentType !== 'string'
      || !/^application\/json(?:\s*;|$)/i.test(contentType)
      || !exactKeys(envelope, ['bindingVersion', 'data', 'protocolVersion', 'requestId'])
      || envelope.requestId !== requestId) {
      throw clientError('operation-failed', 'authority-transfer-endpoint-identity-mismatch');
    }
    let actual: LanAuthorityTransferEndpointIdentity;
    try { actual = decodeLanAuthorityTransferEndpointIdentity(envelope.data); } catch {
      throw clientError('protocol-payload-invalid', 'authority-transfer-endpoint-identity-mismatch');
    }
    if (!matchesLanAuthorityTransferEndpointIdentity(expected, actual)) {
      throw clientError('operation-failed', 'authority-transfer-endpoint-identity-mismatch');
    }
    return true;
  }

  private async requestAtEndpoint<Operation extends CollabAuthorityTransferOperation>(
    operation: Operation,
    decodedRequest: OperationRequest<Operation>,
    authentication: RequestAuthentication,
    options: {
      readonly body: Buffer;
      readonly endpoint: URL;
      readonly requestId: string;
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
    },
  ): Promise<OperationResponse<Operation>> {
    const { body, endpoint, requestId, timeoutMs } = options;
    const path = collabLanAuthorityTransferOperationPath(
      this.trust.projectId,
      operation,
    );
    const response = await requestHttpsBytes({
      ca: this.caCertificatePem,
      headers: {
        accept: 'application/json',
        authorization: authentication.authorization,
        'content-length': String(body.byteLength),
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      hostname: endpoint.hostname,
      method: 'POST',
      path,
      port: Number(endpoint.port),
    }, {
      body,
      maxResponseBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      signal: options.signal,
      timeoutMs,
    }).catch((error: unknown) => {
      if (!(error instanceof HttpsRequestError)) throw error;
      switch (error.reason) {
        case 'cancelled':
          throw clientError('cancelled', 'authority-transfer-request-cancelled');
        case 'timeout':
          throw clientError('operation-timeout', 'authority-transfer-request-timeout');
        case 'response-too-large':
          throw clientError('protocol-payload-invalid', 'authority-transfer-response-too-large');
        case 'response-failed':
          throw clientError('endpoint-unreachable', 'authority-transfer-response-failed');
        case 'tls-untrusted':
          throw clientError('tls-untrusted', 'authority-transfer-tls-validation-failed');
        case 'connection-failed':
          throw clientError('endpoint-unreachable', 'authority-transfer-connection-failed');
      }
    });
    const { statusCode } = response;
    const contentType = response.headers['content-type'];
    if (
      typeof contentType !== 'string'
      || !/^application\/json(?:\s*;|$)/i.test(contentType)
    ) {
      throw clientError('protocol-payload-invalid', 'authority-transfer-response-content-type-invalid');
    }
    let responseValue: unknown;
    try {
      responseValue = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw statusCode === 200
        ? clientError('protocol-payload-invalid', 'authority-transfer-response-json-invalid')
        : statusError(statusCode);
    }
    if (statusCode !== 200) {
      throw decodeErrorEnvelope(responseValue, requestId) ?? statusError(statusCode);
    }
    const envelope = record(responseValue);
    if (!envelope) {
      throw clientError('protocol-payload-invalid', 'authority-transfer-response-invalid');
    }
    const versionError = responseVersionError(envelope);
    if (versionError) throw versionError;
    if (
      !exactKeys(envelope, [
        'bindingVersion',
        'data',
        'protocolVersion',
        'requestId',
      ])
      || typeof envelope.requestId !== 'string'
      || !REQUEST_ID_PATTERN.test(envelope.requestId)
      || envelope.requestId !== requestId
    ) {
      throw clientError('protocol-payload-invalid', 'authority-transfer-response-invalid');
    }
    let decodedResponse: OperationResponse<Operation>;
    try {
      decodedResponse = decodeCollabAuthorityTransferOperationResponse(
        operation,
        envelope.data,
      );
    } catch {
      throw clientError('protocol-payload-invalid', 'authority-transfer-response-invalid');
    }
    if (
      decodedResponse.projectId !== this.trust.projectId
      || (
        'transferId' in decodedRequest
        && decodedResponse.transferId !== decodedRequest.transferId
      )
    ) {
      throw clientError('protocol-payload-invalid', 'authority-transfer-response-mismatch');
    }
    return decodedResponse;
  }
}
