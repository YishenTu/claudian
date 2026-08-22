import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { HostTransferModule } from '@/app/collab/host-transfer/HostTransferModule';
import { LanHostCoordinator } from '@/app/collab/lan/LanHostCoordinator';

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
  function create() {
    const control = {
      cancel: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      decline: jest.fn().mockResolvedValue(undefined),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const projects = {
      hostTransferRecovery: recovery,
      loadIndex: jest.fn().mockResolvedValue({ projects: [] }),
      loadMembership: jest.fn().mockResolvedValue(membership),
    };
    const module = new HostTransferModule({
      activateTransferredAuthority: jest.fn(),
      finalizeOldAuthority: jest.fn(),
      lanHost: {},
      projects,
      requireGitFoundation: jest.fn(),
      snapshots: { readCoordinationSnapshot: jest.fn().mockResolvedValue(coordination) },
      workspace: {},
      createControlClient: () => control,
    } as never);
    return { control, module, recovery };
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
      finalizeOldAuthority: jest.fn(),
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
