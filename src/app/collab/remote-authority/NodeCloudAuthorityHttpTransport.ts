import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import {
  cloudAuthorityError,
  cloudAuthorityOperationError,
  cloudAuthorityProtocolError,
} from '@/app/collab/remote-authority/CloudAuthorityError';
import { requestCloudAuthorityBytes } from '@/app/collab/remote-authority/NodeCloudAuthorityBufferedTransport';
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
    const encodedBody = encodedRequestBody(input);
    if (encodedBody === null) return Promise.reject(invalidRequestBody());
    const body = encodedBody;
    const headers: Record<string, string> = { ...input.headers };
    if (body !== undefined) {
      headers['content-length'] = String(body.byteLength);
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    return requestCloudAuthorityBytes({
      ...(body === undefined ? {} : { body }),
      headers,
      maximumBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      method: input.method,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: this.#timeoutMs,
      url: input.url,
    }, {
      cancelled: cancelledRequest,
      invalidResponse,
      responseTooLarge,
      timedOut: () => cloudAuthorityError(
        'operation-timeout',
        'cloud-authority-request-timeout',
      ),
      unreachable: unreachableAuthority,
    }).then(response => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body.toString('utf8')) as unknown;
      } catch {
        throw invalidResponse();
      }
      return {
        body: parsed,
        contentType: response.contentType,
        status: response.status,
      };
    });
  };
}
