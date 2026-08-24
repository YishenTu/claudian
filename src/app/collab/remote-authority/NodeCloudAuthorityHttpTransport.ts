import {
  type ClientRequest,
  type IncomingMessage,
  request as requestHttp,
} from 'node:http';
import { request as requestHttps } from 'node:https';

import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

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

export interface NodeCloudAuthorityHttpTransportOptions {
  readonly timeoutMs?: number;
}

function transportError(
  code: 'cancelled' | 'endpoint-unreachable' | 'operation-failed'
    | 'operation-timeout' | 'protocol-payload-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'protocol-payload-invalid'
      ? ['open-diagnostics']
      : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function responseTooLarge(): CollabError {
  return transportError(
    'protocol-payload-invalid',
    'cloud-authority-response-too-large',
  );
}

function invalidResponse(): CollabError {
  return transportError(
    'protocol-payload-invalid',
    'cloud-authority-response-invalid',
  );
}

function declaredResponseLength(response: IncomingMessage): number | null {
  const header = response.headers['content-length'];
  if (header === undefined) return null;
  if (
    typeof header !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(header)
    || Number(header) > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes
  ) {
    throw responseTooLarge();
  }
  return Number(header);
}

function encodedRequestBody(input: CloudAuthorityHttpRequest): Buffer | undefined {
  if (input.body === undefined) return undefined;
  try {
    const serialized = JSON.stringify(input.body);
    if (serialized === undefined) throw new TypeError('JSON body is undefined');
    return Buffer.from(serialized, 'utf8');
  } catch {
    throw transportError('operation-failed', 'cloud-authority-request-body-invalid');
  }
}

export class NodeCloudAuthorityHttpTransport {
  readonly #timeoutMs: number;

  constructor(options: NodeCloudAuthorityHttpTransportOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Invalid Cloud authority request timeout');
    }
    this.#timeoutMs = timeoutMs;
  }

  readonly request: CloudAuthorityHttpTransport = input => {
    if (input.signal?.aborted) {
      return Promise.reject(transportError(
        'cancelled',
        'cloud-authority-request-cancelled',
      ));
    }

    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return Promise.reject(transportError(
        'endpoint-unreachable',
        'cloud-authority-request-failed',
      ));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(transportError(
        'endpoint-unreachable',
        'cloud-authority-request-failed',
      ));
    }

    let body: Buffer | undefined;
    try {
      body = encodedRequestBody(input);
    } catch (error) {
      return Promise.reject(error instanceof CollabError
        ? error
        : transportError('operation-failed', 'cloud-authority-request-body-invalid'));
    }
    const headers = {
      ...input.headers,
      ...(body === undefined
        ? {}
        : {
          'content-length': String(body.byteLength),
          'content-type': 'application/json; charset=utf-8',
        }),
    };
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
      const finish = (operation: () => void, destroy: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroy) {
          incoming?.destroy();
          outgoing?.destroy();
        }
        operation();
      };
      const fail = (error: CollabError, destroy = true): void => {
        finish(() => reject(error), destroy);
      };
      const onCallerAbort = (): void => {
        fail(transportError('cancelled', 'cloud-authority-request-cancelled'));
      };
      const onRequestError = (): void => {
        fail(transportError(
          'endpoint-unreachable',
          'cloud-authority-request-failed',
        ), false);
      };

      try {
        outgoing = request(url, { headers, method: input.method }, response => {
          incoming = response;
          try {
            declaredResponseLength(response);
          } catch (error) {
            fail(error instanceof CollabError ? error : invalidResponse());
            return;
          }
          const chunks: Buffer[] = [];
          let byteLength = 0;
          let ended = false;
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
          response.once('aborted', () => {
            if (!ended) fail(invalidResponse());
          });
          response.once('error', () => fail(invalidResponse()));
          response.once('end', () => {
            if (settled) return;
            ended = true;
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8')) as unknown;
            } catch {
              fail(invalidResponse(), false);
              return;
            }
            finish(() => resolve({
              body: parsed,
              contentType: typeof response.headers['content-type'] === 'string'
                ? response.headers['content-type']
                : null,
              status: response.statusCode ?? 0,
            }), false);
          });
          response.once('close', () => {
            if (!ended && !settled) fail(invalidResponse());
          });
        });
      } catch {
        fail(transportError(
          'endpoint-unreachable',
          'cloud-authority-request-failed',
        ), false);
        return;
      }

      outgoing.once('error', onRequestError);
      input.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (input.signal?.aborted) {
        onCallerAbort();
        return;
      }
      timer = window.setTimeout(() => {
        fail(transportError('operation-timeout', 'cloud-authority-request-timeout'));
      }, this.#timeoutMs);
      outgoing.end(body);
    });
  };
}
