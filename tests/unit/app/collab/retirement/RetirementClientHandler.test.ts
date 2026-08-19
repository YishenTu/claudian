import type {
  CollabLocalMembershipRecord,
  CollabRetiredProjectProjectionSeed,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { LocalCleanupRecord } from '@/app/collab/exit/LocalCleanupRecord';
import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type { RetirementAcknowledgementScheduler } from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import {
  type RetirementClientActivityPort,
  RetirementClientHandler,
  type RetirementClientProjectionStore,
} from '@/app/collab/retirement/RetirementClientHandler';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';

const RETIRED_AT = '2026-08-13T00:00:00.000Z';

describe('RetirementClientHandler', () => {
  it('drains an admitted retirement transition and rejects work after close', async () => {
    let reportCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>(resolve => {
      reportCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });
    const cleanup = cleanupPort([]);
    cleanup.cleanup.mockImplementation(async () => {
      reportCleanupStarted();
      await cleanupReleased;
      return {
        filesPreserved: true,
        gitDataRemoved: true,
        markerRetained: true,
        status: 'complete',
      };
    });
    const handler = new RetirementClientHandler(
      new MemoryProjectionStore([]),
      {
        closeProject: jest.fn().mockResolvedValue(undefined),
        drainProject: jest.fn().mockResolvedValue(undefined),
      },
      { schedule: jest.fn() },
      cleanup,
      { createOperationId: () => 'retire-local-one', now: () => new Date(RETIRED_AT) },
    );
    const handling = handler.handle(
      { projectId: 'project-a', retiredAt: RETIRED_AT },
      'event',
    );

    await cleanupStarted;
    let closed = false;
    const closing = handler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseCleanup();
    await handling;
    await closing;
    expect(closed).toBe(true);
    await expect(handler.handle(
      { projectId: 'project-a', retiredAt: RETIRED_AT },
      'event',
    )).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('persists Retired before acknowledgement, closes activity, drains, and detaches Git', async () => {
    const order: string[] = [];
    const store = new MemoryProjectionStore(order);
    const activity: jest.Mocked<RetirementClientActivityPort> = {
      closeProject: jest.fn(async (_projectId) => { order.push('close'); }),
      drainProject: jest.fn(async (_projectId) => { order.push('drain'); }),
    };
    const acknowledgement: jest.Mocked<RetirementAcknowledgementScheduler> = {
      schedule: jest.fn((_projectId) => { order.push('ack'); }),
    };
    const cleanup = cleanupPort(order);
    const publish = jest.fn(() => { order.push('publish'); });
    const handler = new RetirementClientHandler(
      store,
      activity,
      acknowledgement,
      cleanup,
      { createOperationId: () => 'retire-local-one', now: () => new Date(RETIRED_AT), publish },
    );

    await handler.handle({ projectId: 'project-a', retiredAt: RETIRED_AT }, 'event');

    expect(order).toEqual(['persist', 'close', 'ack', 'drain', 'running', 'cleanup', 'complete', 'publish']);
    expect(cleanup.cleanup).toHaveBeenCalledWith(expect.objectContaining({
      choice: 'keep-files',
      memberId: 'member-a',
      operationId: 'retire-local-one',
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
      purpose: 'retire',
      workspacePath: 'workspace/project-a',
    }), {});
    expect(store.membership).toBeNull();
    expect(store.retirement).toMatchObject({ cleanupStatus: 'complete' });
  });

  it('coalesces response, event, and fallback into one cleanup and acknowledgement identity', async () => {
    const store = new MemoryProjectionStore([]);
    const activity: jest.Mocked<RetirementClientActivityPort> = {
      closeProject: jest.fn(async (_projectId) => undefined),
      drainProject: jest.fn(async (_projectId) => undefined),
    };
    const acknowledgement: jest.Mocked<RetirementAcknowledgementScheduler> = {
      schedule: jest.fn((_projectId) => undefined),
    };
    const cleanup = cleanupPort([]);
    const handler = new RetirementClientHandler(
      store,
      activity,
      acknowledgement,
      cleanup,
      { createOperationId: () => 'retire-local-one', now: () => new Date(RETIRED_AT) },
    );
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT };

    await Promise.all([
      handler.handle(result, 'response'),
      handler.handle(result, 'event'),
      handler.handle(result, 'terminal-fallback'),
    ]);

    expect(store.transitionCount).toBe(1);
    expect(cleanup.cleanup).toHaveBeenCalledTimes(1);
    expect(acknowledgement.schedule).toHaveBeenCalledWith('project-a');
    expect(new Set(acknowledgement.schedule.mock.calls.map(call => call[0])))
      .toEqual(new Set(['project-a']));
  });

  it('resumes a crash after Retired persistence and retains the entry independently of delivery', async () => {
    const store = new MemoryProjectionStore([]);
    await store.transitionProjectToRetired(pendingRecord());
    const activity: jest.Mocked<RetirementClientActivityPort> = {
      closeProject: jest.fn(async (_projectId) => undefined),
      drainProject: jest.fn(async (_projectId) => undefined),
    };
    const acknowledgement: jest.Mocked<RetirementAcknowledgementScheduler> = {
      schedule: jest.fn((_projectId) => undefined),
    };
    const cleanup = cleanupPort([]);
    const handler = new RetirementClientHandler(store, activity, acknowledgement, cleanup);

    await handler.resume('project-a');

    expect(cleanup.cleanup).toHaveBeenCalledTimes(1);
    expect(store.retirement?.cleanupStatus).toBe('complete');
    expect(store.projectLifecycle).toBe('retired');
  });

  it('recovers after a crash between Retired persistence and activity shutdown', async () => {
    const store = new MemoryProjectionStore([]);
    const failedActivity: jest.Mocked<RetirementClientActivityPort> = {
      closeProject: jest.fn(async (_projectId) => { throw new Error('crash'); }),
      drainProject: jest.fn(async (_projectId) => undefined),
    };
    const acknowledgement: jest.Mocked<RetirementAcknowledgementScheduler> = {
      schedule: jest.fn((_projectId) => undefined),
    };
    const cleanup = cleanupPort([]);
    const interrupted = new RetirementClientHandler(
      store,
      failedActivity,
      acknowledgement,
      cleanup,
      { createOperationId: () => 'retire-local-one', now: () => new Date(RETIRED_AT) },
    );

    await expect(interrupted.handle(
      { projectId: 'project-a', retiredAt: RETIRED_AT },
      'response',
    )).rejects.toThrow('crash');
    expect(store.projectLifecycle).toBe('retired');
    expect(store.membership).toBeNull();
    expect(cleanup.cleanup).not.toHaveBeenCalled();

    const resumed = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async (_projectId) => undefined),
        drainProject: jest.fn(async (_projectId) => undefined),
      },
      acknowledgement,
      cleanup,
    );
    await resumed.resume('project-a');
    expect(cleanup.cleanup).toHaveBeenCalledTimes(1);
    expect(store.retirement?.cleanupStatus).toBe('complete');
  });

  it('rejects an out-of-order terminal result that changes retirement identity', async () => {
    const store = new MemoryProjectionStore([]);
    await store.transitionProjectToRetired(pendingRecord());
    const cleanup = cleanupPort([]);
    const handler = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async (_projectId) => undefined),
        drainProject: jest.fn(async (_projectId) => undefined),
      },
      { schedule: jest.fn((_projectId) => undefined) },
      cleanup,
    );

    await expect(handler.handle({
      projectId: 'project-a',
      retiredAt: '2026-08-13T00:00:01.000Z',
    }, 'terminal-fallback')).rejects.toMatchObject({ code: 'authority-integrity-error' });
    expect(cleanup.cleanup).not.toHaveBeenCalled();
  });

  it('retains failed cleanup state and resumes the same cleanup operation', async () => {
    const store = new MemoryProjectionStore([]);
    const cleanup = cleanupPort([]);
    cleanup.cleanup
      .mockRejectedValueOnce(new Error('detach interrupted'))
      .mockResolvedValueOnce({
        filesPreserved: true,
        gitDataRemoved: true,
        markerRetained: true,
        status: 'complete',
      });
    const activity = {
      closeProject: jest.fn(async (_projectId: string) => undefined),
      drainProject: jest.fn(async (_projectId: string) => undefined),
    };
    const handler = new RetirementClientHandler(
      store,
      activity,
      { schedule: jest.fn((_projectId) => undefined) },
      cleanup,
      { createOperationId: () => 'retire-local-one', now: () => new Date(RETIRED_AT) },
    );

    await expect(handler.handle(
      { projectId: 'project-a', retiredAt: RETIRED_AT },
      'event',
    )).rejects.toThrow('detach interrupted');
    expect(store.retirement?.cleanupStatus).toBe('failed');

    await handler.resume('project-a');
    expect(cleanup.cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.cleanup.mock.calls[0][0].operationId)
      .toBe(cleanup.cleanup.mock.calls[1][0].operationId);
    expect(store.retirement?.cleanupStatus).toBe('complete');
  });

  it('lets Retirement supersede a locally cleaned pending Leave without active Project state', async () => {
    const store = new MemoryProjectionStore([]);
    store.membership = null;
    const pending = pendingLeaveRecord();
    const pendingLeaves = {
      load: jest.fn(async () => pending as PendingLeaveRecord | null),
      remove: jest.fn(async () => true),
    };
    let retiredCleanup: LocalCleanupRecord | null = null;
    const retiredCleanupRecords = {
      load: jest.fn(async () => retiredCleanup),
      save: jest.fn(async (record: LocalCleanupRecord) => { retiredCleanup = record; }),
    };
    const acknowledgement = { schedule: jest.fn((_projectId: string) => undefined) };
    const cleanup = cleanupPort([]);
    const handler = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async (_projectId) => undefined),
        drainProject: jest.fn(async (_projectId) => undefined),
      },
      acknowledgement,
      cleanup,
      {
        createOperationId: () => 'retire-local-one',
        now: () => new Date(RETIRED_AT),
        pendingLeaves,
        retiredCleanupRecords,
      },
    );

    await handler.handle({ projectId: 'project-a', retiredAt: RETIRED_AT }, 'terminal-fallback');

    expect(store.projectLifecycle).toBe('retired');
    expect(store.lastProjectionSeed).toEqual({
      authorityKind: 'lan',
      createdAt: '2026-08-12T00:00:00.000Z',
      name: 'Alpha',
      workspacePath: 'workspace/project-a',
    });
    expect(store.retirement).toMatchObject({
      acknowledgementStatus: 'pending',
      cleanupStatus: 'complete',
      memberCredential: 'A'.repeat(43),
    });
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(pendingLeaves.remove).toHaveBeenCalledWith('project-a');
    expect(acknowledgement.schedule).toHaveBeenCalledWith('project-a');
    expect(retiredCleanup).toMatchObject({
      choice: 'keep-files',
      phase: 'choice-applied',
      purpose: 'retire',
    });
  });

  it('repairs a crash after the retirement record write from the pending Leave seed', async () => {
    const store = new MemoryProjectionStore([]);
    store.membership = null;
    store.retirement = pendingRecord();
    const pendingLeaves = {
      load: jest.fn(async () => pendingLeaveRecord() as PendingLeaveRecord | null),
      remove: jest.fn(async () => true),
    };
    let retiredCleanup: LocalCleanupRecord | null = null;
    const retiredCleanupRecords = {
      load: jest.fn(async () => retiredCleanup),
      save: jest.fn(async (record: LocalCleanupRecord) => { retiredCleanup = record; }),
    };
    const handler = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async (_projectId) => undefined),
        drainProject: jest.fn(async (_projectId) => undefined),
      },
      { schedule: jest.fn((_projectId) => undefined) },
      cleanupPort([]),
      { pendingLeaves, retiredCleanupRecords },
    );

    await handler.resume('project-a');

    expect(store.projectLifecycle).toBe('retired');
    expect(store.lastProjectionSeed?.workspacePath).toBe('workspace/project-a');
    expect(pendingLeaves.remove).toHaveBeenCalledWith('project-a');
    expect(retiredCleanup).toMatchObject({ phase: 'choice-applied' });
  });

  it('adopts a completed Leave cleanup checkpoint even before its pending flag is saved', async () => {
    const store = new MemoryProjectionStore([]);
    store.membership = null;
    const pending = { ...pendingLeaveRecord(), localCleanupComplete: false };
    const leaveCleanup = {
      ...completedLeaveCleanupRecord(),
      phase: 'complete' as const,
    };
    const pendingLeaves = {
      load: jest.fn(async () => pending as PendingLeaveRecord | null),
      remove: jest.fn(async () => true),
    };
    let retiredCleanup: LocalCleanupRecord | null = null;
    const handler = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async () => undefined),
        drainProject: jest.fn(async () => undefined),
      },
      { schedule: jest.fn(() => undefined) },
      cleanupPort([]),
      {
        now: () => new Date(RETIRED_AT),
        pendingLeaveCleanup: { resume: jest.fn() },
        pendingLeaveCleanupRecords: {
          load: jest.fn(async () => leaveCleanup),
        },
        pendingLeaves,
        retiredCleanupRecords: {
          load: jest.fn(async () => retiredCleanup),
          save: jest.fn(async record => { retiredCleanup = record; }),
        },
      },
    );

    await handler.handle({ projectId: 'project-a', retiredAt: RETIRED_AT }, 'event');

    expect(store.retirement?.cleanupStatus).toBe('complete');
    expect(retiredCleanup).toMatchObject({
      markerNonce: pending.cleanupMarkerNonce,
      operationId: pending.operationId,
      phase: 'choice-applied',
    });
  });

  it('resumes a partial Leave cleanup before adopting it for Retirement', async () => {
    const store = new MemoryProjectionStore([]);
    store.membership = null;
    const pending = { ...pendingLeaveRecord(), localCleanupComplete: false };
    const leaveCleanup = {
      ...completedLeaveCleanupRecord(),
      phase: 'detached' as const,
    };
    const resume = jest.fn().mockResolvedValue({
      filesPreserved: true,
      gitDataRemoved: true,
      markerRetained: false,
      status: 'complete',
    });
    let retiredCleanup: LocalCleanupRecord | null = null;
    const handler = new RetirementClientHandler(
      store,
      {
        closeProject: jest.fn(async () => undefined),
        drainProject: jest.fn(async () => undefined),
      },
      { schedule: jest.fn(() => undefined) },
      cleanupPort([]),
      {
        now: () => new Date(RETIRED_AT),
        pendingLeaveCleanup: { resume },
        pendingLeaveCleanupRecords: {
          load: jest.fn(async () => leaveCleanup),
        },
        pendingLeaves: {
          load: jest.fn(async () => pending),
          remove: jest.fn(async () => true),
        },
        retiredCleanupRecords: {
          load: jest.fn(async () => retiredCleanup),
          save: jest.fn(async record => { retiredCleanup = record; }),
        },
      },
    );

    await handler.handle({ projectId: 'project-a', retiredAt: RETIRED_AT }, 'event');

    expect(resume).toHaveBeenCalledWith('project-a');
    expect(store.retirement?.cleanupStatus).toBe('complete');
    expect(retiredCleanup).toMatchObject({ operationId: pending.operationId });
  });
});

