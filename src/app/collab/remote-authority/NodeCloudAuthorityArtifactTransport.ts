import {
  type ClientRequest,
  type IncomingMessage,
  request as requestHttp,
} from 'node:http';
import { request as requestHttps } from 'node:https';
import { type Readable, Transform } from 'node:stream';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
} from '@claudian-collab/protocol';

import {
  cloudAuthorityError,
  cloudAuthorityOperationError,
  cloudAuthorityProtocolError,
} from '@/app/collab/remote-authority/CloudAuthorityError';
import type { CloudAuthorityHttpResponse } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

interface CloudAuthorityArtifactRequestBase {
  readonly headers: Readonly<Record<string, string>>;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface CloudAuthorityArtifactUploadRequest
  extends CloudAuthorityArtifactRequestBase {
  readonly body: Readable;
  readonly byteCount: number;
}

export type CloudAuthorityArtifactDownloadRequest = CloudAuthorityArtifactRequestBase;

export type CloudAuthorityArtifactDownloadResponse =
  | {
    readonly body: Readable;
    readonly byteCount: number;
    readonly status: 200;
  }
  | CloudAuthorityHttpResponse;

export interface CloudAuthorityArtifactTransport {
  download(
    input: CloudAuthorityArtifactDownloadRequest,
  ): Promise<CloudAuthorityArtifactDownloadResponse>;
  upload(input: CloudAuthorityArtifactUploadRequest): Promise<CloudAuthorityHttpResponse>;
}

function cancelled(): CollabError {
  return cloudAuthorityError('cancelled', 'cloud-artifact-request-cancelled');
}

function timedOut(): CollabError {
  return cloudAuthorityError('operation-timeout', 'cloud-artifact-request-timeout');
}

function unreachable(): CollabError {
  return cloudAuthorityError('endpoint-unreachable', 'cloud-artifact-request-failed');
}

function invalidResponse(reason: string): CollabError {
  return cloudAuthorityProtocolError(reason);
}

function validateRequest(input: CloudAuthorityArtifactRequestBase): URL {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw cloudAuthorityOperationError('cloud-artifact-limit-invalid');
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw unreachable();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unreachable();
  return url;
}

function declaredLength(response: IncomingMessage): number | null {
  const value = response.headers['content-length'];
  if (
    typeof value !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function contentType(response: IncomingMessage): string | null {
  const value = response.headers['content-type'];
  return typeof value === 'string' ? value : null;
}

async function readJsonError(
  response: IncomingMessage,
  maximumBytes = COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
): Promise<CloudAuthorityHttpResponse> {
  const length = declaredLength(response);
  if (length !== null && length > maximumBytes) {
    response.destroy();
    throw invalidResponse('cloud-artifact-error-response-too-large');
  }
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk as Uint8Array);
    byteCount += bytes.byteLength;
    if (byteCount > maximumBytes) {
      response.destroy();
      throw invalidResponse('cloud-artifact-error-response-too-large');
    }
    chunks.push(bytes);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, byteCount).toString('utf8')) as unknown;
  } catch {
    throw invalidResponse('cloud-artifact-error-response-invalid');
  }
  return {
    body,
    contentType: contentType(response),
    status: response.statusCode ?? 0,
  };
}

export class NodeCloudAuthorityArtifactTransport implements CloudAuthorityArtifactTransport {
  constructor(
    private readonly idleTimeoutMs: number = COLLAB_CLOUD_BINDING_LIMITS.uploadIdleTimeoutMs,
    private readonly deadlineMs: number = COLLAB_CLOUD_BINDING_LIMITS.uploadDeadlineMs,
  ) {
    if (
      !Number.isSafeInteger(idleTimeoutMs)
      || idleTimeoutMs < 1
      || !Number.isSafeInteger(deadlineMs)
      || deadlineMs < idleTimeoutMs
    ) {
      throw new TypeError('Cloud artifact timeouts must be positive and ordered');
    }
  }

