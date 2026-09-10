import * as timers from 'node:timers';

import { type CollabProjectId, isCollabOpaqueId } from '@claudian-collab/protocol';
import { type RawData,WebSocket } from 'ws';

import { COLLAB_CONTROL_ROUTE_PREFIX } from '@/app/collab/lan/LanCollabConstants';
import {
  decodeLanCollabEvent,
  type LanCollabEvent as CollabEvent,
} from '@/app/collab/lan/LanCollabEvent';
import type {
  CollabAuthorityEventInvalidation,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import { isTlsValidationError } from '@/app/collab/tlsErrors';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type ProjectEventInvalidation = CollabAuthorityEventInvalidation;

export interface ProjectEventClientInput {
  readonly onConnectionResult?: (error?: CollabError) => void;
  readonly caCertificatePem: string;
  readonly endpoint: string;
  readonly lastSequence: number;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
}

export interface ProjectEventClientSocket {
  close(code: number, reason: string): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: (error?: unknown) => void): void;
  onMessage(listener: (data: string) => void): void;
  onOpen(listener: () => void): void;
}

export type ProjectEventClientSocketFactory = (
  input: ProjectEventClientInput,
) => ProjectEventClientSocket;

export interface ProjectEventClientOptions {
  readonly createSocket?: ProjectEventClientSocketFactory;
}

class NodeProjectEventClientSocket implements ProjectEventClientSocket {
  private heartbeat: ReturnType<typeof timers.setTimeout> | undefined;

  constructor(private readonly socket: WebSocket) {
    socket.on('open', () => this.#resetHeartbeat());
    socket.on('ping', () => this.#resetHeartbeat());
    socket.once('close', () => timers.clearTimeout(this.heartbeat));
  }

  #resetHeartbeat(): void {
    timers.clearTimeout(this.heartbeat);
    // The LAN Host sends a ping every 30 seconds; tolerate one missed ping.
    this.heartbeat = timers.setTimeout(() => this.socket.terminate(), 60_000);
    this.heartbeat.unref();
  }

  close(code: number, reason: string): void {
    timers.clearTimeout(this.heartbeat);
    this.socket.close(code, reason);
  }

  onClose(listener: (code: number) => void): void {
    this.socket.on('close', code => listener(code));
  }

  onError(listener: (error?: unknown) => void): void {
    this.socket.on('error', listener);
    this.socket.on('unexpected-response', (_request, response) => {
      listener(new CollabError({
        code: response.statusCode === 401 || response.statusCode === 403
          ? 'authorization-denied' : 'endpoint-unreachable',
      }));
      response.destroy();
    });
  }

  onMessage(listener: (data: string) => void): void {
    this.socket.on('message', (data: RawData) => listener(data.toString()));
  }

  onOpen(listener: () => void): void {
    this.socket.on('open', listener);
  }
}

function createDefaultSocket(input: ProjectEventClientInput): ProjectEventClientSocket {
  const endpoint = new URL(input.endpoint);
  endpoint.protocol = 'wss:';
  endpoint.pathname = `${COLLAB_CONTROL_ROUTE_PREFIX}/${input.projectId}/events`;
  const socket = new WebSocket(endpoint, {
    ca: input.caCertificatePem,
    handshakeTimeout: 10_000,
    headers: {
      authorization: `Bearer ${input.memberCredential}`,
      'x-collab-event-sequence': String(input.lastSequence),
    },
    perMessageDeflate: false,
    rejectUnauthorized: true,
  });
  return new NodeProjectEventClientSocket(socket);
}

export class ProjectEventClient {
  private acknowledgedSequence: number;
  private readonly createSocket: ProjectEventClientSocketFactory;
  private disposed = false;
  private observedSequence: number;
  private socket: ProjectEventClientSocket | null = null;

  constructor(
    private readonly input: ProjectEventClientInput,
    private readonly onInvalidation: (
      invalidation: ProjectEventInvalidation,
    ) => Promise<number>,
    options: ProjectEventClientOptions = {},
  ) {
    this.acknowledgedSequence = input.lastSequence;
    this.observedSequence = input.lastSequence;
    this.createSocket = options.createSocket ?? createDefaultSocket;
  }

