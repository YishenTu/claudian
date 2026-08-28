import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { createHostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecovery';
import { LanIncomingHostTransferPreparation } from '@/app/collab/host-transfer/LanIncomingHostTransferPreparation';

const membership = {
  authority: { kind: 'lan' as const },
  member: {
    credential: 'credential',
    displayName: 'Target',
    id: 'member-target',
    personalRef: 'refs/heads/members/member-target',
    role: 'member' as const,
  },
  project: {
    id: 'project-alpha',
    name: 'Project Alpha',
    workspacePath: 'Projects/project-alpha',
  },
};

describe('LanIncomingHostTransferPreparation', () => {
  let root: string;
  let workspace: CollabWorkspaceService;
  let lanHost: {
    startProvisionalTransfer: jest.Mock;
    stopProvisionalTransfer: jest.Mock;
  };
  let service: LanIncomingHostTransferPreparation;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-host-transfer-target-'));
    workspace = new CollabWorkspaceService(root);
    await workspace.claimProjectsFolder('Projects');
    await mkdir(path.join(root, membership.project.workspacePath));
    lanHost = {
      startProvisionalTransfer: jest.fn().mockResolvedValue({
        caCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
        caFingerprint: 'a'.repeat(64),
        endpoint: 'https://192.168.1.20:27000',
        transferId: 'transfer-alpha',
      }),
      stopProvisionalTransfer: jest.fn().mockResolvedValue(undefined),
    };
    service = new LanIncomingHostTransferPreparation({
      createReceiverCredential: () => Buffer.alloc(32, 1).toString('base64url'),
      lanHost,
      loadMembership: jest.fn().mockResolvedValue(membership),
      projectsFolder: 'Projects',
      repositories: {
        assertLocalRepositoryIdentity: jest.fn().mockResolvedValue(undefined),
      },
      workspace,
    });
    service.bindCoordinator({
      activate: jest.fn(), cancel: jest.fn(), stage: jest.fn(),
    } as never);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('checks exact target membership and registers an operation-owned provisional receiver', async () => {
    await service.assertEligible({
      projectId: 'project-alpha', targetMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const prepared = await service.startProvisional({
      projectId: 'project-alpha', transferId: 'transfer-alpha',
    });

    expect(prepared).toEqual({
      endpoint: 'https://192.168.1.20:27000',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      stagingDirectoryName: '.claudian-host-transfer-transfer-alpha',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'a'.repeat(64),
    });
    await expect(stat(path.join(
      root, 'Projects', '.claudian-host-transfer-transfer-alpha',
    ))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    expect(lanHost.startProvisionalTransfer).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-alpha',
      receiverCredential: prepared.receiverCredential,
      transferId: 'transfer-alpha',
    }));
  });

  it('restores the exact receiver and cancels only its owned staging', async () => {
    const provisional = await service.startProvisional({
      projectId: 'project-alpha', transferId: 'transfer-alpha',
    });
    const record = createHostTransferRecoveryRecord({
      ownerInstallationKey: "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      projectId: 'project-alpha',
      receiverCredential: provisional.receiverCredential,
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: provisional.stagingDirectoryName,
      targetCaCertificatePem: provisional.targetCaCertificatePem,
      targetCaFingerprint: provisional.targetCaFingerprint,
      targetEndpoint: provisional.endpoint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    lanHost.startProvisionalTransfer.mockClear();

    await service.restoreProvisional(record);
    await service.cancelProvisional(record);

    expect(lanHost.startProvisionalTransfer).toHaveBeenCalledTimes(1);
    expect(lanHost.stopProvisionalTransfer).toHaveBeenCalledWith('transfer-alpha');
    await expect(readFile(path.join(
      root, 'Projects', '.claudian-host-transfer-transfer-alpha', 'keep',
    ))).rejects.toBeDefined();
    await expect(stat(path.join(
      root, 'Projects', '.claudian-host-transfer-transfer-alpha',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a target or staging-name mismatch without deleting it', async () => {
    await expect(service.assertEligible({
      projectId: 'project-alpha', targetMemberId: 'member-other',
      transferId: 'transfer-alpha',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    const validRecord = createHostTransferRecoveryRecord({
      ownerInstallationKey: "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: '2026-08-13T00:00:00.000Z', direction: 'incoming',
      projectId: 'project-alpha', receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-alpha',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'a'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27000', targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });
    const record = {
      ...validRecord,
      stagingDirectoryName: '.claudian-host-transfer-other',
    } as typeof validRecord;
    await expect(service.cancelProvisional(record)).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
    });
  });
});
