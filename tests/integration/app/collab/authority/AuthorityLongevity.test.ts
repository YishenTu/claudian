import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ProjectEventHub, type ProjectEventSocket, SqlJsProjectEventSource } from '@/app/collab/lan/ProjectEventHub';

class Socket implements ProjectEventSocket {
  readyState = 1;
  readonly messages: unknown[] = [];
  close(): void { this.readyState = 3; }
  on(): this { return this; }
  ping(): void {}
  send(data: string): void { this.messages.push(JSON.parse(data)); }
}

it('replays a durable retained tail after restart and reuses its storage across rotations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-authority-longevity-'));
  const SQL = await initSqlJs();
  let database = new SqlJsProjectDatabase(root, { loadSqlJs: async () => SQL });
  let hub: ProjectEventHub | undefined;
  const events = new AuthorityEventRepository();
  const append = (count: number) => database.mutate(connection => {
    for (let index = 0; index < count; index++) events.append(connection, {
      actorMemberId: 'member-a', createdAt: '2026-08-13T00:00:00.000Z',
      kind: 'request.updated', payload: { requestId: 'request-a' },
    });
  });
  try {
    await database.open();
    await database.mutate(connection => new ProjectAuthorityRepository().initialize(connection, {
      createdAt: '2026-08-13T00:00:00.000Z', hostCredentialHash: new Uint8Array(32).fill(1),
      hostDisplayName: 'Member', hostMemberId: 'member-a', name: 'Project', projectId: 'project-a',
    }));
    await append(601);
    const initialBytes = (await database.exportSnapshot()).byteLength;
    await database.close();
    database = new SqlJsProjectDatabase(root, { loadSqlJs: async () => SQL });
    await database.open();
    hub = new ProjectEventHub('project-a', new SqlJsProjectEventSource(database, 'project-a'), {
      setInterval: () => 0, clearInterval: () => undefined,
    });
    const expired = new Socket();
    const recent = new Socket();
    await hub.connect(expired, 'member-a', 100);
    await hub.connect(recent, 'member-a', 599);
    expect(expired.messages).toEqual([expect.objectContaining({ kind: 'snapshot-required', sequence: 601 })]);
    expect(recent.messages).toEqual([
      expect.objectContaining({ kind: 'request-updated', sequence: 600 }),
      expect.objectContaining({ kind: 'request-updated', sequence: 601 }),
    ]);
    hub.close();
    hub = undefined;
    await append(10_000);
    expect((await database.exportSnapshot()).byteLength).toBeLessThanOrEqual(initialBytes + 16_384);
    await expect(database.mutate(connection => connection.run("UPDATE project SET host_member_id = 'missing'")))
      .rejects.toMatchObject({ code: 'authority-integrity-error' });
    await database.mutate(connection => connection.run("UPDATE project SET name = 'Still writable'"));
    await expect(database.read(connection => connection.get('SELECT COUNT(*) AS count, MAX(sequence) AS latest FROM events')))
      .resolves.toEqual({ count: 500, latest: 10_601 });
  } finally {
    hub?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
