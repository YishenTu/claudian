import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { type CollabOperationId, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import {
  HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
  HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
  HOST_TRANSFER_MAX_MANIFEST_BYTES,
  parseHostTransferRecoveryPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import type {
  HostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import type {
  IncomingHostTransferCoordinator,
  IncomingHostTransferTerminalResult,
} from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';
import { COLLAB_HOST_TRANSFER_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const HOST_TRANSFER_ROUTE_PREFIX = `/v${COLLAB_HOST_TRANSFER_PROTOCOL_VERSION}/host-transfers`;
const ROUTE_PATTERN = new RegExp(`^${HOST_TRANSFER_ROUTE_PREFIX}/([^/]+)/(probe|stage|activate|cancel|complete|confirm)$`);
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVATION_BYTES = 16 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface HostTransferProvisionalRegistration {
  readonly coordinator: Pick<
    IncomingHostTransferCoordinator,
    'activate' | 'cancel' | 'complete' | 'confirm' | 'stage'
  >;
  readonly projectId: CollabProjectId;
  readonly receiverCredential?: string;
  readonly receiverCredentialHash?: string;
  readonly transferId: CollabOperationId;
}

interface RegisteredReceiver extends Omit<
  HostTransferProvisionalRegistration,
  'receiverCredential' | 'receiverCredentialHash'
> {
  readonly credentialHash: Buffer;
}

function routeError(reason: string, code: 'authentication-failed' | 'protocol-payload-invalid' = 'protocol-payload-invalid') {
  return new CollabError({ code, safeContext: { reason } });
}

function credentialHash(credential: string): Buffer {
  if (!CREDENTIAL_PATTERN.test(credential)) {
    throw routeError('host-transfer-receiver-credential-invalid', 'authentication-failed');
  }
  const decoded = Buffer.from(credential, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== credential) {
    throw routeError('host-transfer-receiver-credential-invalid', 'authentication-failed');
  }
  return createHash('sha256').update(decoded).digest();
}

function requireCredential(request: IncomingMessage, expected: Buffer): void {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string'
    ? /^Claudian-Receiver ([A-Za-z0-9_-]{43})$/.exec(authorization)
    : null;
  if (!match) throw routeError('host-transfer-receiver-authentication-failed', 'authentication-failed');
  const actual = credentialHash(match[1]);
  if (!timingSafeEqual(actual, expected)) {
    throw routeError('host-transfer-receiver-authentication-failed', 'authentication-failed');
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let observed = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    observed += bytes.byteLength;
    if (observed > maxBytes) throw routeError('host-transfer-request-too-large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function activationCertificate(value: unknown): HostTransferActivationCertificate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routeError('host-transfer-activation-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'schemaVersion', 'projectId', 'transferId', 'targetHostMemberId',
    'targetCaFingerprint', 'manifestDigest', 'cutoverAt',
    'signatureAlgorithm', 'signature',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length
    || Object.keys(record).some(key => !expectedKeys.includes(key))
    || record.schemaVersion !== 1
    || !isCollabProjectId(record.projectId)
    || !isCollabOpaqueId(record.transferId)
    || !isCollabMemberId(record.targetHostMemberId)
    || typeof record.targetCaFingerprint !== 'string' || !DIGEST_PATTERN.test(record.targetCaFingerprint)
    || typeof record.manifestDigest !== 'string' || !DIGEST_PATTERN.test(record.manifestDigest)
    || typeof record.cutoverAt !== 'string'
    || Number.isNaN(Date.parse(record.cutoverAt))
    || new Date(record.cutoverAt).toISOString() !== record.cutoverAt
    || record.signatureAlgorithm !== 'rsa-pss-sha256'
    || typeof record.signature !== 'string'
    || !/^[A-Za-z0-9_-]{64,2048}$/.test(record.signature)
  ) throw routeError('host-transfer-activation-invalid');
  return record as unknown as HostTransferActivationCertificate;
}

async function* takeBodyBytes(
  iterator: AsyncIterator<unknown>,
  state: { remainder: Buffer | null },
  expectedBytes: number,
): AsyncIterable<Uint8Array> {
  let emitted = 0;
  while (emitted < expectedBytes) {
    const next = state.remainder
      ? { done: false, value: state.remainder }
      : await iterator.next();
    state.remainder = null;
    if (next.done) throw routeError('host-transfer-stage-truncated');
    const bytes = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    const remaining = expectedBytes - emitted;
    if (bytes.byteLength > remaining) {
      state.remainder = bytes.subarray(remaining);
      yield bytes.subarray(0, remaining);
      emitted += remaining;
    } else {
      emitted += bytes.byteLength;
      yield bytes;
    }
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

export function hostTransferProvisionalPath(
  transferId: CollabOperationId,
  action: 'activate' | 'cancel' | 'complete' | 'confirm' | 'probe' | 'stage',
): string {
  if (!isCollabOpaqueId(transferId)) throw routeError('host-transfer-route-invalid');
  return `${HOST_TRANSFER_ROUTE_PREFIX}/${transferId}/${action}`;
}

export class HostTransferProvisionalRouter {
  private readonly receivers = new Map<CollabOperationId, RegisteredReceiver>();

  get size(): number {
    return this.receivers.size;
  }

  register(registration: HostTransferProvisionalRegistration): () => void {
    if (
      !isCollabProjectId(registration.projectId)
      || !isCollabOpaqueId(registration.transferId)
    ) {
      throw routeError('host-transfer-registration-invalid');
    }
    if ((registration.receiverCredential === undefined)
      === (registration.receiverCredentialHash === undefined)) {
      throw routeError('host-transfer-registration-credential-invalid');
    }
    if (
      registration.receiverCredentialHash !== undefined
      && !DIGEST_PATTERN.test(registration.receiverCredentialHash)
    ) throw routeError('host-transfer-registration-credential-invalid');
    const receiver: RegisteredReceiver = {
      coordinator: registration.coordinator,
      credentialHash: registration.receiverCredential === undefined
        ? Buffer.from(registration.receiverCredentialHash!, 'hex')
        : credentialHash(registration.receiverCredential),
      projectId: registration.projectId,
      transferId: registration.transferId,
    };
    const existing = this.receivers.get(registration.transferId);
    if (existing && (
      existing.projectId !== receiver.projectId
      || !timingSafeEqual(existing.credentialHash, receiver.credentialHash)
    )) throw routeError('host-transfer-registration-conflict');
    this.receivers.set(registration.transferId, receiver);
    return () => {
      if (this.receivers.get(registration.transferId) === receiver) {
        this.receivers.delete(registration.transferId);
      }
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = new URL(request.url ?? '/', 'https://claudian.invalid');
    const match = ROUTE_PATTERN.exec(parsed.pathname);
    if (!match || parsed.search || parsed.hash) return false;
    const [, transferId, action] = match;
    const receiver = this.receivers.get(transferId);
    if (!receiver) {
      writeJson(response, 404, { error: { code: 'project-not-found' } });
      return true;
    }
    try {
      requireCredential(request, receiver.credentialHash);
      if (request.method !== 'POST') throw routeError('host-transfer-method-invalid');
      if (action === 'probe') {
        writeJson(response, 200, { projectId: receiver.projectId, transferId });
        return true;
      }
      if (action === 'cancel') {
        const result = await receiver.coordinator.cancel(receiver.projectId, transferId);
        this.writeTerminalResponse(
          response,
          receiver,
          result,
          { cancelled: true, transferId },
          false,
        );
        return true;
      }
      if (action === 'complete') {
        const result = await receiver.coordinator.complete(receiver.projectId, transferId);
        this.writeTerminalResponse(
          response,
          receiver,
          result,
          { completed: true, transferId },
          false,
        );
        return true;
      }
      if (action === 'confirm') {
        const result = await receiver.coordinator.confirm(receiver.projectId, transferId);
        this.writeTerminalResponse(
          response,
          receiver,
          result,
          { confirmed: true, transferId },
          true,
        );
        return true;
      }
      if (action === 'activate') {
        const body = await readBody(request, MAX_ACTIVATION_BYTES);
        let decoded: unknown;
        try {
          decoded = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          throw routeError('host-transfer-activation-invalid');
        }
        const certificate = activationCertificate(decoded);
        if (certificate.projectId !== receiver.projectId || certificate.transferId !== transferId) {
          throw routeError('host-transfer-activation-binding-mismatch');
        }
        await receiver.coordinator.activate(receiver.projectId, transferId, certificate);
        writeJson(response, 200, { activated: true, transferId });
        return true;
      }

      const manifestLength = Number(request.headers['x-claudian-manifest-length']);
      if (
        !Number.isSafeInteger(manifestLength)
        || manifestLength < 1
        || manifestLength > HOST_TRANSFER_MAX_MANIFEST_BYTES
      ) throw routeError('host-transfer-manifest-header-invalid');
      const iterator = request[Symbol.asyncIterator]();
      const state = { remainder: null as Buffer | null };
      const manifestBytes = await iterableToBuffer(takeBodyBytes(
        iterator,
        state,
        manifestLength,
      ));
      const manifest = parseHostTransferRecoveryPackageManifest(manifestBytes.toString('utf8'));
      if (manifest.projectId !== receiver.projectId || manifest.transferId !== transferId) {
        throw routeError('host-transfer-manifest-binding-mismatch');
      }
      const expectedBytes = manifestLength
        + manifest.gitBundle.byteCount
        + manifest.authoritySnapshot.byteCount;
      const contentLength = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
        throw routeError('host-transfer-stage-length-invalid');
      }
      if (
        manifest.gitBundle.byteCount > HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES
        || manifest.authoritySnapshot.byteCount > HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES
      ) throw routeError('host-transfer-stage-length-invalid');
      let gitConsumed = false;
      const gitBundle = (async function* () {
        yield* takeBodyBytes(iterator, state, manifest.gitBundle.byteCount);
        gitConsumed = true;
      })();
      const authoritySnapshot = (async function* () {
        if (!gitConsumed) throw routeError('host-transfer-stage-read-order-invalid');
        yield* takeBodyBytes(iterator, state, manifest.authoritySnapshot.byteCount);
        if (state.remainder || !(await iterator.next()).done) {
          throw routeError('host-transfer-stage-trailing-data');
        }
      })();
      const staged = await receiver.coordinator.stage({
        authoritySnapshot,
        gitBundle,
        manifest,
        projectId: receiver.projectId,
        transferId,
      });
      writeJson(response, 200, {
        manifestDigest: staged.manifestDigest,
        transferId,
      });
      return true;
    } catch (error) {
      const collabError = error instanceof CollabError
        ? error
        : routeError('host-transfer-route-failed');
      writeJson(response, collabError.code === 'authentication-failed' ? 401 : 422, {
        error: { code: collabError.code },
      });
      return true;
    }
  }

  clear(): void {
    this.receivers.clear();
  }

  unregister(transferId: CollabOperationId): boolean {
    return this.receivers.delete(transferId);
  }

  private writeTerminalResponse(
    response: ServerResponse,
    receiver: RegisteredReceiver,
    result: IncomingHostTransferTerminalResult,
    body: unknown,
    removeReceiver: boolean,
  ): void {
    response.once('finish', () => {
      void result.afterResponseFlushed().then(() => {
        if (removeReceiver && this.receivers.get(receiver.transferId) === receiver) {
          this.receivers.delete(receiver.transferId);
        }
      }).catch(() => undefined);
    });
    writeJson(response, 200, body);
  }
}

async function iterableToBuffer(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
