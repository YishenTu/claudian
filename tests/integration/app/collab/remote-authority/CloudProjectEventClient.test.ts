import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import { CloudProjectEventClient } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

async function eventServer(upgrade: 'stalled' | 'silent' | 'healthy') {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const requests: string[] = [];
  const webSockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    requests.push(request.url!);
    if (upgrade !== 'stalled') {
      webSockets.handleUpgrade(request, socket, head, () => undefined);
    }
  });
  const heartbeat = upgrade === 'healthy' ? setInterval(() => {
    for (const socket of webSockets.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 1_000) : null;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return {
    requests,
    serverUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => webSockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

function controlledClient(
  input: ConstructorParameters<typeof CloudProjectEventClient>[0],
  onInvalidation: ConstructorParameters<typeof CloudProjectEventClient>[1],
) {
  let settle: { resolve(value: 'connected'): void; reject(error: unknown): void } | undefined;
  const connection = new CollabProjectConnection({
    onStatusChange: () => undefined,
    reconnect: () => {
      connection.observeEvents('connecting');
      return new Promise<'connected'>((resolve, reject) => {
        settle = { resolve, reject };
        client.start();
      });
    },
  });
  const client = new CloudProjectEventClient({
    ...input,
    onConnectionResult: error => {
      connection.observeEvents(error ?? 'connected');
      if (error) settle?.reject(error);
      else settle?.resolve('connected');
      settle = undefined;
    },
  }, onInvalidation);
  return {
    start: () => { void connection.reconnect().catch(() => undefined); },
    dispose: async () => {
      client.dispose();
      settle?.reject(new CollabError({ code: 'cancelled' }));
      settle = undefined;
      await connection.close();
    },
  };
}

describe('Cloud event default transport liveness', () => {
  it.concurrent('retries a stalled Upgrade within 32 seconds without advancing the cursor', async () => {
    const server = await eventServer('stalled');
    const invalidations: number[] = [];
    const client = controlledClient({
      headers: {},
      afterSequence: 7,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async invalidation => {
      invalidations.push(invalidation.sequence);
      return invalidation.sequence;
    });
    try {
      client.start();
      expect(await waitFor(() => server.requests.length >= 2, 32_000)).toBe(true);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v6/projects/project-events/events?afterSequence=7',
        '/v6/projects/project-events/events?afterSequence=7',
      ]);
      expect(invalidations).toEqual([]);
    } finally {
      await client.dispose();
      await server.close();
    }
  }, 35_000);

  it.concurrent('reconnects a silently lost established socket from the applied cursor', async () => {
    const server = await eventServer('silent');
    const client = controlledClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5);
    try {
      client.start();
      expect(await waitFor(() => server.requests.length >= 2, 62_000)).toBe(true);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v6/projects/project-events/events?afterSequence=3',
        '/v6/projects/project-events/events?afterSequence=5',
      ]);
    } finally {
      await client.dispose();
      await server.close();
    }
  }, 65_000);

  it.concurrent('keeps a heartbeat-responsive idle socket connected and stops on disposal', async () => {
    const server = await eventServer('healthy');
    const client = controlledClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5);
    try {
      client.start();
      expect(await waitFor(() => server.requests.length > 0, 2_000)).toBe(true);
      expect(await waitFor(() => server.requests.length > 1, 61_000)).toBe(false);
      await client.dispose();
      expect(await waitFor(() => server.requests.length > 1, 1_000)).toBe(false);
    } finally {
      await client.dispose();
      await server.close();
    }
  }, 65_000);
});

it.each([401, 403])('stops on native Cloud Upgrade authorization rejection %s', async status => {
  const server = createServer();
  server.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 ${status} Denied\r\nContent-Length: 0\r\n\r\n`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let report!: (error: CollabError | undefined) => void;
  const failure = new Promise<CollabError | undefined>(resolve => { report = resolve; });
  const client = new CloudProjectEventClient({
    afterSequence: 0, headers: {}, projectId: 'project-a',
    serverUrl: `http://127.0.0.1:${address.port}`, onConnectionResult: report,
  }, async event => event.sequence);
  try {
    client.start();
    await expect(failure).resolves.toMatchObject({ code: 'authorization-denied' });
  } finally {
    client.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
