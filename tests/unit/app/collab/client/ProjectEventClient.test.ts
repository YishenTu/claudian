import {
  ProjectEventClient,
  type ProjectEventClientSocket,
  type ProjectEventClientSocketFactory,
} from '@/app/collab/client/ProjectEventClient';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { LAN_COLLAB_EVENT_KINDS } from '@/app/collab/lan/LanCollabEvent';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

describe('ProjectEventClient', () => {
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

  it('reconnects with bounded exponential delay and resets after opening', () => {
    const sockets = [new FakeClientSocket(), new FakeClientSocket(), new FakeClientSocket()];
    const createSocket = jest.fn(() => sockets.shift()!);
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const client = createClient(createSocket, jest.fn().mockResolvedValue(0), 0, {
      random: () => 0,
      setTimeout: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });

    client.start();
    createSocket.mock.results[0].value.emitClose(1006);
    expect(scheduled[0].delay).toBe(1_000);
    scheduled.shift()!.callback();
    createSocket.mock.results[1].value.emitClose(1006);
    expect(scheduled[0].delay).toBe(2_000);
    scheduled.shift()!.callback();
    createSocket.mock.results[2].value.emitOpen();
    createSocket.mock.results[2].value.emitClose(1006);
    expect(scheduled[0].delay).toBe(1_000);
    client.dispose();
  });

  it('does not reconnect revoked access and cancels reconnect on teardown', () => {
    const socket = new FakeClientSocket();
    const scheduled: Array<() => void> = [];
    const clearTimeout = jest.fn();
    const createSocket = jest.fn(() => socket);
    const client = createClient(createSocket, jest.fn().mockResolvedValue(0), 0, {
      clearTimeout,
      setTimeout: callback => {
        scheduled.push(callback);
        return 9;
      },
    });
    client.start();
    socket.emitClose(1008);
    expect(scheduled).toEqual([]);

    const retrying = createClient(createSocket, jest.fn().mockResolvedValue(0), 0, {
      clearTimeout,
      setTimeout: callback => {
        scheduled.push(callback);
        return 9;
      },
    });
    retrying.start();
    socket.emitClose(1006);
    retrying.dispose();
    expect(clearTimeout).toHaveBeenCalledWith(9);
  });

  it('delivers retirement once and permanently stops the event connection', async () => {
    const socket = new FakeClientSocket();
    const scheduled: Array<() => void> = [];
    const onInvalidation = jest.fn().mockResolvedValue(4);
    const client = createClient(() => socket, onInvalidation, 3, {
      setTimeout: callback => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });
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
    expect(scheduled).toEqual([]);
  });

  it('reconnects from the prior cursor when terminal retirement delivery rejects', async () => {
    const sockets = [new FakeClientSocket(), new FakeClientSocket()];
    const createSocket = jest.fn(() => sockets.shift()!);
    const scheduled: Array<() => void> = [];
    const onInvalidation = jest.fn().mockRejectedValue(new Error('lifecycle owner pending'));
    const client = createClient(createSocket, onInvalidation, 3, {
      random: () => 0,
      setTimeout: callback => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });
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
    scheduled.shift()?.();
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
  scheduler: ConstructorParameters<typeof ProjectEventClient>[3] = {},
) {
  return new ProjectEventClient({
    caCertificatePem: 'certificate',
    endpoint: 'https://192.168.1.20:54545',
    lastSequence,
    memberCredential: 'A'.repeat(43),
    projectId: 'project-a',
  }, onInvalidation, { createSocket }, scheduler);
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
  private errorListener: (() => void) | null = null;
  private messageListener: ((data: string) => void) | null = null;
  private openListener: (() => void) | null = null;

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

  onError(listener: () => void): void {
    this.errorListener = listener;
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }

  onOpen(listener: () => void): void {
    this.openListener = listener;
  }
}
