import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { CloudProjectEventClient } from '@/app/collab/remote-authority/CloudAuthorityAdapter';

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

describe('Cloud event default transport liveness', () => {
  it.concurrent('retries a stalled Upgrade within 32 seconds without advancing the cursor', async () => {
    const server = await eventServer('stalled');
    const invalidations: number[] = [];
    const client = new CloudProjectEventClient({
      headers: {},
      afterSequence: 7,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async invalidation => {
      invalidations.push(invalidation.sequence);
      return invalidation.sequence;
    }, { random: () => 0 });
    try {
      client.start();
      expect(await waitFor(() => server.requests.length >= 2, 32_000)).toBe(true);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v5/projects/project-events/events?afterSequence=7',
        '/v5/projects/project-events/events?afterSequence=7',
      ]);
      expect(invalidations).toEqual([]);
    } finally {
      client.dispose();
      await server.close();
    }
  }, 35_000);

  it.concurrent('reconnects a silently lost established socket from the applied cursor', async () => {
    const server = await eventServer('silent');
    const client = new CloudProjectEventClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5, { random: () => 0 });
    try {
      client.start();
      expect(await waitFor(() => server.requests.length >= 2, 62_000)).toBe(true);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v5/projects/project-events/events?afterSequence=3',
        '/v5/projects/project-events/events?afterSequence=5',
      ]);
    } finally {
      client.dispose();
      await server.close();
    }
  }, 65_000);

  it.concurrent('keeps a heartbeat-responsive idle socket connected and stops on disposal', async () => {
    const server = await eventServer('healthy');
    const client = new CloudProjectEventClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5, { random: () => 0 });
    try {
      client.start();
      expect(await waitFor(() => server.requests.length > 0, 2_000)).toBe(true);
      expect(await waitFor(() => server.requests.length > 1, 61_000)).toBe(false);
      client.dispose();
      expect(await waitFor(() => server.requests.length > 1, 1_000)).toBe(false);
    } finally {
      client.dispose();
      await server.close();
    }
  }, 65_000);
});
