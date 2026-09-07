import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';

import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { HostTransferModule } from '@/app/collab/host-transfer/HostTransferModule';
import { createHostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecovery';
import { decodeHostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import { LanHostCoordinator } from '@/app/collab/lan/LanHostCoordinator';
import { LanAuthorityProjectionTransitionCoordinator } from '@/app/collab/LanAuthorityProjectionTransitionCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

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

const coordination = {
  snapshot: {
    currentMember: { ...membership.member, createdAt: membership.createdAt, status: 'active' },
    eventSequence: 1,
    members: [],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan',
      createdAt: membership.createdAt,
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
  syncState: {
    eventSequence: 1,
    generation: 1,
    projectId: 'project-a',
    status: 'synchronized' as const,
  },
};

describe('HostTransferModule', () => {
  function create(recoveryRecord: ReturnType<typeof createHostTransferRecoveryRecord> | null = null) {
    const control = {
      cancel: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      decline: jest.fn().mockResolvedValue(undefined),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue(recoveryRecord),
      remove: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const projects = {
      hostTransferRecovery: recovery,
      loadIndex: jest.fn().mockResolvedValue({
        projects: recoveryRecord ? [membership.project] : [],
      }),
      loadMembership: jest.fn().mockResolvedValue(membership),
    };
    const assertRecoveryOwner = jest.fn().mockResolvedValue(undefined);
    const projectRecoveryAdmission = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());
    const module = new HostTransferModule({
      activateTransferredAuthority: jest.fn(),
      authorityProjectionTransitions: new LanAuthorityProjectionTransitionCoordinator(),
      assertRecoveryOwner,
      bindTransferTarget: jest.fn(),
      finalizeOldAuthority: jest.fn(),
      installationKey: TEST_INSTALLATION_A,
      lanHost: {},
      projects,
      projectRecoveryAdmission,
      requireGitFoundation: jest.fn(),
      snapshots: { readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination) },
      workspace: {},
      createControlClient: () => control,
    } as never);
    return { assertRecoveryOwner, control, module, projectRecoveryAdmission, recovery };
  }

  it('exposes a Vault client service and independent per-Host runtime lifetimes', async () => {
    const { module, recovery } = create();
    const runtime = module.createOutgoingRuntime({
      accept: { recover: jest.fn() },
      authority: { authorityDirectory: '/authority', database: {} },
      git: {},
      hostTransfers: {},
      projectId: 'project-a',
      repositoryPath: '/repository.git',
    } as never);

    await module.clientService.close();

    await expect(runtime.inspectStartupRecovery()).resolves.toBe('none');
    expect(recovery.load).toHaveBeenCalledWith('project-a', 'outgoing');
    await runtime.close();
  });

  it('rejects foreign recovery before invoking coordinator effects', async () => {
    const record = createHostTransferRecoveryRecord({
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 2).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.11:27001',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    const { assertRecoveryOwner, module } = create(record);
    assertRecoveryOwner.mockRejectedValue(new Error('foreign recovery'));
    const recover = jest.fn();
    const runtime = module.createOutgoingRuntime({
      accept: { recover },
      authority: { authorityDirectory: '/authority', database: {} },
      git: {},
      hostTransfers: {},
      projectId: 'project-a',
      repositoryPath: '/repository.git',
    } as never);

    await expect(runtime.inspectStartupRecovery()).rejects.toThrow('foreign recovery');
    expect(assertRecoveryOwner).toHaveBeenCalledWith(TEST_INSTALLATION_A, 'project-a');
    expect(recover).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('skips a foreign synchronized recovery record during client startup recovery', async () => {
    const record = createHostTransferRecoveryRecord({
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 2).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.11:27001',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    const { assertRecoveryOwner, module, projectRecoveryAdmission } = create(record);
    assertRecoveryOwner.mockImplementation(ownerInstallationKey => {
      if (ownerInstallationKey !== TEST_INSTALLATION_B) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
        });
      }
    });

    await expect(module.clientService.resume()).resolves.toBeUndefined();
    expect(projectRecoveryAdmission).not.toHaveBeenCalled();
    await module.clientService.close();
  });

  it('surfaces an ownerless incoming legacy recovery record during client startup recovery', async () => {
    const current = createHostTransferRecoveryRecord({
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 2).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.11:27001',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    const { ownerInstallationKey: _ownerInstallationKey, ...withoutOwner } = current;
    const legacy = decodeHostTransferRecoveryRecord({ ...withoutOwner, schemaVersion: 1 });
    const { assertRecoveryOwner, module, projectRecoveryAdmission } = create(legacy);
    assertRecoveryOwner.mockImplementation(ownerInstallationKey => {
      if (ownerInstallationKey === undefined) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
        });
      }
    });

    await expect(module.clientService.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    expect(projectRecoveryAdmission).not.toHaveBeenCalled();
    await module.clientService.close();
  });

  it('keeps the client service usable after a per-Host runtime closes', async () => {
    const { control, module } = create();
    const runtime = module.createOutgoingRuntime({
      accept: { recover: jest.fn() },
      authority: { authorityDirectory: '/authority', database: {} },
      git: {},
      hostTransfers: {},
      projectId: 'project-a',
      repositoryPath: '/repository.git',
    } as never);

    await runtime.close();
    await module.clientService.createHostTransfer({
      projectId: 'project-a',
      targetMemberId: 'member-target',
    });

    expect(control.create).toHaveBeenCalledTimes(1);
    await module.clientService.close();
  });

  it('cannot bypass the durable Host start guard during outgoing recovery', async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-host-guard-'));
    const openProject = jest.fn();
    const lanHost = new LanHostCoordinator({
      assertHostInstallationOwned: async () => undefined,
      commitHostedRoute: async () => undefined,
      installationKey: TEST_INSTALLATION_A,
      localProjects: {
        ensurePrivateStateContainer: jest.fn(),
        hostTransferRecovery: { load: jest.fn() },
        loadMembership: jest.fn(),
        saveMembership: jest.fn(),
      } as never,
      openProject,
      runWithProjectStartGuard: async () => {
        throw new Error('durable Cloud fence');
      },
      vaultRoot,
    });
    const module = new HostTransferModule({
      activateTransferredAuthority: jest.fn(),
      authorityProjectionTransitions: new LanAuthorityProjectionTransitionCoordinator(),
      assertRecoveryOwner: jest.fn().mockResolvedValue(undefined),
      bindTransferTarget: jest.fn(),
      finalizeOldAuthority: jest.fn(),
      installationKey: TEST_INSTALLATION_A,
      lanHost,
      projects: {
        hostTransferRecovery: {
          load: jest.fn(async (_projectId, direction) => (
            direction === 'outgoing' ? { direction: 'outgoing', phase: 'offered' } : null
          )),
        },
        loadIndex: jest.fn(async () => ({
          projects: [{ id: 'project-a', name: 'Project A', workspacePath: 'workspace/a' }],
        })),
      },
      projectRecoveryAdmission: async (
        _projectId: string,
        operation: () => Promise<void>,
      ) => operation(),
      requireGitFoundation: jest.fn(),
      snapshots: { readCoordinationSnapshot: jest.fn() },
      workspace: {},
      createControlClient: jest.fn(),
    } as never);

    await expect(module.clientService.resume()).rejects.toThrow('durable Cloud fence');
    expect(openProject).not.toHaveBeenCalled();
    await module.clientService.close();
    await lanHost.close();
    await rm(vaultRoot, { force: true, recursive: true });
  });
});