  download(
    input: CloudAuthorityArtifactDownloadRequest,
  ): Promise<CloudAuthorityArtifactDownloadResponse> {
    if (input.signal?.aborted) return Promise.reject(cancelled());
    let url: URL;
    try {
      url = validateRequest(input);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : unreachable());
    }
    return new Promise((resolve, reject) => {
      let completed = false;
      let outgoing: ClientRequest | null = null;
      let incoming: IncomingMessage | null = null;
      let resolvedBody: Transform | null = null;
      let responseResolved = false;
      let idleTimer = window.setTimeout(() => fail(timedOut()), this.idleTimeoutMs);
      const deadlineTimer = window.setTimeout(() => fail(timedOut()), this.deadlineMs);
      const resetIdle = (): void => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => fail(timedOut()), this.idleTimeoutMs);
      };
      const cleanup = (): void => {
        window.clearTimeout(deadlineTimer);
        window.clearTimeout(idleTimer);
        input.signal?.removeEventListener('abort', onAbort);
      };
      const complete = (): boolean => {
        if (completed) return false;
        completed = true;
        cleanup();
        return true;
      };
      const fail = (error: CollabError): void => {
        if (!complete()) return;
        if (responseResolved) resolvedBody?.destroy(error);
        incoming?.destroy();
        outgoing?.destroy();
        if (!responseResolved) reject(error);
      };
      const onAbort = (): void => fail(cancelled());
      const request = url.protocol === 'https:' ? requestHttps : requestHttp;
      try {
        outgoing = request(url, { headers: input.headers, method: 'GET' }, response => {
          incoming = response;
          resetIdle();
          response.on('data', resetIdle);
          if (response.statusCode !== 200) {
            void readJsonError(response).then(result => {
              if (complete()) resolve(result);
            }, error => fail(error instanceof Error ? error as CollabError : unreachable()));
            return;
          }
          const length = declaredLength(response);
          if (
            length === null
            || length < 1
            || length > input.maximumBytes
            || contentType(response) !== 'application/octet-stream'
          ) {
            fail(invalidResponse('cloud-artifact-download-metadata-invalid'));
            return;
          }
          let observed = 0;
          const body = new Transform({
            flush(callback) {
              callback(observed === length
                ? undefined
                : invalidResponse('cloud-artifact-download-size-invalid'));
            },
            transform(chunk: Buffer, _encoding, callback) {
              observed += Buffer.byteLength(chunk);
              callback(
                observed <= length && observed <= input.maximumBytes
                  ? null
                  : invalidResponse('cloud-artifact-download-size-invalid'),
                chunk,
              );
            },
          });
          resolvedBody = body;
          const onStreamAbort = (): void => {
            fail(cancelled());
          };
          const cleanupStream = (): void => {
            const responseIncomplete = incoming !== null && !incoming.complete;
            complete();
            input.signal?.removeEventListener('abort', onStreamAbort);
            if (responseIncomplete) {
              incoming?.destroy();
              outgoing?.destroy();
            }
          };
          body.once('close', cleanupStream);
          const rejectStream = (error?: Error): void => {
            if (!body.destroyed) {
              body.destroy(error
                ? error
                : invalidResponse('cloud-artifact-download-invalid'));
            }
          };
          response.once('aborted', () => rejectStream());
          response.once('error', error => rejectStream(error));
          input.signal?.addEventListener('abort', onStreamAbort, { once: true });
          if (input.signal?.aborted) onStreamAbort();
          response.pipe(body);
          responseResolved = true;
          resolve({ body, byteCount: length, status: 200 });
        });
      } catch {
        fail(unreachable());
        return;
      }
      outgoing.once('error', () => fail(unreachable()));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      else outgoing.end();
    });
  }

  upload(input: CloudAuthorityArtifactUploadRequest): Promise<CloudAuthorityHttpResponse> {
    if (input.signal?.aborted) return Promise.reject(cancelled());
    if (
      !Number.isSafeInteger(input.byteCount)
      || input.byteCount < 1
      || input.byteCount > input.maximumBytes
    ) {
      return Promise.reject(cloudAuthorityOperationError('cloud-artifact-upload-size-invalid'));
    }
    let url: URL;
    try {
      url = validateRequest(input);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : unreachable());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let bodyComplete = false;
      let observed = 0;
      let outgoing: ClientRequest | null = null;
      let incoming: IncomingMessage | null = null;
      let successfulResponse: CloudAuthorityHttpResponse | null = null;
      let idleTimer = window.setTimeout(() => fail(timedOut()), this.idleTimeoutMs);
      const deadlineTimer = window.setTimeout(() => fail(timedOut()), this.deadlineMs);
      const resetIdle = (): void => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => fail(timedOut()), this.idleTimeoutMs);
      };
      const cleanup = (): void => {
        window.clearTimeout(deadlineTimer);
        window.clearTimeout(idleTimer);
        input.signal?.removeEventListener('abort', onAbort);
        input.body.off('data', onData);
        input.body.off('end', onEnd);
        input.body.off('error', onBodyError);
      };
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        return true;
      };
      const fail = (error: CollabError): void => {
        if (!finish()) return;
        input.body.unpipe(outgoing ?? undefined);
        input.body.destroy();
        incoming?.destroy();
        outgoing?.destroy();
        reject(error);
      };
      const resolveSuccess = (): void => {
        if (!bodyComplete || successfulResponse === null) return;
        if (finish()) resolve(successfulResponse);
      };
      const onAbort = (): void => fail(cancelled());
      const onData = (chunk: Buffer): void => {
        resetIdle();
        observed += Buffer.byteLength(chunk);
        if (observed > input.byteCount || observed > input.maximumBytes) {
          fail(cloudAuthorityOperationError('cloud-artifact-upload-size-invalid'));
        }
      };
      const onEnd = (): void => {
        if (observed !== input.byteCount) {
          fail(cloudAuthorityOperationError('cloud-artifact-upload-size-invalid'));
          return;
        }
        bodyComplete = true;
        resolveSuccess();
      };
      const onBodyError = (): void => fail(cloudAuthorityOperationError(
        'cloud-artifact-upload-stream-invalid',
      ));
      const request = url.protocol === 'https:' ? requestHttps : requestHttp;
      try {
        outgoing = request(url, {
          headers: {
            ...input.headers,
            'content-length': String(input.byteCount),
            'content-type': 'application/octet-stream',
          },
          method: 'PUT',
        }, response => {
          incoming = response;
          resetIdle();
          response.on('data', resetIdle);
          if (response.statusCode === 204) {
            response.resume();
            response.once('end', () => {
              successfulResponse = { body: undefined, contentType: null, status: 204 };
              resolveSuccess();
            });
            return;
          }
          void readJsonError(response).then(result => {
            if (!finish()) return;
            input.body.unpipe(outgoing ?? undefined);
            input.body.destroy();
            outgoing?.destroy();
            resolve(result);
          }, error => fail(error instanceof Error ? error as CollabError : unreachable()));
        });
      } catch {
        fail(unreachable());
        return;
      }
      outgoing.once('error', () => fail(unreachable()));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      input.body.on('data', onData);
      input.body.once('end', onEnd);
      input.body.once('error', onBodyError);
      if (input.signal?.aborted) onAbort();
      else input.body.pipe(outgoing);
    });
  }
}
