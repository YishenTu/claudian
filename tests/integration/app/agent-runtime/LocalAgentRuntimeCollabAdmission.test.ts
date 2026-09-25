import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs from 'sql.js';

import { AgentRuntimeGateway } from '@/app/agent-runtime/AgentRuntimeGateway';
import { LocalAgentRuntimeHTTPServer } from '@/app/agent-runtime/LocalAgentRuntimeHTTPServer';
import { SQLJSProjectDatabase } from '@/app/collab/authority/SQLJSProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';

async function withRuntimeProject(run: (context: {
  readonly feature: ReturnType<typeof createCollabFeatureSubcomposition>['feature'];
  readonly projectId: string;
  readonly endpoint: Awaited<ReturnType<LocalAgentRuntimeHTTPServer['start']>>;
}) => Promise<void>): Promise<void> {
  const SQL = await initSqlJs();
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-runtime-admission-'));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const invitationCodec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
  const foundation = new ClaudianCollabService({
    vaultRoot: root,
    getConfiguredGitPath: () => '',
    installationKey: TEST_INSTALLATION_A,
    invitationCodec,
    obsidianConfigDirectory: '.obsidian',
    createAuthorityDatabase: (directory, resourceAdmission) => new SQLJSProjectDatabase(
      directory, { resourceAdmission, loadSqlJs: async () => SQL },
    ),
    lanHost: {
      createInvitationCodec: () => invitationCodec,
      getPrivateIpv4Addresses: () => ['127.0.0.1'],
      portCandidates: [port],
    },
  });
  const feature = createCollabFeatureSubcomposition({
    foundation,
    vaultRoot: root,
    projectSetup: new CollabProjectSetupService(foundation, {
      installationKey: TEST_INSTALLATION_A,
      vaultRoot: root,
    }),
  }).feature;
  const runtime = new LocalAgentRuntimeHTTPServer(
    new AgentRuntimeGateway(async () => feature), { portCandidates: [0] },
  );
  try {
    expect((await feature.initialize()).status).toBe('success');
    const created = await feature.createProject({ memberDisplayName: 'Fixture Manager', name: 'Audit' });
    if (created.status !== 'success') throw new Error('Fixture creation failed');
    const projectId = created.value.id;
    expect((await feature.startHost(projectId)).status).toBe('success');
    const endpoint = await runtime.start();
    await run({ feature, projectId, endpoint });
  } finally {
    await runtime.close();
    await feature.close();
    await foundation.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('rejects foreign Host/Origin before a real Collab Ticket mutation', async () => {
  await withRuntimeProject(async ({ feature, projectId, endpoint }) => {
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const body = JSON.stringify({
        id: 'foreign-origin-write',
        method: 'collab.tickets.create',
        params: { mutationId: 'foreign-origin-write', projectId, title: 'Foreign Origin mutation', body: 'Synthetic fixture.' },
      });
      const call = request(endpoint.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Host: 'rebind.example.test',
          Origin: 'http://rebind.example.test',
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      call.on('error', reject);
      call.end(body);
    });
    const tickets = await feature.listTickets({ projectId, status: 'open' });
    if (tickets.status !== 'success') throw new Error('Fixture Ticket read failed');
    const mutated = tickets.value.page.tickets.some(ticket => ticket.title === 'Foreign Origin mutation');
    expect(result.status).toBe(403);
    expect(mutated).toBe(false);
  });
}, 30_000);

it('replays one mutation across HTTP requests while admitting distinct new intents', async () => {
  await withRuntimeProject(async ({ feature, projectId, endpoint }) => {
    const invoke = async (id: string, mutationId: string, title = 'Ticket') => {
      const response = await fetch(endpoint.rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, method: 'collab.tickets.create', params: {
          mutationId, projectId, title, body: 'Synthetic fixture.',
        } }),
      });
      return response.json();
    };
    const first = await invoke('call-a', 'intent-a');
    const replay = await invoke('call-b', 'intent-a');
    expect(first.result.ticket.id).toEqual(expect.any(String));
    expect(replay.result.ticket.id).toBe(first.result.ticket.id);
    const distinct = await invoke('call-a', 'intent-b');
    expect(distinct.result.ticket.id).not.toBe(first.result.ticket.id);
    expect(await invoke('call-c', 'intent-a', 'Different title')).toMatchObject({
      error: { code: 'idempotency-conflict' },
    });
    const tickets = await feature.listTickets({ projectId, status: 'open' });
    if (tickets.status !== 'success') throw new Error('Fixture Ticket read failed');
    expect(tickets.value.page.tickets).toHaveLength(2);
  });
}, 30_000);
