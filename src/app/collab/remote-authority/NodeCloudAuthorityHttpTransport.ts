import {
  type ClientRequest,
  type IncomingMessage,
  request as requestHttp,
} from 'node:http';
import { request as requestHttps } from 'node:https';

import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import {
  cloudAuthorityError,
  cloudAuthorityOperationError,
  cloudAuthorityProtocolError,
} from '@/app/collab/remote-authority/CloudAuthorityError';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

function responseTooLarge(): CollabError {
  return cloudAuthorityProtocolError('cloud-authority-response-too-large');
}

function invalidResponse(): CollabError {
  return cloudAuthorityProtocolError('cloud-authority-response-invalid');
}

function cancelledRequest(): CollabError {
  return cloudAuthorityError('cancelled', 'cloud-authority-request-cancelled');
}

function invalidRequestBody(): CollabError {
  return cloudAuthorityOperationError('cloud-authority-request-body-invalid');
}

function unreachableAuthority(): CollabError {
  return cloudAuthorityError('endpoint-unreachable', 'cloud-authority-request-failed');
}

function encodedRequestBody(
  input: CloudAuthorityHttpRequest,
): Buffer | null | undefined {
  if (input.body === undefined) return undefined;
  try {
    const serialized = JSON.stringify(input.body);
    return serialized === undefined ? null : Buffer.from(serialized, 'utf8');
  } catch {
    return null;
  }
}

export class NodeCloudAuthorityHttpTransport {
  readonly #timeoutMs: number;

  constructor(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  readonly request: CloudAuthorityHttpTransport = input => {
    if (input.signal?.aborted) {
      return Promise.reject(cancelledRequest());
    }

    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return Promise.reject(unreachableAuthority());
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(unreachableAuthority());
    }

    const encodedBody = encodedRequestBody(input);
    if (encodedBody === null) return Promise.reject(invalidRequestBody());
    const body = encodedBody;
    const headers: Record<string, string> = { ...input.headers };
    if (body !== undefined) {
      headers['content-length'] = String(body.byteLength);
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    const request = url.protocol === 'https:' ? requestHttps : requestHttp;

    return new Promise<CloudAuthorityHttpResponse>((resolve, reject) => {
      let incoming: IncomingMessage | null = null;
      let settled = false;
      let timer: number | null = null;
      let outgoing: ClientRequest | null = null;

      const cleanup = (): void => {
        if (timer !== null) window.clearTimeout(timer);
        input.signal?.removeEventListener('abort', onCallerAbort);
      };
      const finish = (destroy: boolean): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        if (destroy) {
          incoming?.destroy();
          outgoing?.destroy();
        }
        return true;
      };
      const fail = (error: CollabError, destroy = true): void => {
        if (finish(destroy)) reject(error);
      };
      const onCallerAbort = (): void => {
        fail(cancelledRequest());
      };
      const onRequestError = (): void => {
        fail(unreachableAuthority(), false);
      };

      try {
        outgoing = request(url, { headers, method: input.method }, response => {
          incoming = response;
          const declaredLength = response.headers['content-length'];
          if (
            declaredLength !== undefined
            && (
              typeof declaredLength !== 'string'
              || !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
              || Number(declaredLength) > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes
            )
          ) {
            fail(responseTooLarge());
            return;
          }
          const chunks: Buffer[] = [];
          let byteLength = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            byteLength += bytes.byteLength;
            if (byteLength > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
              fail(responseTooLarge());
              return;
            }
            chunks.push(bytes);
          });
          response.once('aborted', () => fail(invalidResponse()));
          response.once('error', () => fail(invalidResponse()));
          response.once('end', () => {
            if (settled) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8')) as unknown;
            } catch {
              fail(invalidResponse(), false);
              return;
            }
            const contentType = response.headers['content-type'];
            if (finish(false)) {
              resolve({
                body: parsed,
                contentType: typeof contentType === 'string' ? contentType : null,
                status: response.statusCode ?? 0,
              });
            }
          });
          response.once('close', () => {
            if (!settled) fail(invalidResponse());
          });
        });
      } catch {
        fail(unreachableAuthority(), false);
        return;
      }

      outgoing.once('error', onRequestError);
      input.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (input.signal?.aborted) {
        onCallerAbort();
        return;
      }
      timer = window.setTimeout(() => {
        fail(cloudAuthorityError('operation-timeout', 'cloud-authority-request-timeout'));
      }, this.#timeoutMs);
      outgoing.end(body);
    });
  };
}
