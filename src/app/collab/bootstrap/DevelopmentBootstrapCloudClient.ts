import { randomUUID } from 'node:crypto';
import { type ClientRequest, request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';

import {
  COLLAB_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  collabDevelopmentBootstrapRoute,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  type DevelopmentBootstrapAttemptStatus,
  developmentBootstrapOperationCodec,
} from '@claudian/collab-protocol';

import type {
  DevelopmentBootstrapCloudPort,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import { canonicalCloudOrigin } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const BODY_CLEANUP_TIMEOUT_MS = 1_000;

export interface DevelopmentBootstrapCloudClientOptions {
  readonly developmentActorId: string;
  readonly requestIdFactory?: () => string;
  readonly serverUrl: string;
}

interface CloudResponse {
  readonly body: unknown;
  readonly statusCode: number;
}

function clientError(
  code:
    | 'endpoint-unreachable'
    | 'cancelled'
    | 'operation-failed'
    | 'operation-timeout'
    | 'protocol-payload-invalid',
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

function requestId(): string {
  return `cloud-bootstrap-${randomUUID().replaceAll('-', '')}`;
}

function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) {
    if (signal.reason === 'response') {
      return Promise.resolve({ done: true, value: undefined });
    }
    return Promise.reject(signal.reason === 'timeout'
      ? clientError('operation-timeout', 'cloud-bootstrap-request-timeout')
      : clientError('cancelled', 'cloud-bootstrap-request-cancelled'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => {
      if (signal.reason === 'response') {
        resolve({ done: true, value: undefined });
        return;
      }
      reject(signal.reason === 'timeout'
        ? clientError('operation-timeout', 'cloud-bootstrap-request-timeout')
        : clientError('cancelled', 'cloud-bootstrap-request-cancelled'));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      value => finish(() => resolve(value)),
      () => finish(() => reject(clientError(
        'operation-failed',
        'cloud-bootstrap-request-body-failed',
      ))),
    );
    if (signal.aborted) onAbort();
  });
}

function waitForDrain(outgoing: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      outgoing.off('drain', onDrain);
      outgoing.off('error', onError);
      operation();
    };
    const onDrain = (): void => finish(resolve);
    const onError = (error: Error): void => finish(() => reject(error));
    outgoing.once('drain', onDrain);
    outgoing.once('error', onError);
  });
}

export class DevelopmentBootstrapCloudClient implements DevelopmentBootstrapCloudPort {
  readonly #actorId: string;
  readonly #newRequestId: () => string;
  readonly #origin: string;

  constructor(options: DevelopmentBootstrapCloudClientOptions) {
    this.#origin = canonicalCloudOrigin(options.serverUrl, 'serverUrl');
    this.#actorId = options.developmentActorId;
    this.#newRequestId = options.requestIdFactory ?? requestId;
  }

  activate: DevelopmentBootstrapCloudPort['activate'] = (request, signal) => (
    this.#json('activateDevelopmentBootstrap', request.attemptId, request, signal)
  );

  begin: DevelopmentBootstrapCloudPort['begin'] = (request, signal) => (
    this.#json('beginDevelopmentBootstrap', undefined, request, signal)
  );

  cancel: DevelopmentBootstrapCloudPort['cancel'] = (request, signal) => (
    this.#json('cancelDevelopmentBootstrap', request.attemptId, request, signal)
  );