function cleanupPort(order: string[]): jest.Mocked<LocalProjectCleanupPort> {
  return {
    cleanup: jest.fn(async (_intent, _options) => {
      order.push('cleanup');
      return {
        filesPreserved: true,
        gitDataRemoved: true as const,
        markerRetained: true,
        status: 'complete' as const,
      };
    }),
    finalizeRetiredChoice: jest.fn(),
    completeRetiredFinalization: jest.fn(),
    resume: jest.fn(),
  };
}

function pendingRecord(): RetirementRecord {
  return {
    acknowledgedAt: null,
    acknowledgementStatus: 'pending',
    cleanupOperationId: 'retire-local-one',
    cleanupStatus: 'pending',
    createdAt: RETIRED_AT,
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.20:54545',
    kind: 'retirement',
    memberCredential: 'A'.repeat(43),
    memberId: 'member-a',
    projectId: 'project-a',
    retiredAt: RETIRED_AT,
    schemaVersion: 1,
    updatedAt: RETIRED_AT,
  };
}

function pendingLeaveRecord(): PendingLeaveRecord {
  return {
    authorityReplay: null,
    cleanupChoice: 'keep-files',
    cleanupMarkerNonce: 'n'.repeat(43),
    createdAt: RETIRED_AT,
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.20:54545',
    idempotencyKey: 'leave-one',
    kind: 'pending-leave',
    localCleanupComplete: true,
    localRole: 'member',
    memberCredential: 'A'.repeat(43),
    memberId: 'member-a',
    operationId: 'leave-one',
    phase: 'queued',
    projectCreatedAt: '2026-08-12T00:00:00.000Z',
    projectId: 'project-a',
    projectName: 'Alpha',
    schemaVersion: 2,
    updatedAt: RETIRED_AT,
    workspacePath: 'workspace/project-a',
  };
}

