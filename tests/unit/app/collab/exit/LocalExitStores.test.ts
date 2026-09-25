import { testTime } from '@test/helpers/testClock';

import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectIndex,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  LocalExitProjectStore,
  ManagerResponsibilityReceiptStore,
} from '@/app/collab/exit/LocalExitStores';

const NOW = testTime({ days: -14 });

function membership(): CollabLocalMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: null,
      hostCaCertificatePem: 'certificate',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: NOW,
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 1,
    lifecycle: 'active',
    member: {
      credential: 'c'.repeat(43),
      displayName: 'Alice',
      id: 'member-alpha',
      personalRef: 'refs/heads/members/member-alpha',
      role: 'member',
    },
    project: {
      id: 'project-alpha',
      name: 'Alpha',
      workspacePath: 'workspace/project-alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: NOW,
  };
}

describe('Local exit stores', () => {
  it('projects Leaving state to both navigation and durable membership', async () => {
    const index: CollabLocalProjectIndex = {
      projects: [{
        authorityKind: 'lan',
        createdAt: NOW,
        id: 'project-alpha',
        lifecycle: 'active',
        name: 'Alpha',
        updatedAt: NOW,
        workspacePath: 'workspace/project-alpha',
      }],
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      selectedProjectId: 'project-alpha',
    };
    const repository = {
      loadIndex: jest.fn(async () => index),
      loadMembership: jest.fn(async () => membership()),
      saveMembership: jest.fn(async () => undefined),
      upsertProject: jest.fn(async () => undefined),
    } as unknown as CollabLocalProjectRepository;
    const store = new LocalExitProjectStore(repository);

    await store.markLeaving('project-alpha', 'failed');

    expect(repository.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
      cleanupStatus: 'failed',
      lifecycle: 'leaving',
    }));
    expect(repository.saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      lifecycle: 'leaving',
    }));
  });

  it('restores both navigation and durable membership after obsolete Leave recovery', async () => {
    const leavingMembership = { ...membership(), lifecycle: 'leaving' as const };
    const repository = {
      loadIndex: jest.fn(async () => ({
        projects: [{
          authorityKind: 'lan',
          cleanupStatus: 'failed',
          createdAt: NOW,
          id: 'project-alpha',
          lifecycle: 'leaving',
          name: 'Alpha',
          updatedAt: NOW,
          workspacePath: 'workspace/project-alpha',
        }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: 'project-alpha',
      })),
      loadMembership: jest.fn(async () => leavingMembership),
      saveMembership: jest.fn(async () => undefined),
      upsertProject: jest.fn(async () => undefined),
    } as unknown as CollabLocalProjectRepository;
    const store = new LocalExitProjectStore(repository);

    await store.restoreActive('project-alpha');

    expect(repository.upsertProject).toHaveBeenCalledWith({
      authorityKind: 'lan',
      createdAt: NOW,
      id: 'project-alpha',
      lifecycle: 'active',
      name: 'Alpha',
      updatedAt: NOW,
      workspacePath: 'workspace/project-alpha',
    });
    expect(repository.saveMembership).toHaveBeenCalledWith({
      ...leavingMembership,
      lifecycle: 'active',
    });
  });

  it('persists offered and acknowledged Manager responsibility receipts', async () => {
    let stored: unknown = null;
    const repository = {
      loadLifecycleProjectDocument: jest.fn(async (
        _projectId: string,
        _kind: string,
        decode: (value: unknown) => unknown,
      ) => stored === null ? null : decode(stored)),
      saveLifecycleProjectDocument: jest.fn(async (
        _projectId: string,
        _kind: string,
        record: unknown,
      ) => {
        stored = record;
      }),
      removeLifecycleProjectDocument: jest.fn(async () => {
        stored = null;
        return true;
      }),
    } as unknown as CollabLocalProjectRepository;
    const store = new ManagerResponsibilityReceiptStore(
      repository,
      () => new Date(testTime({ days: -14, minutes: 2 })),
    );
    const offered = {
      expiresAt: testTime({ days: -14, minutes: 10 }),
      offeredAt: testTime({ days: -14 }),
      offerId: 'offer-one',
      purpose: 'manager-leave' as const,
      sourceManagerMemberId: 'member-manager',
      status: 'offered' as const,
      targetMemberId: 'member-alpha',
    };

    await store.save('project-alpha', offered);
    await store.save('project-alpha', {
      ...offered,
      acknowledgedAt: testTime({ days: -14, minutes: 1 }),
      status: 'acknowledged',
    });

    expect(stored).toMatchObject({
      acknowledgedAt: testTime({ days: -14, minutes: 1 }),
      offerId: 'offer-one',
      status: 'acknowledged',
    });
    await expect(store.load('project-alpha')).resolves.toMatchObject({
      offerId: 'offer-one',
      status: 'acknowledged',
    });
    await expect(store.remove('project-alpha')).resolves.toBe(true);
    expect(stored).toBeNull();
  });

  it('removes legacy promotion receipts and rewrites legacy Leave receipts', async () => {
    let stored: unknown = legacyReceipt('manager-transfer');
    const repository = {
      loadLifecycleProjectDocument: jest.fn(async (
        _projectId: string,
        _kind: string,
        decode: (value: unknown) => unknown,
      ) => stored === null ? null : decode(stored)),
      removeLifecycleProjectDocument: jest.fn(async () => {
        stored = null;
        return true;
      }),
      saveLifecycleProjectDocument: jest.fn(async (
        _projectId: string,
        _kind: string,
        record: unknown,
      ) => {
        stored = record;
      }),
    } as unknown as CollabLocalProjectRepository;
    const store = new ManagerResponsibilityReceiptStore(repository);

    await expect(store.load('project-alpha')).resolves.toBeNull();
    expect(stored).toBeNull();

    stored = legacyReceipt('manager-transfer');
    await store.save('project-alpha', {
      expiresAt: testTime({ days: -14, minutes: 20 }),
      offeredAt: testTime({ days: -14, minutes: 10 }),
      offerId: 'offer-current',
      purpose: 'manager-promotion',
      sourceManagerMemberId: 'member-manager',
      status: 'offered',
      targetMemberId: 'member-alpha',
    });
    expect(stored).toMatchObject({
      offerId: 'offer-current',
      purpose: 'manager-promotion',
      schemaVersion: 2,
    });

    stored = legacyReceipt('manager-leave');
    await expect(store.load('project-alpha')).resolves.toMatchObject({
      offerId: 'offer-legacy',
      purpose: 'manager-leave',
      schemaVersion: 2,
    });
    expect(stored).toMatchObject({
      offerId: 'offer-legacy',
      purpose: 'manager-leave',
      schemaVersion: 2,
    });
  });
});

function legacyReceipt(purpose: 'manager-transfer' | 'manager-leave'): unknown {
  return {
    acknowledgedAt: testTime({ days: -14, minutes: 1 }),
    expiresAt: testTime({ days: -14, minutes: 10 }),
    kind: 'manager-responsibility-receipt',
    offerId: 'offer-legacy',
    offeredAt: testTime({ days: -14 }),
    projectId: 'project-alpha',
    purpose,
    schemaVersion: 1,
    sourceManagerMemberId: 'member-manager',
    status: 'acknowledged',
    targetMemberId: 'member-alpha',
    updatedAt: testTime({ days: -14, minutes: 1 }),
  };
}
