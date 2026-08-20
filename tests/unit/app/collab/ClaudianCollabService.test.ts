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

describe('ClaudianCollabService retirement recovery', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats an authenticated terminal Retired result as Retire replay success', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
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

  it('restores a terminal responder without recreating finalized local projection', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-restore',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
        removeAuthorityDirectory: jest.Mock;
      } };
      retiredAuthorityCleanupComplete: Set<string>;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [{
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
    internal.local.projects.removeAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = { handle: jest.fn() };

    await service.restoreRetirementResponders();

    expect(internal.startRetirementResponder).toHaveBeenCalledWith('project-a');
    expect(internal.retirementHandler.handle).not.toHaveBeenCalled();
    expect(internal.retiredAuthorityCleanupComplete.has('project-a')).toBe(true);
  });

  it('tears down retired authority after local projection recovery fails', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-local-recovery-failure',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
        removeAuthorityDirectory: jest.Mock;
      } };
      retiredAuthorityCleanupComplete: Set<string>;
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    internal.retirementTombstones.restore = jest.fn().mockResolvedValue({
      expiredProjectIds: [],
      tombstones: [{
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
    internal.local.projects.removeAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = {
      handle: jest.fn().mockRejectedValue(new Error('local cleanup failed')),
    };

    await expect(service.restoreRetirementResponders()).resolves.toBeUndefined();

    expect(internal.retirementHandler.handle).toHaveBeenCalledWith(
      { projectId: 'project-a', retiredAt: '2026-08-13T00:00:00.000Z' },
      'terminal-fallback',
    );
    expect(internal.closeAuthority).toHaveBeenCalledWith('project-a');
    expect(internal.local.projects.removeAuthorityDirectory).toHaveBeenCalledWith('project-a');
    expect(internal.retiredAuthorityCleanupComplete.has('project-a')).toBe(true);
  });

  it('continues restoring other terminal responders after one Project fails', async () => {
    const service = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: '/tmp/claudian-retirement-isolation',
    });
    const internal = service as never as {
      closeAuthority: jest.Mock;
      local: { projects: {
        loadIndex: jest.Mock;
        loadRetirementRecord: jest.Mock;
        removeAuthorityDirectory: jest.Mock;
      } };
      retirementHandler: { handle: jest.Mock };
      retirementTombstones: { restore: jest.Mock };
      startRetirementResponder: jest.Mock;
    };
    const tombstone = (projectId: string) => ({
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
    internal.local.projects.removeAuthorityDirectory = jest.fn().mockResolvedValue(undefined);
    internal.closeAuthority = jest.fn().mockResolvedValue(undefined);
    internal.retirementHandler = { handle: jest.fn() };

    await expect(service.restoreRetirementResponders()).rejects.toThrow('no private address');

    expect(internal.startRetirementResponder).toHaveBeenCalledTimes(2);
    expect(internal.startRetirementResponder).toHaveBeenLastCalledWith('project-b');
  });
});
