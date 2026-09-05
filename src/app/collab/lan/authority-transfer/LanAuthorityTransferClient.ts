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

import {
  COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
  collabLanAuthorityTransferOperationPath,
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
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface LanAuthorityTransferClientOptions {
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
  private readonly endpoint: URL;

  constructor(
    private readonly trust: LanAuthorityTransferTrustedHost,
    options: LanAuthorityTransferClientOptions = {},
  ) {
    const validatedTrust = validateTrust(trust);
    this.caCertificatePem = validatedTrust.caCertificatePem;
    this.endpoint = validatedTrust.endpoint;
    this.defaultTimeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
      hostname: this.endpoint.hostname,
      method: 'POST',
      path,
      port: Number(this.endpoint.port),
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