function completedLeaveCleanupRecord(): LocalCleanupRecord {
  const pending = pendingLeaveRecord();
  return {
    choice: pending.cleanupChoice,
    createdAt: pending.createdAt,
    kind: 'local-cleanup',
    markerNonce: pending.cleanupMarkerNonce,
    memberId: pending.memberId,
    operationId: pending.operationId,
    phase: 'complete',
    projectId: pending.projectId,
    purpose: 'leave',
    schemaVersion: 1,
    updatedAt: pending.updatedAt,
    workspacePath: pending.workspacePath,
  };
}

class MemoryProjectionStore implements RetirementClientProjectionStore {
  lastProjectionSeed: CollabRetiredProjectProjectionSeed | undefined;
  membership: CollabLocalMembershipRecord | null = membership();
  projectLifecycle: 'active' | 'retired' = 'active';
  retirement: RetirementRecord | null = null;
  transitionCount = 0;

  constructor(private readonly order: string[]) {}

  async loadMembership(): Promise<CollabLocalMembershipRecord | null> {
    return this.membership;
  }

  async loadRetirementRecord(): Promise<RetirementRecord | null> {
    return this.retirement;
  }

  async removeRetirementAcknowledgement(): Promise<boolean> {
    return false;
  }

  async loadWorkspacePath(): Promise<string | null> {
    return 'workspace/project-a';
  }

  async transitionProjectToRetired(
    record: RetirementRecord,
    projectionSeed?: CollabRetiredProjectProjectionSeed,
  ): Promise<void> {
    if (this.projectLifecycle === 'retired') return;
    if (!this.membership && !projectionSeed) throw new Error('missing projection seed');
    this.lastProjectionSeed = projectionSeed;
    this.order.push('persist');
    this.transitionCount += 1;
    this.retirement = record;
    this.membership = null;
    this.projectLifecycle = 'retired';
  }

  async updateRetirementRecord(
    _projectId: string,
    update: (record: RetirementRecord) => RetirementRecord,
  ): Promise<RetirementRecord> {
    if (!this.retirement) throw new Error('missing retirement');
    this.retirement = update(this.retirement);
    this.order.push(this.retirement.cleanupStatus);
    return this.retirement;
  }
}

function membership(): CollabLocalMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:54545',
      gitRemoteUrl: 'https://192.168.1.20:54545/v1/git/project-a/repository.git',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: RETIRED_AT,
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      credential: 'A'.repeat(43),
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'member',
    },
    project: { id: 'project-a', name: 'Alpha', workspacePath: 'workspace/project-a' },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: RETIRED_AT,
  };
}
