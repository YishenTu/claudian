import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';

const pendingLeave = (): PendingLeaveRecord => ({
  authorityReplay: {
    expectedHostMemberId: 'member-host',
    idempotencyManagerMemberId: 'member-manager',
    managerResponsibilityOfferId: null,
  },
  cleanupChoice: 'keep-files',
  cleanupMarkerNonce: 'n'.repeat(43),
  createdAt: '2026-08-13T00:00:00.000Z',
  hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
  hostCaFingerprint: 'a'.repeat(64),
  hostEndpoint: 'https://192.168.1.10:4321/',
  idempotencyKey: 'leave-alpha',
  kind: 'pending-leave',
  localCleanupComplete: true,
  localRole: 'member',
  memberCredential: 'c'.repeat(43),
  memberId: 'member-alpha',
  operationId: 'leave-alpha',
  phase: 'queued',
  projectCreatedAt: '2026-08-12T00:00:00.000Z',
  projectId: 'project-alpha',
  projectName: 'Alpha',
  schemaVersion: 2,
  updatedAt: '2026-08-13T00:00:00.000Z',
  workspacePath: 'workspace/project-alpha',
});

describe('CollabLifecycleJournalStore', () => {
  let root: string;
  let store: CollabLifecycleJournalStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-lifecycle-journals-'));
    store = new CollabLifecycleJournalStore(root);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('preserves pending Leave records independently from Project files', async () => {
    await mkdir(path.join(root, 'workspace', 'project-alpha'), { recursive: true });
    await store.pendingLeaves.save(pendingLeave());
    await rm(path.join(root, 'workspace', 'project-alpha'), { recursive: true });

    await expect(store.pendingLeaves.load('project-alpha')).resolves.toEqual(pendingLeave());
    await expect(store.pendingLeaves.list()).resolves.toEqual([pendingLeave()]);
    await expect(readFile(
      path.join(root, '.claudian', 'collab', 'pending-leaves', 'project-alpha.json'),
      'utf8',
    )).resolves.toContain('memberCredential');
    await expect(store.pendingLeaves.remove('project-alpha')).resolves.toBe(true);
    await expect(store.pendingLeaves.remove('project-alpha')).resolves.toBe(false);
  });

  it('discovers applied Retired cleanup journals without a Project index', async () => {
    await store.retiredCleanups.save({
      choice: 'keep-files',
      createdAt: '2026-08-13T00:00:00.000Z',
      kind: 'local-cleanup',
      markerNonce: 'A'.repeat(43),
      memberId: 'member-one',
      operationId: 'cleanup-one',
      phase: 'choice-applied',
      projectId: 'project-one',
      purpose: 'retire',
      schemaVersion: 1,
      updatedAt: '2026-08-13T00:00:00.000Z',
      workspacePath: 'workspace/project-one',
    });

    await expect(store.retiredCleanups.listProjectIds()).resolves.toEqual(['project-one']);
    await store.retiredCleanups.remove('project-one');
    await expect(store.retiredCleanups.listProjectIds()).resolves.toEqual([]);
  });
});
