import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabHostTransferService } from '@/app/collab/host-transfer/CollabHostTransferService';
import {
  hostTransferAcceptanceIdempotencyKey,
} from '@/app/collab/host-transfer/HostTransferOperationIdentity';
import type { IncomingHostTransferCoordinator } from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';

const membership = {
  authority: {
    endpoint: 'https://192.168.1.10:27001',
    gitRemoteUrl: 'https://192.168.1.10:27001/v1/git/project-a/repository.git',
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'a'.repeat(64),
    kind: 'lan' as const,
  },
  createdAt: '2026-08-13T00:00:00.000Z',
  hostOwnership: { ownsAuthority: false },
  lastEventSequence: 1,
  member: {
    credential: Buffer.alloc(32, 1).toString('base64url'),
    displayName: 'Target',
    id: 'member-target',
    personalRef: 'refs/heads/members/member-target',
    role: 'member' as const,
  },
  project: { id: 'project-a', name: 'Project A', workspacePath: 'workspace/a' },
  schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
  updatedAt: '2026-08-13T00:00:00.000Z',
} satisfies CollabLocalLanMembershipRecord;

const snapshot = {
  snapshot: {
    currentMember: { ...membership.member, createdAt: membership.createdAt, status: 'active' },
    eventSequence: 1,
    hostTransfer: {
      canAccept: true,
      canCancel: false,
      canDecline: true,
      expiresAt: '2026-08-13T00:10:00.000Z',
      offeredAt: '2026-08-13T00:00:00.000Z',
      phase: 'offered',
      targetMemberId: 'member-target',
      transferId: 'transfer-a',
    },
    members: [],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan',
      createdAt: '2026-08-13T00:00:00.000Z',
      hostMemberId: 'member-source',
      id: 'project-a',
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      managerSetGeneration: 0,
      name: 'Project A',
    },
    ticketHighlights: [],
  },
  source: 'online' as const,
  stale: false,
  syncState: { eventSequence: 1, generation: 1, projectId: 'project-a', status: 'synchronized' as const },
};

