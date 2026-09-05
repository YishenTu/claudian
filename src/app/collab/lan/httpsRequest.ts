import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

type HttpsRequestFailure =
  | 'cancelled'
  | 'connection-failed'
  | 'response-failed'
  | 'response-too-large'
  | 'timeout'
  | 'tls-untrusted';

export class HttpsRequestError extends Error {
  constructor(readonly reason: HttpsRequestFailure) {
    super(reason);
  }
}

interface HttpsResponseBytes {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
  readonly statusCode: number;
}

export function isTlsValidationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  return code.includes('CERT')
    || code.includes('TLS')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

/** Owns one verified HTTPS request; callers own authentication and wire policy. */
export async function requestHttpsBytes(
  requestOptions: Pick<RequestOptions, 'ca' | 'headers' | 'hostname' | 'method' | 'path' | 'port'>,
  options: {
    readonly body: Buffer | null;
    readonly maxResponseBytes: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<HttpsResponseBytes> {
  if (options.signal?.aborted) throw new HttpsRequestError('cancelled');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const fail = (reason: HttpsRequestFailure) => finish(() => {
      outgoing.destroy();
      reject(new HttpsRequestError(reason));
    });
    const outgoing = httpsRequest({
      ...requestOptions,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    }, incoming => {
      const chunks: Buffer[] = [];
      let observed = 0;
      incoming.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        observed += bytes.byteLength;
        if (observed > options.maxResponseBytes) {
          fail('response-too-large');
          return;
        }
        chunks.push(bytes);
      });
      incoming.once('error', () => fail('response-failed'));
      incoming.once('end', () => finish(() => resolve({
        body: Buffer.concat(chunks),
        headers: incoming.headers,
        statusCode: incoming.statusCode ?? 0,
      })));
    });
    const onAbort = () => fail('cancelled');
    const timer = window.setTimeout(() => fail('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.once('error', error => fail(
      isTlsValidationError(error) ? 'tls-untrusted' : 'connection-failed',
    ));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    outgoing.end(options.body ?? undefined);
  });
}
