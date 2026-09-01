import {
  type ClientRequest,
  type IncomingMessage,
  request as requestHttp,
} from 'node:http';
import { request as requestHttps } from 'node:https';

import type { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudAuthorityBufferedRequest {
  readonly body?: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly maximumBytes: number;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly url: string;
}

export interface CloudAuthorityBufferedResponse {
  readonly body: Buffer;
  readonly contentType: string | null;
  readonly status: number;
}

export interface CloudAuthorityBufferedFailures {
  cancelled(): CollabError;
  invalidResponse(): CollabError;
  responseTooLarge(): CollabError;
  timedOut(): CollabError;
  unreachable(): CollabError;
}

export function requestCloudAuthorityBytes(
  input: CloudAuthorityBufferedRequest,
  failures: CloudAuthorityBufferedFailures,
): Promise<CloudAuthorityBufferedResponse> {
  if (input.signal?.aborted) return Promise.reject(failures.cancelled());
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(failures.unreachable());
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(failures.unreachable());
  }
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    let incoming: IncomingMessage | null = null;
    let outgoing: ClientRequest | null = null;
    let settled = false;
    let timer: number | null = null;
    const cleanup = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
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
    const onAbort = (): void => fail(failures.cancelled());
    try {
      outgoing = request(url, {
        headers: input.headers,
        method: input.method,
      }, response => {
        incoming = response;
        const declared = response.headers['content-length'];
        if (
          declared !== undefined
          && (
            typeof declared !== 'string'
            || !/^(?:0|[1-9][0-9]*)$/u.test(declared)
            || Number(declared) > input.maximumBytes
          )
        ) {
          fail(failures.responseTooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          byteLength += bytes.byteLength;
          if (byteLength > input.maximumBytes) {
            fail(failures.responseTooLarge());
            return;
          }
          chunks.push(bytes);
        });
        response.once('aborted', () => fail(failures.invalidResponse()));
        response.once('error', () => fail(failures.invalidResponse()));
        response.once('end', () => {
          if (settled) return;
          const contentType = response.headers['content-type'];
          if (finish(false)) {
            resolve({
              body: Buffer.concat(chunks, byteLength),
              contentType: typeof contentType === 'string' ? contentType : null,
              status: response.statusCode ?? 0,
            });
          }
        });
        response.once('close', () => {
          if (!settled) fail(failures.invalidResponse());
        });
      });
    } catch {
      fail(failures.unreachable(), false);
      return;
    }
    outgoing.once('error', () => fail(failures.unreachable(), false));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    timer = window.setTimeout(() => fail(failures.timedOut()), input.timeoutMs);
    outgoing.end(input.body);
  });
}