describe('CollabHostTransferService', () => {
  function create(useInjectedIdempotency = true) {
    const control = {
      accept: jest.fn().mockResolvedValue(snapshot.snapshot.hostTransfer),
      cancel: jest.fn().mockResolvedValue(snapshot.snapshot.hostTransfer),
      create: jest.fn().mockResolvedValue(snapshot.snapshot.hostTransfer),
      decline: jest.fn().mockResolvedValue(snapshot.snapshot.hostTransfer),
    };
    const incoming = {
      accept: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<
      IncomingHostTransferCoordinator,
      'accept' | 'close' | 'resume'
    >>;
    const projects = {
      loadIndex: jest.fn().mockResolvedValue({ projects: [{ id: 'project-a' }] }),
      loadMembership: jest.fn().mockResolvedValue(membership),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue({
        direction: 'incoming',
        projectId: 'project-a',
      }),
    };
    const projectRecoveryAdmission = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());
    const resumeOutgoing = jest.fn().mockResolvedValue(undefined);
    const resumeCompletedOutgoing = jest.fn().mockResolvedValue(undefined);
    const snapshots = { readCoordinationSnapshot: jest.fn().mockResolvedValue(snapshot) };
    const serviceOptions = {
      createControlClient: () => control,
      ...(useInjectedIdempotency
        ? { createIdempotencyKey: (kind: string) => `${kind}-key` }
        : {}),
      createIncomingCoordinator: () => incoming,
      projects,
      recovery,
      resumeCompletedOutgoing,
      resumeOutgoing,
      snapshots,
      projectRecoveryAdmission,
    };
    const service = new CollabHostTransferService(serviceOptions);
    return {
      control,
      incoming,
      projectRecoveryAdmission,
      projects,
      recovery,
      resumeCompletedOutgoing,
      resumeOutgoing,
      service,
      snapshots,
    };
  }

  it('creates an offer using the fresh authority Host identity', async () => {
    const { control, service } = create();

    await service.createHostTransfer({ projectId: 'project-a', targetMemberId: 'member-target' });

    expect(control.create).toHaveBeenCalledWith(expect.objectContaining({
      memberCredential: membership.member.credential,
      request: {
        expectedHostMemberId: 'member-source',
        idempotencyKey: 'create-host-transfer-key',
        projectId: 'project-a',
        targetMemberId: 'member-target',
      },
    }));
  });

  it('accepts through the incoming coordinator so provisional preparation precedes authority Accept', async () => {
    const { control, incoming, service } = create();

    await service.acceptHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });

    expect(incoming.accept).toHaveBeenCalledWith({
      idempotencyKey: hostTransferAcceptanceIdempotencyKey(
        'project-a',
        'transfer-a',
        'member-target',
      ),
      projectId: 'project-a',
      sourceHostMemberId: 'member-source',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-a',
    });
    expect(control.accept).not.toHaveBeenCalled();
  });

  it('replays an accepted transfer from the exact durable incoming recovery', async () => {
    const { incoming, recovery, service, snapshots } = create();
    recovery.load.mockResolvedValue({
      direction: 'incoming',
      phase: 'accepted',
      projectId: 'project-a',
      sourceHostMemberId: 'member-source',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-a',
    });
    const accepted = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        hostTransfer: {
          ...snapshot.snapshot.hostTransfer,
          canAccept: false,
          canDecline: false,
          phase: 'accepted' as const,
        },
      },
    };
    snapshots.readCoordinationSnapshot.mockResolvedValue(accepted);

    await service.acceptHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });

    expect(incoming.accept).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: hostTransferAcceptanceIdempotencyKey(
        'project-a',
        'transfer-a',
        'member-target',
      ),
      transferId: 'transfer-a',
    }));
  });

  it('derives the same acceptance operation identity after service reconstruction', async () => {
    const first = create(false);
    const second = create(false);

    await first.service.acceptHostTransfer({
      projectId: 'project-a',
      transferId: 'transfer-a',
    });
    await second.service.acceptHostTransfer({
      projectId: 'project-a',
      transferId: 'transfer-a',
    });

    const firstKey = first.incoming.accept.mock.calls[0]?.[0].idempotencyKey;
    const secondKey = second.incoming.accept.mock.calls[0]?.[0].idempotencyKey;
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^accept-host-transfer-[a-f0-9]{64}$/);
  });

  it('declines and cancels with fresh expected actor identities', async () => {
    const { control, service } = create();

    await service.declineHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });
    await service.cancelHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });

    expect(control.decline).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ expectedTargetMemberId: 'member-target' }),
    }));
    expect(control.cancel).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ expectedHostMemberId: 'member-source' }),
    }));
  });

  it('restores incoming provisional state during nonblocking startup recovery', async () => {
    const { incoming, projectRecoveryAdmission, service } = create();

    await service.resume();

    expect(projectRecoveryAdmission).toHaveBeenCalledWith(
      'project-a',
      expect.any(Function),
    );
    expect(incoming.resume).toHaveBeenCalledWith('project-a');
  });

  it('does not touch Host state when Project recovery admission fails closed', async () => {
    const { incoming, projectRecoveryAdmission, service } = create();
    projectRecoveryAdmission.mockRejectedValueOnce(new Error('ambiguous lifecycle owners'));

    await expect(service.resume()).rejects.toThrow('ambiguous lifecycle owners');

    expect(incoming.resume).not.toHaveBeenCalled();
  });

  it('finishes completed outgoing recovery without reopening deleted authority', async () => {
    const {
      incoming,
      recovery,
      resumeCompletedOutgoing,
      resumeOutgoing,
      service,
    } = create();
    recovery.load.mockImplementation(async (_projectId, direction) => (
      direction === 'outgoing'
        ? {
          activationCertificate: JSON.stringify({}),
          createdAt: '2026-08-13T00:00:00.000Z',
          direction: 'outgoing',
          kind: 'host-transfer-recovery',
          manifestDigest: 'c'.repeat(64),
          phase: 'completed',
          projectId: 'project-a',
          receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
          receiverCredentialHash: null,
          schemaVersion: 1,
          sourceHostMemberId: 'member-source',
          stagingDirectoryName: null,
          targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
          targetCaFingerprint: 'a'.repeat(64),
          targetEndpoint: 'https://192.168.1.10:27001',
          targetHostMemberId: 'member-target',
          targetTerminalResponseReceived: true,
          transferId: 'transfer-a',
          updatedAt: '2026-08-13T00:00:00.000Z',
        }
        : null
    ));

    await service.resume();

    expect(resumeCompletedOutgoing).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'outgoing',
      phase: 'completed',
      projectId: 'project-a',
      transferId: 'transfer-a',
    }));
    expect(resumeOutgoing).not.toHaveBeenCalled();
    expect(incoming.resume).not.toHaveBeenCalled();
  });

  it('continues restoring other Projects after one transfer recovery fails', async () => {
    const { incoming, projects, recovery, service } = create();
    projects.loadIndex.mockResolvedValue({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
    });
    recovery.load.mockImplementation(async (projectId, direction) => (
      direction === 'incoming' ? { direction, projectId } : null
    ));
    projects.loadMembership.mockImplementation(async projectId => ({
      ...membership,
      project: { ...membership.project, id: projectId },
    }));
    incoming.resume
      .mockRejectedValueOnce(new Error('first recovery failed'))
      .mockResolvedValueOnce(undefined);

    await expect(service.resume()).rejects.toThrow('first recovery failed');

    expect(incoming.resume).toHaveBeenNthCalledWith(1, 'project-a');
    expect(incoming.resume).toHaveBeenNthCalledWith(2, 'project-b');
  });

  it('closes every owned incoming coordinator exactly once', async () => {
    const { incoming, service } = create();
    await service.acceptHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });

    await service.close();
    await service.close();

    expect(incoming.close).toHaveBeenCalledTimes(1);
  });

  it('replaces and closes an incoming coordinator when its authority identity changes', async () => {
    const first = {
      accept: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    const second = {
      accept: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    const harness = create();
    const createIncomingCoordinator = jest.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new CollabHostTransferService({
      createControlClient: () => harness.control,
      createIncomingCoordinator,
      projects: harness.projects,
      projectRecoveryAdmission: async (_projectId, operation) => operation(),
      recovery: harness.recovery,
      snapshots: harness.snapshots,
    });

    await service.acceptHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });
    harness.projects.loadMembership.mockResolvedValue({
      ...membership,
      authority: {
        ...membership.authority,
        endpoint: 'https://192.168.1.11:27001',
      },
    });
    await service.acceptHostTransfer({ projectId: 'project-a', transferId: 'transfer-a' });

    expect(createIncomingCoordinator).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.accept).toHaveBeenCalledTimes(1);
    expect(second.accept).toHaveBeenCalledTimes(1);
    await service.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('waits for an admitted incoming coordinator construction before close completes', async () => {
    let finishConstruction!: (value: typeof incoming) => void;
    let markConstructionStarted!: () => void;
    const incoming = {
      accept: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    const construction = new Promise<typeof incoming>(resolve => {
      finishConstruction = resolve;
    });
    const constructionStarted = new Promise<void>(resolve => {
      markConstructionStarted = resolve;
    });
    const harness = create();
    const service = new CollabHostTransferService({
      createControlClient: () => harness.control,
      createIncomingCoordinator: () => {
        markConstructionStarted();
        return construction;
      },
      projects: harness.projects,
      projectRecoveryAdmission: async (_projectId, operation) => operation(),
      recovery: harness.recovery,
      snapshots: harness.snapshots,
    });

    const accepting = service.acceptHostTransfer({
      projectId: 'project-a',
      transferId: 'transfer-a',
    });
    await constructionStarted;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishConstruction(incoming);
    await expect(closing).resolves.toBeUndefined();
    expect(incoming.close).toHaveBeenCalledTimes(1);
    await expect(accepting).resolves.toBeUndefined();
    await expect(service.acceptHostTransfer({
      projectId: 'project-a', transferId: 'transfer-a',
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-transfer-service-closed' },
    });
  });
});
