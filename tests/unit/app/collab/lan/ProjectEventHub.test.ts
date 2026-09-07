import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  ProjectEventHub,
  type ProjectEventReadResult,
  type ProjectEventSocket,
  type ProjectEventSource,
} from '@/app/collab/lan/ProjectEventHub';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

describe('ProjectEventHub', () => {
  it('replays sequential redacted invalidations and maps authority event kinds', async () => {
    const source = new FakeEventSource({
      active: true,
      events: [
        event(1, 'request.updated', { headOid: 'secret-oid', requestId: 'request-a' }),
        event(2, 'comment.created', { body: 'secret body', requestId: 'request-a' }),
        event(3, 'membership.manager-promoted', { memberId: 'member-b' }),
      ],
      latestSequence: 3,
    });
    const hub = new ProjectEventHub('project-a', source);
    const socket = new FakeSocket();

    await hub.connect(socket, 'member-a', 0);

    expect(socket.messages.map(parseMessage)).toEqual([
      expect.objectContaining({
        kind: 'request-updated',
        payload: { requestId: 'request-a' },
        sequence: 1,
      }),
      expect.objectContaining({
        kind: 'comment-added',
        payload: { requestId: 'request-a' },
        sequence: 2,
      }),
      expect.objectContaining({
        kind: 'membership-updated',
        payload: { memberId: 'member-b' },
        sequence: 3,
      }),
    ]);
    expect(JSON.stringify(socket.messages)).not.toContain('secret');
    hub.close();
  });

  it.each([
    {
      result: {
        active: true,
        events: [event(4, 'request.updated', { requestId: 'request-a' })],
        latestSequence: 4,
      },
      sequence: 2,
    },
    {
      result: {
        active: true,
        events: [event(1, 'future.event', { privateValue: 'secret' })],
        latestSequence: 1,
      },
      sequence: 0,
    },
    {
      result: { active: true, events: [], latestSequence: 3 },
      sequence: 9,
    },
  ])('falls back to an authoritative snapshot for gaps, unknown events, or invalid cursors %#', async ({
    result,
    sequence,
  }) => {
    const source = new FakeEventSource(result);
    const hub = new ProjectEventHub('project-a', source);
    const socket = new FakeSocket();

    await hub.connect(socket, 'member-a', sequence);

    expect(socket.messages.map(parseMessage)).toEqual([
      expect.objectContaining({
        kind: 'snapshot-required',
        payload: {},
        sequence: result.latestSequence,
      }),
    ]);
    hub.close();
  });

  it('coalesces mutation notifications and closes a revoked Member connection', async () => {
    const source = new FakeEventSource({ active: true, events: [], latestSequence: 0 });
    const hub = new ProjectEventHub('project-a', source);
    const socket = new FakeSocket();
    await hub.connect(socket, 'member-a', 0);
    source.result = { active: false, events: [], latestSequence: 1 };

    source.notify();
    source.notify();
    source.notify();
    await flushTasks();

    expect(source.read).toHaveBeenCalledTimes(2);
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Access removed' }]);
    hub.close();
  });

  it('closes after two missed heartbeat responses and resets on pong', async () => {
    const source = new FakeEventSource({ active: true, events: [], latestSequence: 0 });
    let heartbeat: (() => void) | null = null;
    const clearInterval = jest.fn();
    const hub = new ProjectEventHub('project-a', source, {
      clearInterval,
      setInterval: callback => {
        heartbeat = callback;
        return 7;
      },
    });
    const socket = new FakeSocket();
    await hub.connect(socket, 'member-a', 0);

    heartbeat!();
    socket.emit('pong');
    heartbeat!();
    heartbeat!();
    expect(socket.closeCalls).toEqual([]);
    heartbeat!();
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'Heartbeat timeout' }]);

    hub.close();
    expect(clearInterval).toHaveBeenCalledWith(7);
  });

  it('disposes its source subscription and closes every socket on teardown', async () => {
    const source = new FakeEventSource({ active: true, events: [], latestSequence: 0 });
    const hub = new ProjectEventHub('project-a', source);
    const first = new FakeSocket();
    const second = new FakeSocket();
    await hub.connect(first, 'member-a', 0);
    await hub.connect(second, 'member-b', 0);

    hub.close();

    expect(source.disposed).toBe(true);
    expect(first.closeCalls).toEqual([{ code: 1001, reason: 'Host stopped' }]);
    expect(second.closeCalls).toEqual([{ code: 1001, reason: 'Host stopped' }]);
  });

  it('reports only a currently authenticated open event connection as presence', async () => {
    const source = new FakeEventSource({ active: true, events: [], latestSequence: 0 });
    const hub = new ProjectEventHub('project-a', source);
    const socket = new FakeSocket();

    expect(hub.hasAuthenticatedPresence('project-a', 'member-a')).toBe(false);
    await hub.connect(socket, 'member-a', 0);
    expect(hub.hasAuthenticatedPresence('project-a', 'member-a')).toBe(true);
    expect(hub.hasAuthenticatedPresence('project-b', 'member-a')).toBe(false);
    expect(hub.hasAuthenticatedPresence('project-a', 'member-b')).toBe(false);

    socket.close(1000, 'Closed');
    expect(hub.hasAuthenticatedPresence('project-a', 'member-a')).toBe(false);
    hub.close();
  });

  it('broadcasts one redacted terminal retirement event to connected Members', async () => {
    const source = new FakeEventSource({ active: true, events: [], latestSequence: 0 });
    const hub = new ProjectEventHub('project-a', source);
    const socket = new FakeSocket();
    await hub.connect(socket, 'member-a', 0);

    await hub.publishRetirement({
      projectId: 'project-a',
      retiredAt: '2026-08-13T00:00:00.000Z',
    });

    expect(socket.messages.map(parseMessage)).toEqual([
      {
        kind: 'project-retired',
        occurredAt: '2026-08-13T00:00:00.000Z',
        payload: { retiredAt: '2026-08-13T00:00:00.000Z' },
        projectId: 'project-a',
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        sequence: 1,
      },
    ]);
    hub.close();
  });
});

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    actorMemberId: 'member-a',
    createdAt: CREATED_AT,
    kind,
    payload,
    sequence,
  };
}

function parseMessage(message: string): unknown {
  return JSON.parse(message) as unknown;
}

function flushTasks(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

class FakeEventSource implements ProjectEventSource {
  disposed = false;
  private listener: (() => void) | null = null;
  read = jest.fn(async () => this.result);

  constructor(public result: ProjectEventReadResult) {}

  notify(): void {
    this.listener?.();
  }

  subscribe(listener: () => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.disposed = true;
        this.listener = null;
      },
    };
  }
}

class FakeSocket implements ProjectEventSocket {
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  readonly messages: string[] = [];
  readonly pings: number[] = [];
  readyState = 1;
  private readonly listeners = new Map<string, Set<() => void>>();

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }

  emit(eventName: string): void {
    for (const listener of this.listeners.get(eventName) ?? []) listener();
  }

  on(eventName: 'close' | 'error' | 'pong', listener: () => void): this {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return this;
  }

  ping(): void {
    this.pings.push(Date.now());
  }

  send(data: string): void {
    this.messages.push(data);
  }
}
