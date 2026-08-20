import { createHash } from 'node:crypto';

import type { RetirementTombstoneRecord } from '@/app/collab/retirement/RetirementTombstoneRecord';
import {
  RetirementTombstoneRepository,
  type RetirementTombstoneStore,
} from '@/app/collab/retirement/RetirementTombstoneRepository';

const NOW = new Date('2026-08-13T08:00:00.000Z');

describe('RetirementTombstoneRepository', () => {
  it('authenticates former Members and serializes idempotent acknowledgements', async () => {
    const store = new MemoryTombstoneStore(record());
    const repository = new RetirementTombstoneRepository(store, { now: () => NOW });

    await expect(repository.authenticate('project-alpha', 'a'.repeat(43)))
      .resolves.toEqual(expect.objectContaining({ memberId: 'member-a' }));
    await expect(repository.authenticate('project-alpha', 'z'.repeat(43)))
      .rejects.toMatchObject({ code: 'authentication-failed' });

    const first = await repository.acknowledge('project-alpha', 'a'.repeat(43));
    const replay = await repository.acknowledge('project-alpha', 'a'.repeat(43));
    expect(first).toEqual({
      acknowledgedAt: NOW.toISOString(),
      result: record().result,
    });
    expect(replay).toEqual(first);

    const final = await repository.acknowledge('project-alpha', 'b'.repeat(43));
    expect(final.acknowledgedAt).toBe(NOW.toISOString());
    expect(store.removeCalls).toBe(0);
  });

  it('reports 30-day expirations without deleting cleanup authority', async () => {
    const expired = record({
      expiresAt: '2026-08-13T07:59:59.999Z',
      retiredAt: '2026-07-14T07:59:59.999Z',
      result: { projectId: 'project-alpha', retiredAt: '2026-07-14T07:59:59.999Z' },
    });
    const store = new MemoryTombstoneStore(expired);
    const repository = new RetirementTombstoneRepository(store, { now: () => NOW });

    await expect(repository.restore()).resolves.toEqual({
      expiredProjectIds: ['project-alpha'],
      tombstones: [],
    });
    expect(store.removeCalls).toBe(0);
    expect(store.records.has('project-alpha')).toBe(true);
    await expect(repository.load('project-alpha')).resolves.toBeNull();
    await expect(repository.authenticate('project-alpha', 'a'.repeat(43)))
      .rejects.toMatchObject({ code: 'project-not-found' });
    expect(store.removeCalls).toBe(0);
    expect(store.records.has('project-alpha')).toBe(true);
  });

  it('rejects conflicting replacement state while accepting exact recovery replay', async () => {
    const store = new MemoryTombstoneStore(record());
    const repository = new RetirementTombstoneRepository(store, { now: () => NOW });

    await expect(repository.savePrepared(record())).resolves.toBeUndefined();
    await expect(repository.savePrepared(record({
      replay: { ...record().replay, requestFingerprint: 'f'.repeat(64) },
    }))).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
  });

  it('does not persist an acknowledgement for a stale retirement timestamp', async () => {
    const store = new MemoryTombstoneStore(record());
    const repository = new RetirementTombstoneRepository(store, { now: () => NOW });

    await expect(repository.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      '2026-08-13T08:00:01.000Z',
    )).rejects.toMatchObject({ code: 'stale-project-selection' });
    expect(store.records.get('project-alpha')?.formerMembers[0].acknowledgedAt).toBeNull();
  });
});

class MemoryTombstoneStore implements RetirementTombstoneStore {
  readonly records = new Map<string, RetirementTombstoneRecord>();
  removeCalls = 0;

  constructor(initial?: RetirementTombstoneRecord) {
    if (initial) this.records.set(initial.projectId, initial);
  }

  listRetirementTombstoneProjectIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.records.keys()]);
  }

  loadRetirementTombstone(projectId: string): Promise<RetirementTombstoneRecord | null> {
    return Promise.resolve(this.records.get(projectId) ?? null);
  }

  removeRetirementTombstone(projectId: string): Promise<boolean> {
    this.removeCalls += 1;
    return Promise.resolve(this.records.delete(projectId));
  }

  saveRetirementTombstone(value: RetirementTombstoneRecord): Promise<void> {
    this.records.set(value.projectId, structuredClone(value));
    return Promise.resolve();
  }
}

function record(overrides: Partial<RetirementTombstoneRecord> = {}): RetirementTombstoneRecord {
  const retiredAt = overrides.retiredAt ?? NOW.toISOString();
  return {
    expiresAt: '2026-09-12T08:00:00.000Z',
    formerMembers: [
      {
        acknowledgedAt: null,
        credentialHash: hash('a'.repeat(43)),
        memberId: 'member-a',
      },
      {
        acknowledgedAt: null,
        credentialHash: hash('b'.repeat(43)),
        memberId: 'member-b',
      },
    ],
    hostTransitionProofs: [],
    kind: 'retirement-tombstone',
    projectId: 'project-alpha',
    replay: {
      actorMemberId: 'member-a',
      idempotencyKey: 'retire-key-one',
      requestFingerprint: 'a'.repeat(64),
    },
    result: { projectId: 'project-alpha', retiredAt },
    retiredAt,
    schemaVersion: 1,
    ...overrides,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
