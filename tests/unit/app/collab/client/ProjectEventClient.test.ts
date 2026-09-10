import {
  ProjectEventClient,
  type ProjectEventClientSocket,
  type ProjectEventClientSocketFactory,
} from '@/app/collab/client/ProjectEventClient';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { LAN_COLLAB_EVENT_KINDS } from '@/app/collab/lan/LanCollabEvent';
import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

describe('ProjectEventClient', () => {
  it('preserves native TLS validation failure as terminal connection evidence', () => {
    const socket = new FakeClientSocket();
    const result = jest.fn();
    const client = new ProjectEventClient({
      caCertificatePem: 'certificate', endpoint: 'https://host.test', lastSequence: 0, memberCredential: 'credential', projectId: 'project-a',
      onConnectionResult: result,
    }, () => Promise.resolve(0), { createSocket: () => socket });
    client.start();
    socket.emitError(Object.assign(new Error('private-certificate-details'), { code: 'CERT_HAS_EXPIRED' }));
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ code: 'tls-untrusted' }));
    expect(JSON.stringify(result.mock.calls)).not.toContain('private-certificate-details');
    client.dispose();
  });

  it('publishes connection success only after the authoritative snapshot is applied', async () => {
    const socket = new FakeClientSocket();
    let apply!: (value: number) => void;
    const applied = new Promise<number>(resolve => { apply = resolve; });
    const result = jest.fn();
    const client = new ProjectEventClient({
      caCertificatePem: 'certificate', endpoint: 'https://host.test', lastSequence: 0, memberCredential: 'credential', projectId: 'project-a',
      onConnectionResult: result,
    }, () => applied, { createSocket: () => socket });
    client.start();
    socket.emitOpen();
    expect(result).not.toHaveBeenCalled();
    apply(1);
    await flushTasks();
    expect(result).toHaveBeenCalledWith();
    client.dispose();
  });

  it.each(['authorization-denied', 'authority-integrity-error', 'operation-failed'] as const)(
    'retains %s from snapshot application rather than replacing it with a socket error',
    async code => {
      const socket = new FakeClientSocket();
      const failure = new CollabError({ code });
      const result = jest.fn();
      const client = new ProjectEventClient({
        caCertificatePem: 'certificate', endpoint: 'https://host.test', lastSequence: 0, memberCredential: 'credential', projectId: 'project-a',
        onConnectionResult: result,
      }, () => Promise.reject(failure), { createSocket: () => socket });
      client.start();
      socket.emitOpen();
      await flushTasks();
      expect(result).toHaveBeenCalledWith(failure);
      client.dispose();
    },
  );

  it('reports idle disconnects to the Project connection owner and suppresses teardown signals', async () => {
    jest.useFakeTimers();
    const socket = new FakeClientSocket();
    const connection = new CollabProjectConnection({
      reconnect: async () => 'connected', onStatusChange: jest.fn(),
    });
    const client = new ProjectEventClient({
      caCertificatePem: 'certificate', endpoint: 'https://host.test',
      lastSequence: 0, memberCredential: 'credential', projectId: 'project-a',
      onConnectionResult: (error?: CollabError) => error
        ? connection.observeFailure(error) : connection.observeSuccess(),
    }, async () => 0, { createSocket: () => socket });
    try {
      client.start();
      socket.emitOpen();
      await jest.advanceTimersByTimeAsync(0);
      expect(connection.status).toBe('connected');
      socket.emitClose(1000);
      expect(connection.status).toBe('offline');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(connection.status).toBe('connected');
      client.dispose();
      socket.emitClose(1006);
      expect(connection.status).toBe('connected');
    } finally {
      client.dispose();
      await connection.close();
      jest.useRealTimers();
    }
  });

  it('keeps LAN event decoder authority immutable', () => {
    expect(Object.isFrozen(LAN_COLLAB_EVENT_KINDS)).toBe(true);
    expect(() => (LAN_COLLAB_EVENT_KINDS as unknown as string[]).push('future-kind'))
      .toThrow();
  });

  it('refreshes the authoritative snapshot whenever a connection opens', async () => {
    const socket = new FakeClientSocket();
    const onInvalidation = jest.fn().mockResolvedValue(3);
    const client = createClient(() => socket, onInvalidation, 3);

    client.start();
    socket.emitOpen();
    await flushTasks();

    expect(onInvalidation).toHaveBeenCalledWith({ kind: 'snapshot', sequence: 3 });
    client.dispose();
  });

  it('authenticates from headers, resumes at the acknowledged cursor, and decodes invalidations', async () => {
    const socket = new FakeClientSocket();
    const createSocket = jest.fn(() => socket);
    const onInvalidation = jest.fn().mockResolvedValue(4);
    const client = createClient(createSocket, onInvalidation, 3);

    client.start();
    expect(createSocket).toHaveBeenCalledWith(expect.objectContaining({
      lastSequence: 3,
      memberCredential: 'A'.repeat(43),
      projectId: 'project-a',
    }));
    socket.emitOpen();
    socket.emitMessage(JSON.stringify(event(4, 'request-updated', {
      requestId: 'request-a',
    })));
    await flushTasks();

    expect(onInvalidation).toHaveBeenCalledWith({
      kind: 'request',
      requestId: 'request-a',
      sequence: 4,
    });
    expect(client.lastSequence).toBe(4);
    client.dispose();
  });

  it('recovers gaps and unknown event kinds through snapshot invalidation', async () => {
    const socket = new FakeClientSocket();
    const onInvalidation = jest.fn().mockResolvedValue(8);
    const client = createClient(() => socket, onInvalidation, 2);
    client.start();
    socket.emitOpen();

    socket.emitMessage(JSON.stringify(event(4, 'request-updated', {})));
    socket.emitMessage(JSON.stringify(event(8, 'future-kind', { private: 'secret' })));
    await flushTasks();

    expect(onInvalidation).toHaveBeenCalledWith({ kind: 'snapshot', sequence: 4 });
    expect(onInvalidation).toHaveBeenCalledWith({ kind: 'snapshot', sequence: 8 });
    expect(client.lastSequence).toBe(8);
    client.dispose();
  });



  it('delivers retirement once and permanently stops the event connection', async () => {
    const socket = new FakeClientSocket();
    const onInvalidation = jest.fn().mockResolvedValue(4);
    const client = createClient(() => socket, onInvalidation, 3);
    client.start();

    socket.emitMessage(JSON.stringify(event(4, 'project-retired', {
      retiredAt: CREATED_AT,
    })));
    await flushTasks();
    socket.emitClose(1006);

    expect(onInvalidation).toHaveBeenCalledWith({
      kind: 'retired',
      retiredAt: CREATED_AT,
      sequence: 4,
    });
    expect(socket.close).toHaveBeenCalledWith(1000, 'Client stopped');
  });

  it('reconnects from the prior cursor when terminal retirement delivery rejects', async () => {
    const sockets = [new FakeClientSocket(), new FakeClientSocket()];
    const createSocket = jest.fn(() => sockets.shift()!);
    const onInvalidation = jest.fn().mockRejectedValue(new Error('lifecycle owner pending'));
    const client = createClient(createSocket, onInvalidation, 3);
    client.start();

    createSocket.mock.results[0].value.emitMessage(JSON.stringify(event(
      4,
      'project-retired',
      { retiredAt: CREATED_AT },
    )));
    await flushTasks();
    expect(createSocket.mock.results[0].value.close)
      .toHaveBeenCalledWith(1011, 'Event refresh failed');
    expect(client.lastSequence).toBe(3);

    createSocket.mock.results[0].value.emitClose(1011);
    client.start();
    expect(createSocket).toHaveBeenLastCalledWith(expect.objectContaining({
      lastSequence: 3,
    }));
    client.dispose();
  });
});

