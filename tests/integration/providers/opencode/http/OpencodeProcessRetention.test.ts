// @test-ci {"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import { type OpencodeServerLease,OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

test('disposing one lease ends only its native process across historical databases', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-audit-')));
  const cli = path.join(root, 'opencode.cjs');
  writeOpencodeNativePeer(cli, { scenario: 'retention' });
  const servers = new OpencodeServerService();
  const leases: OpencodeServerLease[] = [];
  const pids: number[] = [];
  try {
    for (let index = 0; index < 6; index += 1) {
      const lease = await servers.acquire(cli, root, { ...process.env, OPENCODE_DB: path.join(root, `history-${index}.db`) });
      leases.push(lease);
      pids.push((await lease.request<{ data: { pid: number } }>('/fixture/pid')).data.pid);
    }
    await leases[0].dispose();
    const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    expect(alive).toEqual(pids.slice(1));
  } finally {
    await Promise.all(leases.map(lease => lease.dispose()));
    await servers.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('a repaired launch configuration can retry after creation fails', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-audit-retry-')));
  const config = path.join(root, 'opencode.json');
  const environment = { OPENCODE_DB: path.join(root, 'history.db'), OPENCODE_CONFIG: config };
  // A verified CLI that is never spawned: the lease launches lazily on its first request.
  const cli = path.join(root, 'opencode.cjs');
  writeOpencodeNativePeer(cli, { scenario: 'retention' });
  const servers = new OpencodeServerService();
  try {
    await expect(servers.acquire(cli, root, environment)).rejects.toThrow('Could not read OpenCode config');
    writeFileSync(config, '{ "agent": ');
    await expect(servers.acquire(cli, root, environment)).rejects.toThrow(`Invalid OpenCode config: ${config}`);
    writeFileSync(config, '{}');
    const lease = await servers.acquire(cli, root, environment);
    await lease.dispose();
  } finally {
    await servers.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
