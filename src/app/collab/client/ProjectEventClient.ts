import { type CollabProjectId, isCollabOpaqueId } from '@claudian/collab-protocol';
import { type RawData,WebSocket } from 'ws';

import { COLLAB_CONTROL_ROUTE_PREFIX } from '@/app/collab/lan/LanCollabConstants';
import {
  decodeLanCollabEvent,
  type LanCollabEvent as CollabEvent,
} from '@/app/collab/lan/LanCollabEvent';

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type ProjectEventInvalidation =
  | {
    readonly kind: 'retired';
    readonly retiredAt: string;
    readonly sequence: number;
  }
  | { readonly kind: 'snapshot'; readonly sequence: number }
  | {
    readonly kind: 'request';
    readonly requestId: string;
    readonly sequence: number;
  };

export interface ProjectEventClientInput {
  readonly caCertificatePem: string;
  readonly endpoint: string;
  readonly lastSequence: number;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
}

export interface ProjectEventClientSocket {
  close(code: number, reason: string): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onOpen(listener: () => void): void;
}

export type ProjectEventClientSocketFactory = (
  input: ProjectEventClientInput,
) => ProjectEventClientSocket;

export interface ProjectEventClientOptions {
  readonly createSocket?: ProjectEventClientSocketFactory;
}

export interface ProjectEventClientScheduler {
  readonly clearTimeout?: (handle: number) => void;
  readonly random?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => number;
}

class NodeProjectEventClientSocket implements ProjectEventClientSocket {
  constructor(private readonly socket: WebSocket) {}

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  onClose(listener: (code: number) => void): void {
    this.socket.on('close', code => listener(code));
  }

  onError(listener: () => void): void {
    this.socket.on('error', listener);
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
  private readonly clearTimeout: (handle: number) => void;
  private readonly createSocket: ProjectEventClientSocketFactory;
  private disposed = false;
  private observedSequence: number;
  private readonly random: () => number;
  private reconnectAttempt = 0;
  private reconnectHandle: number | null = null;
  private readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  private socket: ProjectEventClientSocket | null = null;

  constructor(
    private readonly input: ProjectEventClientInput,
    private readonly onInvalidation: (
      invalidation: ProjectEventInvalidation,
    ) => Promise<number>,
    options: ProjectEventClientOptions = {},
    scheduler: ProjectEventClientScheduler = {},
  ) {
    this.acknowledgedSequence = input.lastSequence;
    this.observedSequence = input.lastSequence;
    this.clearTimeout = scheduler.clearTimeout ?? (handle => window.clearTimeout(handle));
    this.createSocket = options.createSocket ?? createDefaultSocket;
    this.random = scheduler.random ?? Math.random;
    this.setTimeout = scheduler.setTimeout
      ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
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
    socket.onOpen(() => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.requestSnapshot(this.acknowledgedSequence);
    });
    socket.onMessage(data => {
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.onError(() => {
      if (this.socket === socket) socket.close(1011, 'Event connection failed');
    });
    socket.onClose(code => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (code !== 1000 && code !== 1008) this.scheduleReconnect();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectHandle !== null) {
      this.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Client stopped');
  }

  private handleMessage(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      this.requestSnapshot(this.observedSequence);
      return;
    }
    const decoded = decodeLanCollabEvent(value);
    if (decoded.status === 'invalid') {
      this.requestSnapshot(this.observedSequence);
      return;
    }
    if (decoded.status === 'snapshot-required') {
      if (decoded.projectId !== this.input.projectId) {
        this.requestSnapshot(this.observedSequence);
        return;
      }
      this.observedSequence = Math.max(this.observedSequence, decoded.sequence);
      this.requestSnapshot(decoded.sequence);
      return;
    }
    const event = decoded.event;
    if (event.projectId !== this.input.projectId) {
      this.requestSnapshot(this.observedSequence);
      return;
    }
    if (event.sequence <= this.observedSequence) return;
    if (event.sequence !== this.observedSequence + 1) {
      this.observedSequence = event.sequence;
      this.requestSnapshot(event.sequence);
      return;
    }
    this.observedSequence = event.sequence;
    this.requestInvalidation(this.toInvalidation(event));
  }

  private toInvalidation(event: CollabEvent): ProjectEventInvalidation {
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

  private requestSnapshot(sequence: number): void {
    this.requestInvalidation({ kind: 'snapshot', sequence });
  }

  private requestInvalidation(invalidation: ProjectEventInvalidation): void {
    void this.onInvalidation(invalidation).then(sequence => {
      if (!Number.isSafeInteger(sequence) || sequence < invalidation.sequence) {
        throw new RangeError('Invalid authoritative event sequence');
      }
      this.acknowledgedSequence = Math.max(this.acknowledgedSequence, sequence);
      this.observedSequence = Math.max(this.observedSequence, sequence);
      if (invalidation.kind === 'retired') this.dispose();
    }).catch(() => {
      const socket = this.socket;
      if (socket) socket.close(1011, 'Event refresh failed');
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectHandle !== null) return;
    const base = Math.min(
      MIN_RECONNECT_DELAY_MS * (2 ** this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    const delay = Math.min(
      Math.round(base + base * 0.25 * this.random()),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectHandle = this.setTimeout(() => {
      this.reconnectHandle = null;
      this.start();
    }, delay);
  }
}
