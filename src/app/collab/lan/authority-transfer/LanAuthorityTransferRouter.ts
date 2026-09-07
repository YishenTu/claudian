import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import {
  type AcceptCloudToLanTransferTargetRequest,
  type AcceptLanToCloudTransferTargetRequest,
  type AcknowledgeTransferredMembershipClaimRedemptionRequest,
  type CancelProjectAuthorityTransferRequest,
  type ClaimTransferredMembershipRequest,
  COLLAB_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferOperation,
  type CollabAuthorityTransferOperationMap,
  type CollabMemberId,
  type CollabProjectId,
  type ConfirmCloudToLanTargetActiveRequest,
  decodeCollabAuthorityTransferOperationRequest,
  decodeCollabAuthorityTransferOperationResponse,
  type GetProjectAuthorityTransferRequest,
  type GetTransferredMembershipClaimRequest,
  isCollabMemberId,
  type ReportCloudToLanTargetStagedRequest,
  type RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import {
  COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
  matchCollabLanAuthorityTransferRoute,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferBinding';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEMBER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LanAuthorityTransferActor {
  readonly memberId: CollabMemberId;
}

export interface LanAuthorityTransferMemberAuthenticator {
  authenticateMemberCredential(
    credential: string,
  ): Promise<LanAuthorityTransferActor>;
}

type OperationRequest<Operation extends CollabAuthorityTransferOperation> =
  CollabAuthorityTransferOperationMap[Operation]['request'];
type OperationResponse<Operation extends CollabAuthorityTransferOperation> =
  CollabAuthorityTransferOperationMap[Operation]['response'];
type LanClaimTransferredMembershipRequest = Extract<
  ClaimTransferredMembershipRequest,
  { readonly credentialHash: string }
>;

export interface LanAuthorityTransferSourceActiveService
  extends LanAuthorityTransferMemberAuthenticator {
  requestLanToCloudTransfer(
    actor: LanAuthorityTransferActor,
    request: RequestLanToCloudTransferRequest,
  ): Promise<OperationResponse<'requestLanToCloudTransfer'>>;
  acceptLanToCloudTransferTarget(
    actor: LanAuthorityTransferActor,
    request: AcceptLanToCloudTransferTargetRequest,
  ): Promise<OperationResponse<'acceptLanToCloudTransferTarget'>>;
  getProjectAuthorityTransfer(
    actor: LanAuthorityTransferActor,
    request: GetProjectAuthorityTransferRequest,
  ): Promise<OperationResponse<'getProjectAuthorityTransfer'>>;
  cancelProjectAuthorityTransfer(
    actor: LanAuthorityTransferActor,
    request: CancelProjectAuthorityTransferRequest,
  ): Promise<OperationResponse<'cancelProjectAuthorityTransfer'>>;
}

export interface LanAuthorityTransferTargetStagedService {
  acceptCloudToLanTransferTarget(
    request: AcceptCloudToLanTransferTargetRequest,
  ): Promise<OperationResponse<'acceptCloudToLanTransferTarget'>>;
  getProjectAuthorityTransfer(
    request: GetProjectAuthorityTransferRequest,
  ): Promise<OperationResponse<'getProjectAuthorityTransfer'>>;
  reportCloudToLanTargetStaged(
    request: ReportCloudToLanTargetStagedRequest,
  ): Promise<OperationResponse<'reportCloudToLanTargetStaged'>>;
  confirmCloudToLanTargetActive(
    request: ConfirmCloudToLanTargetActiveRequest,
  ): Promise<OperationResponse<'confirmCloudToLanTargetActive'>>;
}

export interface LanAuthorityTransferTargetActiveService {
  readonly expiresAt: string;
  claimTransferredMembership(
    request: LanClaimTransferredMembershipRequest,
  ): Promise<OperationResponse<'claimTransferredMembership'>>;
  expire(): Promise<void>;
}

export interface LanAuthorityTransferTerminalSourceService
  extends LanAuthorityTransferMemberAuthenticator {
  readonly expiresAt: string;
  getProjectAuthorityTransfer(
    actor: LanAuthorityTransferActor,
    request: GetProjectAuthorityTransferRequest,
  ): Promise<OperationResponse<'getProjectAuthorityTransfer'>>;
  getTransferredMembershipClaim(
    actor: LanAuthorityTransferActor,
    request: GetTransferredMembershipClaimRequest,
  ): Promise<OperationResponse<'getTransferredMembershipClaim'>>;
  acknowledgeTransferredMembershipClaimRedemption(
    actor: LanAuthorityTransferActor,
    request: AcknowledgeTransferredMembershipClaimRedemptionRequest,
  ): Promise<OperationResponse<'acknowledgeTransferredMembershipClaimRedemption'>>;
  expire(): Promise<void>;
}

interface RouteRegistrationBase {
  readonly projectId: CollabProjectId;
}

export interface LanAuthorityTransferSourceActiveRegistration
  extends RouteRegistrationBase {
  readonly expectedEndpoint?: string;
  readonly hostMemberId: CollabMemberId;
  readonly service: LanAuthorityTransferSourceActiveService;
  readonly state: 'source-active';
}

export interface LanAuthorityTransferTargetOnlyStagedRegistration
  extends RouteRegistrationBase {
  readonly credentialHash: string;
  readonly expectedEndpoint?: string;
  readonly service: LanAuthorityTransferTargetStagedService;
  readonly state: 'target-only-staged';
  readonly transferId: string;
}

export interface LanAuthorityTransferTargetActiveRegistration
  extends RouteRegistrationBase {
  readonly expectedEndpoint?: string;
  readonly service: LanAuthorityTransferTargetActiveService;
  readonly state: 'target-active';
  readonly transferId: string;
}

export interface LanAuthorityTransferTerminalSourceRegistration
  extends RouteRegistrationBase {
  readonly expectedEndpoint?: string;
  readonly service: LanAuthorityTransferTerminalSourceService;
  readonly state: 'terminal-source';
  readonly transferId: string;
}

export type LanAuthorityTransferRouteRegistration =
  | LanAuthorityTransferSourceActiveRegistration
  | LanAuthorityTransferTargetOnlyStagedRegistration
  | LanAuthorityTransferTargetActiveRegistration
  | LanAuthorityTransferTerminalSourceRegistration;

export interface LanAuthorityTransferRouteTransition {
  readonly expected: LanAuthorityTransferRouteRegistration;
  readonly next: LanAuthorityTransferRouteRegistration;
  readonly relinquishmentProof: CollabAuthorityRelinquishmentProof;
}

export type LanAuthorityTransferRouteAdmissionResult<T> =
  | { readonly admitted: false }
  | { readonly admitted: true; readonly value: T };

export interface LanAuthorityTransferRouteAccess {
  resolve(
    projectId: CollabProjectId,
  ): LanAuthorityTransferRouteRegistration | null;

  /**
   * The lifecycle owner rechecks the exact registration and holds its Project
   * replacement lane for the full callback. A state transition closes and
   * drains this same lane before replacing the registration.
   */
  runIfCurrent<T>(
    projectId: CollabProjectId,
    expected: LanAuthorityTransferRouteRegistration,
    operation: () => Promise<T>,
  ): Promise<LanAuthorityTransferRouteAdmissionResult<T>>;
}

function routeError(
  code:
    | 'authentication-failed'
    | 'authorization-denied'
    | 'operation-failed'
    | 'project-not-found'
    | 'protocol-payload-invalid'
    | 'protocol-version-unsupported',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({ code, safeContext: { reason, ...safeContext } });
}

function validateCanonicalCredential(credential: string, reason: string): Buffer {
  if (!MEMBER_CREDENTIAL_PATTERN.test(credential)) {
    throw routeError('authentication-failed', reason);
  }
  const decoded = Buffer.from(credential, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== credential) {
    throw routeError('authentication-failed', reason);
  }
  return decoded;
}

function transferCredentialHash(credential: string): Buffer {
  return createHash('sha256')
    .update(validateCanonicalCredential(
      credential,
      'authority-transfer-credential-invalid',
    ))
    .digest();
}

function decodeCredentialHash(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw routeError('operation-failed', 'authority-transfer-credential-hash-invalid');
  }
  return Buffer.from(value, 'hex');
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

function requestId(headers: IncomingHttpHeaders): string {
  const supplied = singleHeader(headers, 'x-request-id');
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentType = singleHeader(request.headers, 'content-type');
  if (
    contentType === null
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    request.resume();
    throw routeError(
      'protocol-payload-invalid',
      'authority-transfer-request-content-type-invalid',
    );
  }
  const declared = singleHeader(request.headers, 'content-length');
  if (declared !== null && Number(declared) > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
    request.resume();
    throw routeError(
      'protocol-payload-invalid',
      'authority-transfer-request-too-large',
    );
  }
  const chunks: Buffer[] = [];
  let observed = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    observed += bytes.byteLength;
    if (observed > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
      throw routeError(
        'protocol-payload-invalid',
        'authority-transfer-request-too-large',
      );
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) {
    throw routeError('protocol-payload-invalid', 'authority-transfer-request-body-missing');
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw routeError('protocol-payload-invalid', 'authority-transfer-request-json-invalid');
  }
}

function statusForError(error: CollabError): number {
  if (error.safeContext.reason === 'authority-transfer-request-too-large') return 413;
  switch (error.code) {
    case 'authentication-failed':
    case 'membership-claim-invalid': return 401;
    case 'authorization-denied': return 403;
    case 'project-not-found':
    case 'authority-transfer-not-found': return 404;
    case 'protocol-version-unsupported': return 426;
    case 'authority-transfer-stale':
    case 'authority-transfer-cancellation-forbidden':
    case 'idempotency-conflict':
    case 'membership-claim-already-redeemed': return 409;
    case 'membership-claim-expired':
    case 'membership-claim-revoked': return 410;
    case 'operation-timeout': return 408;
    case 'protocol-payload-invalid': return 400;
    default: return 500;
  }
}

function asCollabError(error: unknown): CollabError {
  return error instanceof CollabError
    ? error
    : routeError('operation-failed', 'authority-transfer-route-failed');
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  requestIdValue: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (response.headersSent || response.destroyed) return;
  let bytes = Buffer.from(JSON.stringify({
    bindingVersion: COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
    ...payload,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    requestId: requestIdValue,
  }), 'utf8');
  if (bytes.byteLength > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
    statusCode = 500;
    bytes = Buffer.from(JSON.stringify({
      bindingVersion: COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
      error: routeError(
        'operation-failed',
        'authority-transfer-response-too-large',
      ).toJSON(),
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      requestId: requestIdValue,
    }), 'utf8');
  }
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestIdValue,
  });
  response.end(bytes);
}

