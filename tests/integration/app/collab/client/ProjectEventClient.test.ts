import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { WebSocketServer } from 'ws';

import { ProjectEventClient } from '@/app/collab/client/ProjectEventClient';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

it('detects a silently lost idle Host independently for three members', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-idle-members-'));
  const identity = await new LanTlsIdentity(root, {
    installationKey: TEST_INSTALLATION_A,
  }).issueServerIdentity('127.0.0.1');
  const server = createServer({ key: identity.privateKeyPem, cert: identity.certificateChainPem });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const recovered = new Set<number>();
  const connections = [0, 1, 2].map(member => new CollabProjectConnection({
    onStatusChange: () => undefined,
    reconnect: async () => { recovered.add(member); return 'connected'; },
  }));
  const clients = connections.map((connection, member) => new ProjectEventClient({
    caCertificatePem: identity.caCertificatePem,
    endpoint: `https://127.0.0.1:${address.port}`,
    lastSequence: member,
    memberCredential: String(member).repeat(43),
    projectId: 'project-idle-members',
    onConnectionResult: error => error
      ? connection.observeFailure(error) : connection.observeSuccess(),
  }, async invalidation => invalidation.sequence));
  try {
    clients.forEach(client => client.start());
    const deadline = Date.now() + 63_000;
    while (recovered.size < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect([...recovered].sort()).toEqual([0, 1, 2]);
  } finally {
    clients.forEach(client => client.dispose());
    await Promise.all(connections.map(connection => connection.close()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);

it.each([401, 403])('stops on native LAN Upgrade authorization rejection %s', async status => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-event-auth-'));
  const identity = await new LanTlsIdentity(root, { installationKey: TEST_INSTALLATION_A }).issueServerIdentity('127.0.0.1');
  const server = createServer({ key: identity.privateKeyPem, cert: identity.certificateChainPem });
  server.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 ${status} Denied\r\nContent-Length: 0\r\n\r\n`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let report!: (error: CollabError | undefined) => void;
  const failure = new Promise<CollabError | undefined>(resolve => { report = resolve; });
  const client = new ProjectEventClient({
    caCertificatePem: identity.caCertificatePem, endpoint: `https://127.0.0.1:${address.port}`,
    lastSequence: 0, memberCredential: 'A'.repeat(43), projectId: 'project-a', onConnectionResult: report,
  }, async event => event.sequence);
  try {
    client.start();
    await expect(failure).resolves.toMatchObject({ code: 'authorization-denied' });
  } finally {
    client.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