  get lastSequence(): number {
    return this.acknowledgedSequence;
  }

  start(): void {
    if (this.disposed || this.socket) return;
    const socket = this.createSocket({
      ...this.input,
      lastSequence: this.acknowledgedSequence,
    });
    this.socket = socket;
    this.observedSequence = this.acknowledgedSequence;
    socket.onOpen(() => {
      if (this.socket !== socket) return;
      this.#requestSnapshot(this.acknowledgedSequence);
    });
    socket.onMessage(data => {
      if (this.socket === socket) this.#handleMessage(data);
    });
    socket.onError(error => {
      if (this.socket !== socket) return;
      this.#fail(error instanceof CollabError ? error : new CollabError({
        code: isTlsValidationError(error) ? 'tls-untrusted' : 'endpoint-unreachable',
      }), 'Event connection failed');
    });
    socket.onClose(code => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.input.onConnectionResult?.(new CollabError({
        code: code === 1008 ? 'authorization-denied' : 'endpoint-unreachable',
      }));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Client stopped');
  }

  #handleMessage(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      this.#requestSnapshot(this.observedSequence);
      return;
    }
    const decoded = decodeLanCollabEvent(value);
    if (decoded.status === 'invalid') {
      this.#requestSnapshot(this.observedSequence);
      return;
    }
    if (decoded.status === 'snapshot-required') {
      if (decoded.projectId !== this.input.projectId) {
        this.#requestSnapshot(this.observedSequence);
        return;
      }
      this.observedSequence = Math.max(this.observedSequence, decoded.sequence);
      this.#requestSnapshot(decoded.sequence);
      return;
    }
    const event = decoded.event;
    if (event.projectId !== this.input.projectId) {
      this.#requestSnapshot(this.observedSequence);
      return;
    }
    if (event.sequence <= this.observedSequence) return;
    if (event.sequence !== this.observedSequence + 1) {
      this.observedSequence = event.sequence;
      this.#requestSnapshot(event.sequence);
      return;
    }
    this.observedSequence = event.sequence;
    this.#requestInvalidation(this.#toInvalidation(event));
  }

  #toInvalidation(event: CollabEvent): ProjectEventInvalidation {
    if (event.kind === 'project-retired' && typeof event.payload.retiredAt === 'string') {
      return {
        kind: 'retired',
        retiredAt: event.payload.retiredAt,
        sequence: event.sequence,
      };
    }
    const requestId = event.payload.requestId;
    if (
      (event.kind === 'request-updated' || event.kind === 'comment-added')
      && isCollabOpaqueId(requestId)
    ) {
      return { kind: 'request', requestId, sequence: event.sequence };
    }
    return { kind: 'snapshot', sequence: event.sequence };
  }

  #requestSnapshot(sequence: number): void {
    this.#requestInvalidation({ kind: 'snapshot', sequence });
  }

  #requestInvalidation(invalidation: ProjectEventInvalidation): void {
    const socket = this.socket;
    if (!socket || this.disposed) return;
    void Promise.resolve().then(() => {
      if (this.disposed || this.socket !== socket) throw new CollabError({ code: 'cancelled' });
      return this.onInvalidation(invalidation);
    }).then(sequence => {
      if (this.disposed || this.socket !== socket) return;
      if (!Number.isSafeInteger(sequence) || sequence < invalidation.sequence) {
        throw new CollabError({ code: 'authority-integrity-error' });
      }
      this.acknowledgedSequence = Math.max(this.acknowledgedSequence, sequence);
      this.observedSequence = Math.max(this.observedSequence, sequence);
      if (invalidation.kind === 'retired') this.dispose();
      else this.input.onConnectionResult?.();
    }).catch(error => {
      if (this.socket !== socket) return;
      this.#fail(error instanceof CollabError ? error : new CollabError({
        code: 'operation-failed',
      }), 'Event refresh failed');
    });
  }

  #fail(error: CollabError, reason: string): void {
    const socket = this.socket;
    if (!socket || this.disposed) return;
    this.socket = null;
    socket.close(1011, reason);
    this.input.onConnectionResult?.(error);
  }
}