  get: DevelopmentBootstrapCloudPort['get'] = async (request, signal) => {
    const route = collabDevelopmentBootstrapRoute(
      'getDevelopmentBootstrap',
      request.attemptId,
    );
    const response = await this.#request(
      route.method,
      route.target,
      {},
      undefined,
      JSON_TIMEOUT_MS,
      signal,
    );
    if (response.statusCode === 404) return null;
    return this.#decodeResponse('getDevelopmentBootstrap', response);
  };

  report: DevelopmentBootstrapCloudPort['report'] = (request, signal) => (
    this.#json('submitDevelopmentBootstrapReport', request.attemptId, request, signal)
  );

  upload: DevelopmentBootstrapCloudPort['upload'] = async (request, body, signal) => {
    const decoded = developmentBootstrapOperationCodec('putDevelopmentBootstrapGitBundle')
      .decodeRequest(request);
    if (decoded.status !== 'ok') throw decoded.error;
    const route = collabDevelopmentBootstrapRoute(
      'putDevelopmentBootstrapGitBundle',
      request.attemptId,
    );
    const response = await this.#request(route.method, route.target, {
      'content-encoding': request.contentEncoding,
      'content-length': String(request.byteCount),
      'content-type': request.contentType,
    }, body, UPLOAD_TIMEOUT_MS, signal);
    return this.#decodeResponse('putDevelopmentBootstrapGitBundle', response);
  };

  async #json(
    operation:
      | 'activateDevelopmentBootstrap'
      | 'beginDevelopmentBootstrap'
      | 'cancelDevelopmentBootstrap'
      | 'submitDevelopmentBootstrapReport',
    attemptId: string | undefined,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus> {
    const decoded = developmentBootstrapOperationCodec(operation).decodeRequest(request);
    if (decoded.status !== 'ok') throw decoded.error;
    const route = operation === 'beginDevelopmentBootstrap'
      ? collabDevelopmentBootstrapRoute(operation)
      : collabDevelopmentBootstrapRoute(operation, attemptId!);
    const encoded = Buffer.from(JSON.stringify({
      data: decoded.value,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      requestId: this.#newRequestId(),
    }), 'utf8');
    const response = await this.#request(route.method, route.target, {
      'content-length': String(encoded.byteLength),
      'content-type': 'application/json; charset=utf-8',
    }, _signal => (async function* () {
      yield encoded;
    })(), JSON_TIMEOUT_MS, signal);
    return this.#decodeResponse(operation, response);
  }

  async #request(
    method: 'GET' | 'POST' | 'PUT',
    target: string,
    headers: Readonly<Record<string, string>>,
    body: ((signal: AbortSignal) => AsyncIterable<Uint8Array>) | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CloudResponse> {
    if (signal?.aborted) {
      throw clientError('cancelled', 'cloud-bootstrap-request-cancelled');
    }
    const url = new URL(target, this.#origin);
    const requestFn = url.protocol === 'https:' ? requestHttps : requestHttp;
    return new Promise<CloudResponse>((resolve, reject) => {
      let settled = false;
      let settlementPlanned = false;
      let bodySettled = Promise.resolve();
      const controller = new AbortController();
      const bodyController = new AbortController();
      let bodyCleanupTimer: number | null = null;
      let deadlineTimer: number | null = null;
      const cleanup = (): void => {
        if (bodyCleanupTimer !== null) window.clearTimeout(bodyCleanupTimer);
        if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', onCallerAbort);
        controller.signal.removeEventListener('abort', onRequestAbort);
      };
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const settleAfterBody = (
        operation: () => void,
        bodyFailure: (error: unknown) => void = operation,
      ): void => {
        if (settled || settlementPlanned) return;
        settlementPlanned = true;
        void bodySettled.then(
          () => finish(operation),
          error => finish(() => bodyFailure(error)),
        );
      };
      const boundBodyCleanup = (error: CollabError): void => {
        if (bodyCleanupTimer !== null || settled) return;
        bodyCleanupTimer = window.setTimeout(() => {
          outgoing.destroy(error);
          finish(() => reject(error));
        }, BODY_CLEANUP_TIMEOUT_MS);
      };
      const fail = (error: CollabError): void => {
        if (!bodyController.signal.aborted) {
          bodyController.abort(error.code === 'operation-timeout' ? 'timeout' : 'request-error');
        }
        boundBodyCleanup(error);
        settleAfterBody(() => reject(error));
      };
      const outgoing = requestFn(url, {
        headers: {
          ...headers,
          'x-claudian-development-actor': this.#actorId,
        },
        method,
      }, incoming => {
        const chunks: Buffer[] = [];
        let byteCount = 0;
        incoming.on('data', (chunk: Buffer) => {
          byteCount += chunk.byteLength;
          if (byteCount > COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) {
            incoming.destroy(clientError(
              'protocol-payload-invalid',
              'cloud-bootstrap-response-too-large',
            ));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.once('error', () => fail(clientError(
          'protocol-payload-invalid',
          'cloud-bootstrap-response-invalid',
        )));
        incoming.once('end', () => {
          if (settled) return;
          const contentType = incoming.headers['content-type'];
          if (
            typeof contentType !== 'string'
            || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)
          ) {
            fail(clientError('protocol-payload-invalid', 'cloud-bootstrap-content-type-invalid'));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            fail(clientError('protocol-payload-invalid', 'cloud-bootstrap-response-invalid'));
            return;
          }
          bodyController.abort('response');
          boundBodyCleanup(clientError(
            'operation-timeout',
            'cloud-bootstrap-request-body-cleanup-timeout',
          ));
          settleAfterBody(
            () => resolve({
              body: parsed,
              statusCode: incoming.statusCode ?? 0,
            }),
            error => reject(error instanceof CollabError
              ? error
              : clientError('operation-failed', 'cloud-bootstrap-request-body-failed')),
          );
        });
      });
      const onCallerAbort = (): void => controller.abort('cancelled');
      const onRequestAbort = (): void => {
        const error = controller.signal.reason === 'timeout'
          ? clientError('operation-timeout', 'cloud-bootstrap-request-timeout')
          : clientError('cancelled', 'cloud-bootstrap-request-cancelled');
        bodyController.abort(controller.signal.reason);
        outgoing.destroy(error);
        fail(error);
      };
      signal?.addEventListener('abort', onCallerAbort, { once: true });
      controller.signal.addEventListener('abort', onRequestAbort, { once: true });
      if (signal?.aborted) onCallerAbort();
      outgoing.once('error', error => {
        if (error instanceof CollabError) {
          fail(error);
          return;
        }
        fail(clientError('endpoint-unreachable', 'cloud-bootstrap-request-failed'));
      });
      deadlineTimer = window.setTimeout(() => {
        controller.abort('timeout');
      }, timeoutMs);
      bodySettled = (async () => {
        const iterator = body?.(bodyController.signal)[Symbol.asyncIterator]();
        try {
          if (iterator) {
            for (;;) {
              const next = await nextBodyChunk(iterator, bodyController.signal);
              if (next.done) break;
              const chunk = next.value;
              if (!outgoing.write(chunk)) {
                await waitForDrain(outgoing);
              }
            }
          }
          if (bodyController.signal.reason !== 'response') outgoing.end();
        } catch (error: unknown) {
          const requestError = error instanceof CollabError
            ? error
            : clientError('operation-failed', 'cloud-bootstrap-request-body-failed');
          outgoing.destroy(requestError);
          throw requestError;
        } finally {
          if (bodyController.signal.aborted && iterator?.return) {
            await iterator.return();
          }
          if (bodyController.signal.reason === 'response') outgoing.destroy();
        }
      })();
      void bodySettled.catch(error => {
        if (error instanceof CollabError) fail(error);
        else fail(clientError('operation-failed', 'cloud-bootstrap-request-body-failed'));
      });
    });
  }

  #decodeResponse(
    operation:
      | 'activateDevelopmentBootstrap'
      | 'beginDevelopmentBootstrap'
      | 'cancelDevelopmentBootstrap'
      | 'getDevelopmentBootstrap'
      | 'putDevelopmentBootstrapGitBundle'
      | 'submitDevelopmentBootstrapReport',
    response: CloudResponse,
  ): DevelopmentBootstrapAttemptStatus {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      try {
        const envelope = decodeCollabCloudErrorEnvelope(response.body);
        throw new CollabError(envelope.error);
      } catch (error) {
        if (error instanceof CollabError) throw error;
        throw clientError('protocol-payload-invalid', 'cloud-bootstrap-error-response-invalid');
      }
    }
    const envelope = decodeCollabCloudSuccessEnvelope(response.body);
    return developmentBootstrapOperationCodec(operation).decodeResponse(envelope.data);
  }
}
