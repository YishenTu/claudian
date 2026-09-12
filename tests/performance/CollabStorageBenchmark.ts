import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import initSqlJs from 'sql.js';

import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { NodeSqlJsSnapshotStore } from '@/app/collab/authority/SqlJsSnapshotStore';

const timestamp = '2026-08-08T00:00:00.000Z';
const workloads = ['recovery', 'recovery-retention', 'serial', 'burst'] as const;
type Workload = typeof workloads[number] | 'event-loop-control';

async function seed(directory: string, payloadMiB: number): Promise<void> {
  const SQL = await initSqlJs();
  const database = new SqlJsProjectDatabase(directory, { loadSqlJs: async () => SQL });
  try {
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: timestamp,
        hostCredentialHash: new Uint8Array(32).fill(7),
        hostDisplayName: 'Synthetic Host',
        hostMemberId: 'member-host',
        name: 'Synthetic benchmark',
        projectId: 'project-benchmark',
      });
      const body = 'x'.repeat(16 * 1024);
      for (let index = 0; index < payloadMiB * 64; index++) {
        connection.run(`INSERT INTO tickets (
          ticket_id, title, body, status, author_member_id, revision,
          created_at, updated_at, closed_at, closed_by_member_id
        ) VALUES (?, 'Synthetic Ticket', ?, 'closed', 'member-host', 1, ?, ?, ?, 'member-host')`,
        [`ticket-${index}`, body, timestamp, timestamp, timestamp]);
      }
    });
  } finally {
    await database.close();
  }
}

async function measure(directory: string, workload: Workload): Promise<void> {
  const SQL = await initSqlJs();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  let sampledArrayBufferBytes = 0;
  const sampleMemory = () => {
    sampledArrayBufferBytes = Math.max(sampledArrayBufferBytes, process.memoryUsage().arrayBuffers);
  };
  const snapshotStore = new NodeSqlJsSnapshotStore(directory);
  if (workload === 'recovery-retention') {
    assert.ok(global.gc, 'Retention diagnostics require --expose-gc');
    const readCandidate = snapshotStore.readCandidate.bind(snapshotStore);
    snapshotStore.readCandidate = async kind => {
      global.gc!();
      sampleMemory();
      const bytes = await readCandidate(kind);
      sampleMemory();
      return bytes;
    };
  }
  const database = new SqlJsProjectDatabase(directory, { loadSqlJs: async () => SQL, snapshotStore });
  const recovering = workload === 'recovery' || workload === 'recovery-retention';
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    if (!recovering && workload !== 'event-loop-control') await database.open();
    sampleMemory();
    sampler = setInterval(sampleMemory, 1);
    histogram.enable();
    await delay(10);
    const started = performance.now();
    if (workload === 'event-loop-control') {
      while (performance.now() - started < 100) { /* Deliberate synchronous blocking control. */ }
    } else if (recovering) {
      assert.deepEqual(await database.open(), { generation: 1, migrated: false, source: 'primary' });
    } else {
      const mutate = (index: number) => database.mutate(connection => {
        connection.run('UPDATE project SET name = ? WHERE singleton = 1', [`Write ${index}`]);
      });
      if (workload === 'serial') {
        for (let index = 0; index < 16; index++) await mutate(index);
      } else {
        await Promise.all(Array.from({ length: 16 }, (_, index) => mutate(index)));
      }
      assert.equal(database.generation, 17);
      assert.equal(await database.read(connection => connection.get('SELECT name FROM project')?.name), 'Write 15');
    }
    const durationMs = performance.now() - started;
    sampleMemory();
    await delay(10);
    histogram.disable();
    if (workload === 'event-loop-control') {
      assert.ok(histogram.max / 1e6 >= 80, 'Event-loop monitor missed the deliberate 100 ms blocking control');
    }
    const peakRssMiB = process.resourceUsage().maxRSS / 1024;
    process.stdout.write(`${JSON.stringify({
      workload, durationMs, peakRssMiB,
      sampledArrayBuffersMiB: sampledArrayBufferBytes / 1024 / 1024,
      eventLoopMaxMs: histogram.max / 1e6,
    })}\n`);
  } finally {
    clearInterval(sampler);
    histogram.disable();
    await database.close();
  }
}

function child(args: string[]): string {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', process.argv[1], ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Benchmark child failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const [mode, directory, argument] = process.argv.slice(2);
  if (mode === '--seed') return seed(directory, Number(argument));
  if (mode === '--measure') {
    assert.ok(argument === 'event-loop-control' || workloads.includes(argument as typeof workloads[number]));
    return measure(directory, argument as Workload);
  }
  const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1, 32, 128];
  assert.ok(sizes.every(size => Number.isInteger(size) && size > 0 && size <= 128));
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-storage-benchmark-'));
  try {
    const eventLoopControl = JSON.parse(child(['--measure', root, 'event-loop-control']));
    const samples = [];
    for (const payloadMiB of sizes) {
      const fixture = path.join(root, `fixture-${payloadMiB}`);
      await mkdir(fixture);
      child(['--seed', fixture, String(payloadMiB)]);
      const image = path.join(fixture, 'collab.db');
      const snapshotBytes = (await stat(image)).size;
      for (const workload of workloads) {
        for (let repetition = 1; repetition <= 3; repetition++) {
          const target = path.join(root, `${payloadMiB}-${workload}-${repetition}`);
          await mkdir(target);
          await copyFile(image, path.join(target, 'collab.db'));
          if (workload === 'recovery' || workload === 'recovery-retention') {
            await copyFile(image, path.join(target, 'collab.db.tmp'));
            await copyFile(image, path.join(target, 'collab.db.bak'));
          }
          const sample = JSON.parse(child(['--measure', target, workload]));
          samples.push({ payloadMiB, snapshotBytes, repetition, ...sample });
          await rm(target, { recursive: true, force: true });
        }
      }
      await rm(fixture, { recursive: true, force: true });
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, eventLoopControl, samples }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
