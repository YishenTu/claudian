import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.mock('@/app/collab/lan/CollabHttpClient', () => {
  const actual = jest.requireActual('@/app/collab/lan/CollabHttpClient');
  return {
    ...actual,
    PinnedCollabHttpClient: jest.fn().mockImplementation(() => ({
      requestWithMember: jest.fn(),
    })),
  };
});

const { PinnedCollabHttpClient } = jest.requireMock('@/app/collab/lan/CollabHttpClient') as {
  PinnedCollabHttpClient: jest.Mock;
};

async function admitProjectRecovery(
  _projectId: string,
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
}

describe('ClaudianCollabService retirement recovery', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a foreign tombstone before starting a responder or cleanup', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-foreign-owner',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      removeOwnedAuthorityDirectory: jest.Mock;
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [{
        ownerInstallationKey: TEST_INSTALLATION_B,
        projectId: 'project-a',
        result: { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
      }],
    });
    internal.startRetirementResponder = jest.fn();
    internal.closeAuthority = jest.fn();
    internal.removeOwnedAuthorityDirectory = jest.fn();

    await expect(service.restoreRetirementResponders(admitProjectRecovery))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
      });
    expect(internal.startRetirementResponder).not.toHaveBeenCalled();
    expect(internal.closeAuthority).not.toHaveBeenCalled();
    expect(internal.removeOwnedAuthorityDirectory).not.toHaveBeenCalled();
  });

  it('treats an authenticated terminal Retired result as Retire replay success', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-replay',
    });
    const internal = service as never as {
      local: { projects: { loadMembership: jest.Mock } };
    };
    internal.local.projects.loadMembership = jest.fn().mockResolvedValue({
      authority: {
        endpoint: 'https://127.0.0.1:61234',
        hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
        hostCaFingerprint: 'a'.repeat(64),
        kind: 'lan',
      },
      member: { credential: Buffer.alloc(32, 1).toString('base64url') },
    });
    const requestWithMember = jest.fn().mockRejectedValue(new CollabError({
        code: 'project-retired',
        safeContext: {
          projectId: 'project-a',
          retiredAt: '2026-08-13T00:00:00.000Z',
        },
      }));
    PinnedCollabHttpClient.mockImplementationOnce(() => ({ requestWithMember }));

    await expect(service.retireProject({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-a',
    })).resolves.toEqual({
      projectId: 'project-a',
      retiredAt: '2026-08-13T00:00:00.000Z',
    });
    expect(requestWithMember).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          expectedHostMemberId: 'member-host',
          idempotencyKey: expect.any(String),
          managerActorMemberId: 'member-manager',
          projectId: 'project-a',
        },
        method: 'POST',
        path: '/v9/projects/project-a/retire',
      }),
      Buffer.alloc(32, 1).toString('base64url'),
      {},
    );
  });

  it('fences LAN Host startup as soon as a retirement tombstone is durable', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-start-fence',
    });
    const internal = service as never as {
      local: { projects: { loadRetirementTombstone: jest.Mock } };
    };
    jest.spyOn(service.hostInstallations, 'assertOwned').mockResolvedValue({
      authorityDirectory: '/tmp/claudian-retirement-start-fence/authority',
      projectId: 'project-a',
    } as never);
    internal.local.projects.loadRetirementTombstone = jest.fn().mockResolvedValue({
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: 'project-a',
      result: { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
    });

    await expect(service.lanHost.startProject('project-a')).rejects.toMatchObject({
      code: 'project-retired',
      safeContext: { reason: 'retirement-tombstone-durable' },
    });
    expect(internal.local.projects.loadRetirementTombstone).toHaveBeenCalledWith('project-a');
  });

  it('restores a terminal responder without recreating finalized local projection', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-restore',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
      } };
      removeOwnedAuthorityDirectory: jest.Mock;
      retiredAuthorityCleanupComplete: Set<string>;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [{
        ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: 'project-a',
        result: { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
      }],
    });
    internal.startRetirementResponder = jest.fn().mockResolvedValue(undefined);
    internal.local.projects.loadIndex = jest.fn().mockResolvedValue({
      projects: [],
      schemaVersion: 2,
      selectedProjectId: null,
    });
    internal.local.projects.loadRetirementRecord = jest.fn().mockResolvedValue(null);
    internal.removeOwnedAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = { handle: jest.fn() };
    const projectRecoveryAdmission = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());

    await service.restoreRetirementResponders(projectRecoveryAdmission);

    expect(projectRecoveryAdmission).toHaveBeenCalledWith(
      'project-a',
      expect.any(Function),
    );
    expect(internal.startRetirementResponder).toHaveBeenCalledWith('project-a');
    expect(internal.retirementHandler.handle).not.toHaveBeenCalled();
    expect(internal.retiredAuthorityCleanupComplete.has('project-a')).toBe(true);
  });

  it('tears down retired authority after local projection recovery fails', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-local-recovery-failure',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
      } };
      removeOwnedAuthorityDirectory: jest.Mock;
      retiredAuthorityCleanupComplete: Set<string>;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [{
        ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: 'project-a',
        result: { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
      }],
    });
    internal.startRetirementResponder = jest.fn().mockResolvedValue(undefined);
    internal.local.projects.loadIndex = jest.fn().mockResolvedValue({
      projects: [{ id: 'project-a' }],
      schemaVersion: 2,
      selectedProjectId: null,
    });
    internal.local.projects.loadRetirementRecord = jest.fn().mockResolvedValue(null);
    internal.removeOwnedAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = {
      handle: jest.fn().mockRejectedValue(new Error('local cleanup failed')),
    };

    await expect(service.restoreRetirementResponders(admitProjectRecovery))
      .resolves.toBeUndefined();

    expect(internal.retirementHandler.handle).toHaveBeenCalledWith(
      { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
      'terminal-fallback',
    );
    expect(internal.closeAuthority).toHaveBeenCalledWith('project-a');
    expect(internal.removeOwnedAuthorityDirectory).toHaveBeenCalledWith('project-a');
    expect(internal.retiredAuthorityCleanupComplete.has('project-a')).toBe(true);
  });

  it('continues restoring other terminal responders after one Project fails', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-isolation',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
      } };
      removeOwnedAuthorityDirectory: jest.Mock;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    const tombstone = (projectId: string) => ({
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId,
      result: { projectId, retiredAt: '2026-08-13T00:00:00.000Z' },
    });
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [tombstone('project-a'), tombstone('project-b')],
    });
    internal.startRetirementResponder = jest.fn()
      .mockRejectedValueOnce(new Error('no private address'))
      .mockResolvedValueOnce(undefined);
    internal.local.projects.loadIndex = jest.fn().mockResolvedValue({
      projects: [], schemaVersion: 2, selectedProjectId: null,
    });
    internal.local.projects.loadRetirementRecord = jest.fn().mockResolvedValue(null);
    internal.removeOwnedAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = { handle: jest.fn() };

    await expect(service.restoreRetirementResponders(admitProjectRecovery))
      .rejects.toThrow('no private address');

    expect(internal.startRetirementResponder).toHaveBeenCalledTimes(2);
    expect(internal.startRetirementResponder).toHaveBeenLastCalledWith('project-b');
  });

  it('converges an expired tombstone before removing its terminal state', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-expired-retirement-convergence',
    });
    const order: string[] = [];
    const result = { projectId: 'project-a', retiredAt: '2026-07-14T00:00:00.000Z' };
    const internal = service as never as {
      closeAuthority: jest.Mock;
      lanHost: { stopTerminalProject: jest.Mock };
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
        loadRetirementTombstone: jest.Mock;
      } };
      removeOwnedAuthorityDirectory: jest.Mock;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { remove: jest.Mock; restore: jest.Mock };
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: ['project-a'],
      tombstones: [],
    });
    internal.local.projects.loadRetirementTombstone = jest.fn().mockResolvedValue({
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: 'project-a',
      result,
    });
    internal.local.projects.loadIndex = jest.fn().mockResolvedValue({
      projects: [{ id: 'project-a' }],
      schemaVersion: 2,
      selectedProjectId: 'project-a',
    });
    internal.local.projects.loadRetirementRecord = jest.fn().mockResolvedValue(null);
    internal.retirementHandler = {
      handle: jest.fn(async () => { order.push('local-retired'); }),
    };
    internal.lanHost.stopTerminalProject = jest.fn(async () => { order.push('host-stopped'); });
    internal.closeAuthority = jest.fn(async () => { order.push('authority-closed'); });
    internal.removeOwnedAuthorityDirectory = jest.fn(async () => {
      order.push('authority-removed');
    });
    internal.retirementTombstones.remove = jest.fn(async () => {
      order.push('tombstone-removed');
      return true;
    });

    await service.restoreRetirementResponders(admitProjectRecovery);

    expect(internal.retirementHandler.handle).toHaveBeenCalledWith(result, 'terminal-fallback');
    expect(order).toEqual([
      'local-retired',
      'host-stopped',
      'authority-closed',
      'authority-removed',
      'tombstone-removed',
    ]);
  });
});
