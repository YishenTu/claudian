import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { LocalExitProjectStorePort } from '@/app/collab/exit/LocalExitStores';
import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import {
  type LocalExitActivityPort,
  type LocalExitAuthorityPort,
  LocalProjectExitCoordinator,
} from '@/app/collab/exit/LocalProjectExitCoordinator';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import { PendingLeaveWorker } from '@/app/collab/exit/PendingLeaveWorker';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type {
  CollabMembershipManagerReceiptPort,
} from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { type CollabLocalCleanupStatus } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = '2026-08-13T00:00:00.000Z';

function membership(
  role: 'manager' | 'member' = 'member',
  ownsAuthority = false,
): CollabLocalMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: 'https://192.168.1.10:54545/v1/git/project-alpha/repository.git',
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: NOW,
    hostOwnership: { ownsAuthority },
    lastEventSequence: 1,
    lifecycle: 'active',
    member: {
      credential: 'c'.repeat(43),
      displayName: 'Alice',
      id: 'member-alpha',
      personalRef: 'refs/heads/members/member-alpha',
      role,
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

class MemoryPendingLeaveStore {
  readonly records = new Map<string, PendingLeaveRecord>();

  async list(): Promise<readonly PendingLeaveRecord[]> {
    return [...this.records.values()];
  }

  async load(projectId: string): Promise<PendingLeaveRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async save(record: PendingLeaveRecord): Promise<void> {
    this.records.set(record.projectId, record);
  }

  async remove(projectId: string): Promise<boolean> {
    return this.records.delete(projectId);
  }
}

function setup(
  record = membership(),
  order: string[] = [],
  retirement?: { handle: jest.Mock },
): {
  activity: jest.Mocked<LocalExitActivityPort>;
  authority: jest.Mocked<LocalExitAuthorityPort>;
  cleanup: jest.Mocked<LocalProjectCleanupPort>;
  coordinator: LocalProjectExitCoordinator;
  managerReceipts: jest.Mocked<Pick<CollabMembershipManagerReceiptPort, 'load'>>;
  managerResponsibilityOperations: ManagerResponsibilityOperationCoordinator;
  pending: MemoryPendingLeaveStore;
  projects: jest.Mocked<LocalExitProjectStorePort>;
} {
  const pending = new MemoryPendingLeaveStore();
  const managerReceipts: jest.Mocked<Pick<CollabMembershipManagerReceiptPort, 'load'>> = {
    load: jest.fn(async (_projectId: string) => null),
  };
  const managerResponsibilityOperations = new ManagerResponsibilityOperationCoordinator();
  const projects: jest.Mocked<LocalExitProjectStorePort> = {
    loadMembership: jest.fn(async (_projectId: string) => record),
    markLeaving: jest.fn(async (
      _projectId: string,
      _cleanupStatus: CollabLocalCleanupStatus,
    ) => undefined),
    removeProject: jest.fn(async (_projectId: string) => undefined),
    purgePrivateState: jest.fn(async (_projectId: string) => undefined),
    restoreActive: jest.fn(async (_projectId: string) => undefined),
  };
  const authority: jest.Mocked<LocalExitAuthorityPort> = {
    prepareLeave: jest.fn(async input => ({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: input.managerResponsibilityOfferId ?? null,
      },
      memberRole: record.member.role,
    })),
    refreshLeave: jest.fn(async _input => ({
      authorityReplay: {
        expectedHostMemberId: 'member-host-current',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      memberRole: record.member.role,
    })),
    resolveLeaveHost: jest.fn(async input => {
      throw input.failure;
    }),
    settleLeave: jest.fn(async (_input): Promise<MembershipTerminationResponse> => {
      order.push('authority');
      return {
        discardedRequestId: null,
        memberId: 'member-alpha',
        projectId: 'project-alpha',
        status: 'left',
      };
    }),
  };
  const cleanup: jest.Mocked<LocalProjectCleanupPort> = {
    cleanup: jest.fn(async (_intent, _options) => {
      order.push('cleanup');
      return {
        filesPreserved: true,
        gitDataRemoved: true as const,
        markerRetained: false,
        status: 'complete' as const,
      };
    }),
    finalizeRetiredChoice: jest.fn(),
    completeRetiredFinalization: jest.fn(),
    resume: jest.fn(),
  };
  const suspension = { projectId: 'project-alpha', token: Symbol('leave-suspension') };
  const activity: jest.Mocked<LocalExitActivityPort> = {
    completeProject: jest.fn(async (_suspension) => undefined),
    resumeProject: jest.fn(async (_suspension) => undefined),
    suspendProject: jest.fn(async (_projectId) => suspension),
  };
  return {
    activity,
    authority,
    cleanup,
    coordinator: new LocalProjectExitCoordinator(
      projects,
      pending,
      authority,
      cleanup,
      activity,
      {
        createOperationId: () => 'leave-stable',
        managerReceipts,
        managerResponsibilityOperations,
        now: () => new Date(NOW),
        ...(retirement ? { retirement } : {}),
      },
    ),
    managerReceipts,
    managerResponsibilityOperations,
    pending,
    projects,
  };
}

function legacyManagerLeave(
  managerResponsibilityOfferId: string | null = 'offer-legacy',
): PendingLeaveRecord {
  return {
    authorityReplay: {
      expectedHostMemberId: 'member-host',
      idempotencyManagerMemberId: 'member-alpha',
      managerResponsibilityOfferId,
    },
    cleanupChoice: 'keep-files',
    cleanupMarkerNonce: 'n'.repeat(43),
    createdAt: NOW,
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.10:54545',
    idempotencyKey: 'leave-legacy',
    kind: 'pending-leave',
    localCleanupComplete: false,
    localRole: 'manager',
    memberCredential: 'c'.repeat(43),
    memberId: 'member-alpha',
    operationId: 'leave-legacy',
    phase: 'recovery-required',
    projectCreatedAt: NOW,
    projectName: 'Alpha',
    projectId: 'project-alpha',
    schemaVersion: 2,
    updatedAt: NOW,
    workspacePath: 'workspace/project-alpha',
  };
}

function currentManagerLeave(
  managerResponsibilityOfferId: string | null,
): PendingLeaveRecord {
  return {
    ...legacyManagerLeave(managerResponsibilityOfferId),
    authorityReplay: {
      expectedHostMemberId: 'member-host',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId,
    },
    idempotencyKey: 'leave-current',
    operationId: 'leave-current',
  };
}

describe('LocalProjectExitCoordinator', () => {
  it('settles online authority before closing activity and cleaning local files', async () => {
    const order: string[] = [];
    const { activity, authority, cleanup, coordinator, pending, projects } = setup(
      membership(),
      order,
    );

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'complete' });

    expect(order).toEqual(['authority', 'cleanup']);
    expect(activity.suspendProject).toHaveBeenCalledWith('project-alpha');
    expect(activity.completeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-alpha',
    }));
    expect(activity.resumeProject).not.toHaveBeenCalled();
    expect(projects.removeProject).toHaveBeenCalledWith('project-alpha');
    expect(projects.purgePrivateState).toHaveBeenCalledWith('project-alpha');
    expect(pending.records.size).toBe(0);
    expect(authority.settleLeave).toHaveBeenCalledWith(expect.objectContaining({
      pending: expect.objectContaining({
        authorityReplay: {
          expectedHostMemberId: 'member-host',
          idempotencyManagerMemberId: null,
          managerResponsibilityOfferId: null,
        },
        idempotencyKey: 'leave-stable',
      }),
    }));
    expect(cleanup.cleanup).toHaveBeenCalledWith(expect.objectContaining({
      choice: 'keep-files',
      operationId: 'leave-stable',
    }), {});
  });

  it('persists verified moved-Host continuity before retrying a credentialed read', async () => {
    const { authority, coordinator, pending } = setup();
    authority.resolveLeaveHost.mockResolvedValueOnce({
      caCertificatePem: '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n',
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://10.0.0.8:54545',
      projectId: 'project-alpha',
    });
    authority.prepareLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));
    authority.prepareLeave.mockImplementationOnce(async input => {
      expect(input.pending).toMatchObject({
        hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n',
        hostCaFingerprint: 'b'.repeat(64),
        hostEndpoint: 'https://10.0.0.8:54545',
      });
      expect(pending.records.get('project-alpha')).toMatchObject({
        hostCaFingerprint: 'b'.repeat(64),
        hostEndpoint: 'https://10.0.0.8:54545',
      });
      return {
        authorityReplay: {
          expectedHostMemberId: 'member-host',
          idempotencyManagerMemberId: null,
          managerResponsibilityOfferId: null,
        },
        memberRole: 'member',
      };
    });

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'complete' });

    expect(authority.resolveLeaveHost).toHaveBeenCalledWith(expect.objectContaining({
      failure: expect.objectContaining({ code: 'endpoint-unreachable' }),
      pending: expect.objectContaining({ hostCaFingerprint: 'a'.repeat(64) }),
    }));
    expect(authority.prepareLeave).toHaveBeenCalledTimes(2);
  });

  it('queues an ordinary offline Leave and performs local cleanup', async () => {
    const { authority, cleanup, coordinator, pending, projects } = setup();
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));

    await expect(coordinator.leave({
      cleanupChoice: 'delete-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'queued' });

    expect(pending.records.get('project-alpha')).toMatchObject({
      idempotencyKey: 'leave-stable',
      localCleanupComplete: true,
      phase: 'queued',
    });
    expect(cleanup.cleanup).toHaveBeenCalled();
    expect(projects.removeProject).toHaveBeenCalled();
    expect(projects.purgePrivateState).toHaveBeenCalledWith('project-alpha');
    expect(projects.loadMembership).toHaveBeenCalledTimes(2);
  });

  it('does not clean up offline when authority reports a newly promoted Manager', async () => {
    const { authority, cleanup, coordinator, pending, projects } = setup();
    authority.prepareLeave.mockResolvedValueOnce({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      memberRole: 'manager',
    });
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));

    await expect(coordinator.leave({
      cleanupChoice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'endpoint-unreachable' });

    expect(pending.records.get('project-alpha')).toMatchObject({
      localCleanupComplete: false,
      localRole: 'manager',
      phase: 'recovery-required',
    });
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(projects.removeProject).not.toHaveBeenCalled();
    expect(projects.purgePrivateState).not.toHaveBeenCalled();
  });

  it('does not trust a cached Member role while a Manager receipt is unresolved', async () => {
    const {
      authority,
      cleanup,
      coordinator,
      managerReceipts,
      projects,
    } = setup();
    managerReceipts.load.mockResolvedValueOnce({
      offerId: 'offer-promotion',
      status: 'acknowledged',
    });
    authority.prepareLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));

    await expect(coordinator.leave({
      cleanupChoice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'endpoint-unreachable' });

    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(projects.removeProject).not.toHaveBeenCalled();
    expect(projects.purgePrivateState).not.toHaveBeenCalled();
  });

  it('waits for an in-flight Manager acknowledgement before offline cleanup', async () => {
    const {
      authority,
      cleanup,
      coordinator,
      managerReceipts,
      managerResponsibilityOperations,
    } = setup();
    authority.prepareLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));
    let releaseAcknowledgement!: () => void;
    const acknowledgementGate = new Promise<void>(resolve => {
      releaseAcknowledgement = resolve;
    });
    const acknowledgement = managerResponsibilityOperations.run(
      'project-alpha',
      async () => {
        await acknowledgementGate;
        managerReceipts.load.mockResolvedValue({
          offerId: 'offer-promotion',
          status: 'acknowledged',
        });
      },
    );
    const leave = coordinator.leave({
      cleanupChoice: 'delete-files',
      projectId: 'project-alpha',
    });
    await Promise.resolve();

    expect(authority.prepareLeave).not.toHaveBeenCalled();
    releaseAcknowledgement();
    await acknowledgement;
    await expect(leave).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    expect(cleanup.cleanup).not.toHaveBeenCalled();
  });

  it('rechecks the durable Member role after draining snapshot reconciliation', async () => {
    const {
      activity,
      authority,
      cleanup,
      coordinator,
      projects,
    } = setup();
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));
    activity.suspendProject.mockImplementationOnce(async () => {
      projects.loadMembership.mockResolvedValue(membership('manager'));
      return { projectId: 'project-alpha', token: Symbol('drain-role-change') };
    });

    await expect(coordinator.leave({
      cleanupChoice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'manager-responsibility-pending',
      safeContext: { reason: 'offline-leave-role-not-confirmed-member' },
    });

    expect(activity.suspendProject).toHaveBeenCalledWith('project-alpha');
    expect(activity.resumeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-alpha',
    }));
    expect(activity.completeProject).not.toHaveBeenCalled();
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(projects.removeProject).not.toHaveBeenCalled();
    expect(projects.purgePrivateState).not.toHaveBeenCalled();
  });

  it('retains exact Manager recovery after an uncertain authority outcome', async () => {
    const manager = setup(membership('manager'));
    manager.authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'endpoint-unreachable',
    }));

    await expect(manager.coordinator.leave({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: 'offer-one',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    expect(manager.pending.records.get('project-alpha')).toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: 'offer-one',
      },
      localCleanupComplete: false,
      phase: 'recovery-required',
    });
    expect(manager.cleanup.cleanup).not.toHaveBeenCalled();

    const host = setup(membership('manager', true));
    await expect(host.coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'host-transfer-pending' });
    expect(host.authority.settleLeave).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-offer-not-found' },
      }),
      offerId: 'offer-legacy',
    },
    {
      error: new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'membership-manager-successor-required' },
      }),
      offerId: null,
    },
    {
      error: new CollabError({
        code: 'stale-project-selection',
        safeContext: { reason: 'manager-responsibility-generation-changed' },
      }),
      offerId: 'offer-legacy',
    },
  ])('clears obsolete legacy Manager Leave intent after deterministic offer rejection', async ({
    error,
    offerId,
  }) => {
    const { authority, cleanup, coordinator, pending, projects } = setup(
      membership('manager'),
    );
    await pending.save(legacyManagerLeave(offerId));
    authority.settleLeave.mockRejectedValueOnce(error);

    await expect(coordinator.resume('project-alpha')).rejects.toBe(error);

    expect(projects.restoreActive).toHaveBeenCalledTimes(1);
    expect(projects.restoreActive).toHaveBeenCalledWith('project-alpha');
    expect(pending.records.has('project-alpha')).toBe(false);
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(authority.refreshLeave).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'membership-manager-successor-required' },
      }),
      offerId: null,
    },
    {
      error: new CollabError({
        code: 'stale-project-selection',
        safeContext: { reason: 'manager-responsibility-offer-not-acknowledged' },
      }),
      offerId: 'offer-cancelled',
    },
  ])('clears a current Manager Leave intent after deterministic offer rejection', async ({
    error,
    offerId,
  }) => {
    const { authority, cleanup, coordinator, pending, projects } = setup(
      membership('manager'),
    );
    await pending.save(currentManagerLeave(offerId));
    authority.settleLeave.mockRejectedValueOnce(error);

    await expect(coordinator.resume('project-alpha')).rejects.toBe(error);

    expect(projects.restoreActive).toHaveBeenCalledWith('project-alpha');
    expect(pending.records.has('project-alpha')).toBe(false);
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(authority.refreshLeave).not.toHaveBeenCalled();
  });

  it('retains legacy Manager Leave intent when authority settlement is ambiguous', async () => {
    const { authority, cleanup, coordinator, pending, projects } = setup(
      membership('manager'),
    );
    await pending.save(legacyManagerLeave());
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'operation-timeout',
    }));

    await expect(coordinator.resume('project-alpha')).rejects.toMatchObject({
      code: 'operation-timeout',
    });

    expect(pending.records.get('project-alpha')).toMatchObject({
      authorityReplay: {
        idempotencyManagerMemberId: 'member-alpha',
        managerResponsibilityOfferId: 'offer-legacy',
      },
      phase: 'recovery-required',
    });
    expect(projects.restoreActive).not.toHaveBeenCalled();
    expect(cleanup.cleanup).not.toHaveBeenCalled();
  });

  it('retains exact replay after committed Leave cleanup fails', async () => {
    const { authority, cleanup, coordinator, pending } = setup();
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'membership-termination-cleanup-failed' },
    }));

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });

    expect(pending.records.get('project-alpha')).toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: null,
      },
      localCleanupComplete: false,
      phase: 'recovery-required',
    });
    expect(cleanup.cleanup).not.toHaveBeenCalled();

    await expect(coordinator.resume('project-alpha')).resolves.toEqual({ status: 'complete' });
    expect(authority.settleLeave).toHaveBeenCalledTimes(2);
    expect(cleanup.cleanup).toHaveBeenCalledTimes(1);
    expect(pending.records.has('project-alpha')).toBe(false);
  });

  it('forwards a newly acknowledged Manager responsibility before mutation preparation', async () => {
    const { authority, coordinator, pending } = setup(membership('manager'));
    await pending.save({
      authorityReplay: null,
      cleanupChoice: 'keep-files',
      cleanupMarkerNonce: 'n'.repeat(43),
      createdAt: NOW,
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      hostCaFingerprint: 'a'.repeat(64),
      hostEndpoint: 'https://192.168.1.10:54545',
      idempotencyKey: 'leave-stable',
      kind: 'pending-leave',
      localCleanupComplete: false,
      localRole: 'manager',
      memberCredential: 'c'.repeat(43),
      memberId: 'member-alpha',
      operationId: 'leave-stable',
      phase: 'queued',
      projectCreatedAt: NOW,
      projectName: 'Alpha',
      projectId: 'project-alpha',
      schemaVersion: 2,
      updatedAt: NOW,
      workspacePath: 'workspace/project-alpha',
    });

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: 'offer-two',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'complete' });
    expect(authority.settleLeave).toHaveBeenLastCalledWith(expect.objectContaining({
      pending: expect.objectContaining({
        authorityReplay: expect.objectContaining({
          managerResponsibilityOfferId: 'offer-two',
        }),
      }),
    }));
  });

  it('does not duplicate a confirmed authority mutation when cleanup is retried', async () => {
    const { authority, cleanup, coordinator, pending, projects } = setup();
    cleanup.cleanup
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockResolvedValueOnce({
        filesPreserved: true,
        gitDataRemoved: true,
        markerRetained: false,
        status: 'complete',
      });

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'EPERM' });
    expect(pending.records.get('project-alpha')?.phase).toBe('confirmed');
    expect(projects.markLeaving).toHaveBeenLastCalledWith('project-alpha', 'failed');

    await expect(coordinator.resume('project-alpha')).resolves.toEqual({ status: 'complete' });
    expect(authority.settleLeave).toHaveBeenCalledTimes(1);
    expect(cleanup.cleanup).toHaveBeenCalledTimes(2);
  });

  it('settles a lost-response offline Leave with the same mutation identity after restart', async () => {
    const { authority, coordinator, pending } = setup();
    authority.settleLeave
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce({
        discardedRequestId: null,
        memberId: 'member-alpha',
        projectId: 'project-alpha',
        status: 'left',
      });
    await coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    });
    const worker = new PendingLeaveWorker(pending, coordinator);

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: ['project-alpha'],
      failed: [],
    });
    expect(authority.settleLeave).toHaveBeenCalledTimes(2);
    expect(authority.settleLeave.mock.calls.map(call => call[0].pending.idempotencyKey))
      .toEqual(['leave-stable', 'leave-stable']);
    expect(authority.prepareLeave).toHaveBeenCalledTimes(1);
    expect(pending.records.size).toBe(0);
  });

  it('retains a prepared Manager Leave after timeout and resumes its exact accepted offer', async () => {
    const { authority, cleanup, coordinator, pending } = setup(membership('manager'));
    authority.settleLeave
      .mockRejectedValueOnce(new CollabError({ code: 'operation-timeout' }))
      .mockResolvedValueOnce({
        discardedRequestId: null,
        memberId: 'member-alpha',
        projectId: 'project-alpha',
        status: 'left',
      });

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: 'offer-accepted',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'operation-timeout' });

    expect(pending.records.get('project-alpha')).toMatchObject({
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: null,
        managerResponsibilityOfferId: 'offer-accepted',
      },
      phase: 'recovery-required',
    });
    expect(cleanup.cleanup).not.toHaveBeenCalled();

    await expect(coordinator.resume('project-alpha')).resolves.toEqual({ status: 'complete' });

    expect(authority.prepareLeave).toHaveBeenCalledTimes(1);
    expect(authority.settleLeave).toHaveBeenCalledTimes(2);
    expect(authority.settleLeave.mock.calls[1]?.[0].pending.authorityReplay).toEqual({
      expectedHostMemberId: 'member-host',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: 'offer-accepted',
    });
    expect(cleanup.cleanup).toHaveBeenCalledTimes(1);
    expect(pending.records.size).toBe(0);
  });

  it('retries an offline Leave after Project-private state has been purged', async () => {
    const { authority, cleanup, coordinator, pending, projects } = setup();
    authority.settleLeave
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce({
        discardedRequestId: null,
        memberId: 'member-alpha',
        projectId: 'project-alpha',
        status: 'left',
      });

    await coordinator.leave({ cleanupChoice: 'keep-files', projectId: 'project-alpha' });
    projects.loadMembership.mockResolvedValue(null);
    cleanup.cleanup.mockClear();

    await expect(coordinator.resume('project-alpha')).resolves.toEqual({ status: 'complete' });

    expect(authority.settleLeave).toHaveBeenCalledTimes(2);
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(pending.records.size).toBe(0);
  });

  it('hands an authority Retirement to the one terminal handler and supersedes Leave', async () => {
    const retirement = { handle: jest.fn(async () => undefined) };
    const { authority, cleanup, coordinator, pending, projects } = setup(
      membership(),
      [],
      retirement,
    );
    authority.settleLeave.mockRejectedValueOnce(new CollabError({
      code: 'project-retired',
      safeContext: {
        projectId: 'project-alpha',
        retiredAt: NOW,
      },
    }));

    await expect(coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({ status: 'complete' });

    expect(retirement.handle).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      retiredAt: NOW,
    }, 'terminal-fallback');
    expect(cleanup.cleanup).not.toHaveBeenCalled();
    expect(projects.removeProject).not.toHaveBeenCalled();
    expect(pending.records.size).toBe(1);
  });

  it('retains a recovery-required record when authority reports a later responsibility conflict', async () => {
    const { authority, coordinator, pending, projects } = setup();
    authority.settleLeave
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockRejectedValueOnce(new CollabError({ code: 'stale-project-selection' }));
    authority.refreshLeave.mockRejectedValueOnce(new CollabError({
      code: 'authorization-denied',
    }));
    await coordinator.leave({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    });

    await expect(new PendingLeaveWorker(pending, coordinator).runOnce()).resolves.toEqual({
      attempted: ['project-alpha'],
      failed: ['project-alpha'],
    });
    expect(pending.records.get('project-alpha')?.phase).toBe('recovery-required');
    expect(projects.markLeaving).toHaveBeenLastCalledWith('project-alpha', 'failed');
  });

  it('persists fresh authority preconditions before retrying after Host transfer', async () => {
    const { authority, coordinator, pending } = setup();
    authority.settleLeave
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockRejectedValueOnce(new CollabError({ code: 'stale-project-selection' }))
      .mockResolvedValueOnce({
        discardedRequestId: null,
        memberId: 'member-alpha',
        projectId: 'project-alpha',
        status: 'left',
      });
    await coordinator.leave({ cleanupChoice: 'keep-files', projectId: 'project-alpha' });

    await expect(coordinator.resume('project-alpha')).resolves.toEqual({ status: 'complete' });

    expect(authority.refreshLeave).toHaveBeenCalledTimes(1);
    expect(authority.settleLeave).toHaveBeenNthCalledWith(3, expect.objectContaining({
      pending: expect.objectContaining({
        authorityReplay: {
          expectedHostMemberId: 'member-host-current',
          idempotencyManagerMemberId: null,
          managerResponsibilityOfferId: null,
        },
      }),
    }));
    expect(pending.records.size).toBe(0);
  });
});