function isOperationAllowed(
  registration: LanAuthorityTransferRouteRegistration,
  operation: CollabAuthorityTransferOperation,
): boolean {
  switch (registration.state) {
    case 'source-active':
      return operation === 'requestLanToCloudTransfer'
        || operation === 'acceptLanToCloudTransferTarget'
        || operation === 'getProjectAuthorityTransfer'
        || operation === 'cancelProjectAuthorityTransfer';
    case 'target-only-staged':
      return operation === 'acceptCloudToLanTransferTarget'
        || operation === 'getProjectAuthorityTransfer'
        || operation === 'reportCloudToLanTargetStaged'
        || operation === 'confirmCloudToLanTargetActive';
    case 'target-active':
      return operation === 'claimTransferredMembership';
    case 'terminal-source':
      return operation === 'getProjectAuthorityTransfer'
        || operation === 'getTransferredMembershipClaim'
        || operation === 'acknowledgeTransferredMembershipClaimRedemption';
  }
}

function bearerCredential(request: IncomingMessage): string {
  const authorization = singleHeader(request.headers, 'authorization');
  const match = authorization
    ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    : null;
  if (!match) {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  validateCanonicalCredential(
    match[1],
    'authority-transfer-authentication-failed',
  );
  return match[1];
}

function requireTransferCredential(
  request: IncomingMessage,
  registration: LanAuthorityTransferTargetOnlyStagedRegistration,
): void {
  const authorization = singleHeader(request.headers, 'authorization');
  const match = authorization
    ? /^Claudian-Authority-Transfer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    : null;
  if (!match) {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  let actual: Buffer;
  try {
    actual = transferCredentialHash(match[1]);
  } catch {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  const expected = decodeCredentialHash(registration.credentialHash);
  if (!timingSafeEqual(actual, expected)) {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
}

function requireLanClaimRequest(
  request: IncomingMessage,
  operation: CollabAuthorityTransferOperation,
  body: Buffer,
): LanClaimTransferredMembershipRequest {
  const authorization = singleHeader(request.headers, 'authorization');
  const match = authorization
    ? /^Claudian-Transfer-Claim ([A-Za-z0-9_-]+)$/.exec(authorization)
    : null;
  if (!match || operation !== 'claimTransferredMembership') {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  let decoded: ClaimTransferredMembershipRequest;
  try {
    decoded = decodeCollabAuthorityTransferOperationRequest(
      'claimTransferredMembership',
      parseJsonBody(body),
    );
  } catch {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  if (
    !('credentialHash' in decoded)
    || typeof decoded.credentialHash !== 'string'
  ) {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  if (
    !BASE64URL_PATTERN.test(decoded.claim)
    || match[1].length !== decoded.claim.length
    || !timingSafeEqual(Buffer.from(match[1]), Buffer.from(decoded.claim))
  ) {
    throw routeError('authentication-failed', 'authority-transfer-authentication-failed');
  }
  return decoded;
}

export class LanAuthorityTransferRouter {
  constructor(private readonly routes: LanAuthorityTransferRouteAccess) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const route = matchCollabLanAuthorityTransferRoute(request.method, request.url);
    if (!route) return false;
    const requestIdValue = requestId(request.headers);
    try {
      if (route.version !== COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION) {
        request.resume();
        throw routeError(
          'protocol-version-unsupported',
          'authority-transfer-binding-version-unsupported',
          {
            receivedVersion: route.version,
            supportedVersion: COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION,
          },
        );
      }
      const body = await readRequestBody(request);
      const registration = this.routes.resolve(route.projectId);
      if (
        !registration
        || registration.projectId !== route.projectId
      ) {
        throw routeError(
          'authentication-failed',
          'authority-transfer-authentication-failed',
        );
      }
      const admission = await this.routes.runIfCurrent(
        route.projectId,
        registration,
        async () => {
          let actor: LanAuthorityTransferActor | null = null;
          let lanClaimRequest: LanClaimTransferredMembershipRequest | null = null;
          if (
            registration.state === 'source-active'
            || registration.state === 'terminal-source'
          ) {
            try {
              actor = await registration.service.authenticateMemberCredential(
                bearerCredential(request),
              );
            } catch {
              throw routeError(
                'authentication-failed',
                'authority-transfer-authentication-failed',
              );
            }
            if (!isCollabMemberId(actor.memberId)) {
              throw routeError(
                'authentication-failed',
                'authority-transfer-authentication-failed',
              );
            }
          } else if (registration.state === 'target-only-staged') {
            requireTransferCredential(request, registration);
          } else {
            lanClaimRequest = requireLanClaimRequest(
              request,
              route.operation,
              body,
            );
          }
          if (!isOperationAllowed(registration, route.operation)) {
            throw routeError('project-not-found', 'authority-transfer-route-not-found');
          }
          const decoded = lanClaimRequest
            ?? decodeCollabAuthorityTransferOperationRequest(
              route.operation,
              parseJsonBody(body),
            );
          if (decoded.projectId !== registration.projectId) {
            throw routeError('project-not-found', 'authority-transfer-project-mismatch');
          }
          if (
            (registration.state === 'target-only-staged'
              || registration.state === 'target-active')
            && (
              !('transferId' in decoded)
              || decoded.transferId !== registration.transferId
            )
          ) {
            throw routeError('project-not-found', 'authority-transfer-route-not-found');
          }
          const result = await this.dispatch(
            registration,
            route.operation,
            decoded,
            actor,
            lanClaimRequest,
          );
          const decodedResponse = decodeCollabAuthorityTransferOperationResponse(
            route.operation,
            result,
          );
          if (
            decodedResponse.projectId !== decoded.projectId
            || (
              'transferId' in decoded
              && decodedResponse.transferId !== decoded.transferId
            )
          ) {
            throw routeError('operation-failed', 'authority-transfer-response-mismatch');
          }
          return decodedResponse;
        },
      );
      if (!admission.admitted) {
        throw routeError(
          'authentication-failed',
          'authority-transfer-authentication-failed',
        );
      }
      writeJson(response, 200, requestIdValue, { data: admission.value });
    } catch (error) {
      const collabError = asCollabError(error);
      writeJson(response, statusForError(collabError), requestIdValue, {
        error: collabError.toJSON(),
      });
    }
    return true;
  }

  private dispatch(
    registration: LanAuthorityTransferRouteRegistration,
    operation: CollabAuthorityTransferOperation,
    request: OperationRequest<CollabAuthorityTransferOperation>,
    actor: LanAuthorityTransferActor | null,
    lanClaimRequest: LanClaimTransferredMembershipRequest | null,
  ): Promise<unknown> {
    switch (registration.state) {
      case 'source-active': {
        const authenticated = actor!;
        switch (operation) {
          case 'requestLanToCloudTransfer':
            return registration.service.requestLanToCloudTransfer(
              authenticated,
              request as RequestLanToCloudTransferRequest,
            );
          case 'acceptLanToCloudTransferTarget':
            if (authenticated.memberId !== registration.hostMemberId) {
              throw routeError('authorization-denied', 'authority-transfer-host-required');
            }
            return registration.service.acceptLanToCloudTransferTarget(
              authenticated,
              request as AcceptLanToCloudTransferTargetRequest,
            );
          case 'getProjectAuthorityTransfer':
            return registration.service.getProjectAuthorityTransfer(
              authenticated,
              request as GetProjectAuthorityTransferRequest,
            );
          case 'cancelProjectAuthorityTransfer':
            return registration.service.cancelProjectAuthorityTransfer(
              authenticated,
              request as CancelProjectAuthorityTransferRequest,
            );
          default: break;
        }
        break;
      }
      case 'target-only-staged':
        switch (operation) {
          case 'acceptCloudToLanTransferTarget':
            return registration.service.acceptCloudToLanTransferTarget(
              request as AcceptCloudToLanTransferTargetRequest,
            );
          case 'getProjectAuthorityTransfer':
            return registration.service.getProjectAuthorityTransfer(
              request as GetProjectAuthorityTransferRequest,
            );
          case 'reportCloudToLanTargetStaged':
            return registration.service.reportCloudToLanTargetStaged(
              request as ReportCloudToLanTargetStagedRequest,
            );
          case 'confirmCloudToLanTargetActive':
            return registration.service.confirmCloudToLanTargetActive(
              request as ConfirmCloudToLanTargetActiveRequest,
            );
          default: break;
        }
        break;
      case 'target-active':
        if (operation === 'claimTransferredMembership' && lanClaimRequest) {
          return registration.service.claimTransferredMembership(
            lanClaimRequest,
          );
        }
        break;
      case 'terminal-source': {
        const authenticated = actor!;
        switch (operation) {
          case 'getProjectAuthorityTransfer':
            return registration.service.getProjectAuthorityTransfer(
              authenticated,
              request as GetProjectAuthorityTransferRequest,
            );
          case 'getTransferredMembershipClaim':
            return registration.service.getTransferredMembershipClaim(
              authenticated,
              request as GetTransferredMembershipClaimRequest,
            );
          case 'acknowledgeTransferredMembershipClaimRedemption':
            return registration.service.acknowledgeTransferredMembershipClaimRedemption(
              authenticated,
              request as AcknowledgeTransferredMembershipClaimRedemptionRequest,
            );
          default: break;
        }
        break;
      }
    }
    throw routeError('project-not-found', 'authority-transfer-route-not-found');
  }
}
