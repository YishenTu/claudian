import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpsRequest } from 'node:https';

import type {
  HostTransferTargetTransportPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  serializeHostTransferPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { hostTransferProvisionalPath } from '@/app/collab/lan/HostTransferProvisionalRouter';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { fingerprintCertificatePem } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

const RESPONSE_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function transportError(
  reason: string,
  code: 'authentication-failed' | 'cancelled' | 'endpoint-unreachable'
    | 'operation-failed' | 'operation-timeout' | 'protocol-payload-invalid'
    | 'tls-ca-mismatch' = 'operation-failed',
): CollabError {
  return new CollabError({ code, recoveryActions: ['retry', 'open-diagnostics'], safeContext: { reason } });
}

function pinnedTrust(input: {
  readonly endpoint: string;
  readonly projectId: string;
  readonly targetCaCertificatePem: string;
  readonly targetCaFingerprint: string;
}): PinnedCollabHttpClient {
  if (fingerprintCertificatePem(input.targetCaCertificatePem) !== input.targetCaFingerprint) {
    throw transportError('host-transfer-target-ca-mismatch', 'tls-ca-mismatch');
  }
  return new PinnedCollabHttpClient({
    caCertificatePem: input.targetCaCertificatePem,
    caFingerprint: input.targetCaFingerprint,
    endpoint: input.endpoint,
    projectId: input.projectId,
  }, DEFAULT_TIMEOUT_MS);
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw transportError('host-transfer-response-invalid', 'protocol-payload-invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

async function requestReceiver(input: {
  readonly body?: AsyncIterable<Uint8Array> | Uint8Array;
  readonly contentLength?: number;
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly path: string;
  readonly receiverCredential: string;
  readonly signal?: AbortSignal;
  readonly targetCaCertificatePem: string;
}): Promise<unknown> {
  if (input.signal?.aborted) throw transportError('host-transfer-request-cancelled', 'cancelled');
  const endpoint = new URL(input.endpoint);
  const response = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const request = httpsRequest({
      ca: input.targetCaCertificatePem,
      headers: {
        accept: 'application/json',
        authorization: `Claudian-Receiver ${input.receiverCredential}`,
        ...(input.contentLength === undefined ? {} : {
          'content-length': String(input.contentLength),
        }),
        ...input.headers,
        'x-request-id': randomUUID(),
      },
      hostname: endpoint.hostname,
      method: 'POST',
      minVersion: 'TLSv1.2',
      path: input.path,
      port: Number(endpoint.port),
      rejectUnauthorized: true,
    }, incoming => {
      const chunks: Buffer[] = [];
      let observed = 0;
      incoming.on('data', chunk => {
        const bytes = Buffer.from(chunk as Uint8Array);
        observed += bytes.byteLength;
        if (observed > RESPONSE_LIMIT) {
          incoming.destroy();
          finish(() => reject(transportError(
            'host-transfer-response-too-large',
            'protocol-payload-invalid',
          )));
          return;
        }
        chunks.push(bytes);
      });
      incoming.once('error', () => finish(() => reject(transportError(
        'host-transfer-response-failed',
        'endpoint-unreachable',
      ))));
      incoming.once('end', () => {
        if (settled) return;
        const status = incoming.statusCode ?? 0;
        try {
          const value = chunks.length === 0
            ? null
            : JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (status < 200 || status >= 300) {
            finish(() => reject(transportError(
              status === 401
                ? 'host-transfer-receiver-authentication-failed'
                : 'host-transfer-target-rejected',
              status === 401 ? 'authentication-failed' : 'operation-failed',
            )));
            return;
          }
          finish(() => resolve(value));
        } catch {
          finish(() => reject(transportError(
            'host-transfer-response-invalid',
            'protocol-payload-invalid',
          )));
        }
      });
    });
    const onAbort = () => finish(() => {
      request.destroy();
      reject(transportError('host-transfer-request-cancelled', 'cancelled'));
    });
    const timer = window.setTimeout(() => finish(() => {
      request.destroy();
      reject(transportError('host-transfer-request-timeout', 'operation-timeout'));
    }), DEFAULT_TIMEOUT_MS);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    request.once('error', () => finish(() => reject(transportError(
      'host-transfer-request-failed',
      'endpoint-unreachable',
    ))));
    void (async () => {
      try {
        if (input.body instanceof Uint8Array) {
          request.write(input.body);
        } else if (input.body) {
          for await (const chunk of input.body) {
            if (input.signal?.aborted) throw transportError('host-transfer-request-cancelled', 'cancelled');
            if (!request.write(chunk)) await once(request, 'drain');
          }
        }
        request.end();
      } catch (error) {
        finish(() => {
          request.destroy();
          reject(toError(error, 'Host transfer request body failed.'));
        });
      }
    })();
  });
  return response;
}

async function* concatenate(
  ...sources: readonly AsyncIterable<Uint8Array>[]
): AsyncIterable<Uint8Array> {
  for (const source of sources) yield* source;
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export class HostTransferTargetTransport implements HostTransferTargetTransportPort {
  async probe(input: Parameters<HostTransferTargetTransportPort['probe']>[0]): Promise<void> {
    pinnedTrust({ ...input, projectId: 'host-transfer-provisional' });
    const response = responseRecord(await requestReceiver({
      endpoint: input.endpoint,
      path: hostTransferProvisionalPath(input.transferId, 'probe'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (response.transferId !== input.transferId) {
      throw transportError('host-transfer-probe-mismatch', 'protocol-payload-invalid');
    }
  }

  async stage(input: Parameters<HostTransferTargetTransportPort['stage']>[0]) {
    pinnedTrust({ ...input, projectId: input.manifest.projectId });
    const serialized = serializeHostTransferPackageManifest(input.manifest);
    const manifestBytes = Buffer.from(serialized, 'utf8');
    const response = responseRecord(await requestReceiver({
      body: concatenate(oneChunk(manifestBytes), input.gitBundle, input.authoritySnapshot),
      contentLength: manifestBytes.byteLength
        + input.manifest.gitBundle.byteCount
        + input.manifest.authoritySnapshot.byteCount,
      endpoint: input.endpoint,
      headers: {
        'content-type': 'application/octet-stream',
        'x-claudian-manifest-length': String(manifestBytes.byteLength),
      },
      path: hostTransferProvisionalPath(input.transferId, 'stage'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (
      response.transferId !== input.transferId
      || typeof response.manifestDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(response.manifestDigest)
    ) throw transportError('host-transfer-stage-response-invalid', 'protocol-payload-invalid');
    return { manifestDigest: response.manifestDigest };
  }

  async activate(input: Parameters<HostTransferTargetTransportPort['activate']>[0]): Promise<void> {
    pinnedTrust({ ...input, projectId: input.activationCertificate.projectId });
    const body = Buffer.from(JSON.stringify(input.activationCertificate), 'utf8');
    const response = responseRecord(await requestReceiver({
      body,
      contentLength: body.byteLength,
      endpoint: input.endpoint,
      headers: { 'content-type': 'application/json' },
      path: hostTransferProvisionalPath(input.transferId, 'activate'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (response.activated !== true || response.transferId !== input.transferId) {
      throw transportError('host-transfer-activate-response-invalid', 'protocol-payload-invalid');
    }
  }

  async cancel(input: Parameters<HostTransferTargetTransportPort['cancel']>[0]): Promise<void> {
    pinnedTrust({ ...input, projectId: 'host-transfer-provisional' });
    const response = responseRecord(await requestReceiver({
      endpoint: input.endpoint,
      path: hostTransferProvisionalPath(input.transferId, 'cancel'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (response.cancelled !== true || response.transferId !== input.transferId) {
      throw transportError('host-transfer-cancel-response-invalid', 'protocol-payload-invalid');
    }
  }

  async verifyActive(input: Parameters<HostTransferTargetTransportPort['verifyActive']>[0]): Promise<void> {
    const pinned = pinnedTrust(input);
    const operation = 'getSnapshot' as const;
    const snapshot = await pinned.requestWithMember({
      decode: lanCollabControlOperationCodec(operation).decodeResponse,
      method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
      path: collabControlOperationPath(operation, input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
    if (
      snapshot.project.id !== input.projectId
      || snapshot.project.hostMemberId !== input.targetHostMemberId
    ) throw transportError('host-transfer-target-authority-mismatch', 'protocol-payload-invalid');
  }

  async markCompleted(
    input: Parameters<HostTransferTargetTransportPort['markCompleted']>[0],
  ): Promise<void> {
    pinnedTrust({ ...input, projectId: 'host-transfer-provisional' });
    const response = responseRecord(await requestReceiver({
      endpoint: input.endpoint,
      path: hostTransferProvisionalPath(input.transferId, 'complete'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (response.completed !== true || response.transferId !== input.transferId) {
      throw transportError('host-transfer-complete-response-invalid', 'protocol-payload-invalid');
    }
  }

  async confirmTerminal(
    input: Parameters<HostTransferTargetTransportPort['confirmTerminal']>[0],
  ): Promise<void> {
    pinnedTrust({ ...input, projectId: 'host-transfer-provisional' });
    const response = responseRecord(await requestReceiver({
      endpoint: input.endpoint,
      path: hostTransferProvisionalPath(input.transferId, 'confirm'),
      receiverCredential: input.receiverCredential,
      ...(input.signal ? { signal: input.signal } : {}),
      targetCaCertificatePem: input.targetCaCertificatePem,
    }));
    if (response.confirmed !== true || response.transferId !== input.transferId) {
      throw transportError('host-transfer-confirm-response-invalid', 'protocol-payload-invalid');
    }
  }

}