function createClient(
  createSocket: ProjectEventClientSocketFactory,
  onInvalidation: ConstructorParameters<typeof ProjectEventClient>[1],
  lastSequence: number,
) {
  return new ProjectEventClient({
    caCertificatePem: 'certificate',
    endpoint: 'https://192.168.1.20:54545',
    lastSequence,
    memberCredential: 'A'.repeat(43),
    projectId: 'project-a',
  }, onInvalidation, { createSocket });
}

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    kind,
    occurredAt: CREATED_AT,
    payload,
    projectId: 'project-a',
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    sequence,
  };
}

function flushTasks(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

class FakeClientSocket implements ProjectEventClientSocket {
  close = jest.fn();
  private closeListener: ((code: number) => void) | null = null;
  private errorListener: ((error?: unknown) => void) | null = null;
  private messageListener: ((data: string) => void) | null = null;
  private openListener: (() => void) | null = null;

  emitError(error: unknown): void { this.errorListener?.(error); }

  emitClose(code: number): void {
    this.closeListener?.(code);
  }

  emitMessage(data: string): void {
    this.messageListener?.(data);
  }

  emitOpen(): void {
    this.openListener?.();
  }

  onClose(listener: (code: number) => void): void {
    this.closeListener = listener;
  }

  onError(listener: (error?: unknown) => void): void {
    this.errorListener = listener;
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }

  onOpen(listener: () => void): void {
    this.openListener = listener;
  }
}
