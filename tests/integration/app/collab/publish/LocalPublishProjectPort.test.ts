import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import {
  type CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  LocalPublishGitNetworkPort,
  LocalPublishProjectPort,
} from '@/app/collab/publish/LocalPublishProjectPort';
import { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import { LanAuthorityAdapter } from '@/app/collab/remote-authority/LanAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-a';
const NOW = '2026-08-08T00:00:00.000Z';

describe('Local Publish adapters', () => {
  let projects: CollabLocalProjectRepository;
  let repositories: { assertLocalRepositoryIdentity: jest.Mock };
  let sessions: CollabProjectWorkSessionRegistry;
  let authoritySessions: CollabAuthoritySessionFactory;
  let vaultRoot: string;
  let workspace: CollabWorkspaceService;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-publish-local-'));
    projects = new CollabLocalProjectRepository(vaultRoot);
    workspace = new CollabWorkspaceService(vaultRoot);
    repositories = { assertLocalRepositoryIdentity: jest.fn().mockResolvedValue(undefined) };
    sessions = new CollabProjectWorkSessionRegistry();
    authoritySessions = new CollabAuthoritySessionFactory([new LanAuthorityAdapter()]);
    await workspace.claimProjectsFolder('workspace');
    await mkdir(path.join(vaultRoot, 'workspace', PROJECT_ID), { recursive: true });
    await projects.upsertProject({
      authorityKind: 'lan',
      createdAt: NOW,
      id: PROJECT_ID,
      name: 'Project A',
      updatedAt: NOW,
      workspacePath: `workspace/${PROJECT_ID}`,
    });
    await projects.selectProject(PROJECT_ID);
  });

  afterEach(async () => {
    await sessions.close();
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('loads a stopped Host Project without fabricating a Host-only Git target', async () => {
    await projects.saveMembership(membership({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
    }));

    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);

    expect(context).toEqual({
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: PROJECT_ID,
      remoteUrl: null,
      repositoryPath: path.join(vaultRoot, 'workspace', PROJECT_ID),
    });
  });

  it('loads a foreign-bound Host Member through its ordinary LAN remote', async () => {
    await projects.saveMembership(membership());

    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);

    expect(context).toMatchObject({
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      remoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
    });
  });

  it('revalidates selection and reuses stable pinned CA material across network operations', async () => {
    await projects.saveMembership(membership());
    const projectPort = new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    );
    const context = await projectPort.load(PROJECT_ID);
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
    );

    const result = await networkPort.withNetwork(context, async (network, remoteUrl) => {
      expect(network).toEqual({
        headers: [{
          name: 'Authorization',
          value: `Basic ${Buffer.from(
            `member-a:${'A'.repeat(43)}`,
          ).toString('base64')}`,
        }],
        sslCaInfoPath: expect.stringContaining('git-ca.pem'),
      });
      expect(remoteUrl).toBe(
        `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      );
      return 'completed';
    });
    await networkPort.withNetwork(context, async network => network?.sslCaInfoPath);
    expect(result).toBe('completed');
    expect(await readdir(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    ))).toEqual(['git-ca.pem', 'membership.json']);

    await projects.selectProject(null);
    await expect(projectPort.revalidate(context)).rejects.toMatchObject({
      code: 'stale-project-selection',
    });
  });

  it('probes the authenticated control plane before exposing Git credentials', async () => {
    await projects.saveMembership(membership());
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const probe = jest.fn().mockRejectedValue(new Error('offline'));
    const operation = jest.fn();
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
      probe,
    );

    await expect(networkPort.withNetwork(context, operation)).rejects.toThrow('offline');
    expect(probe).toHaveBeenCalledWith(expect.any(Object), PROJECT_ID, undefined);
    expect(operation).not.toHaveBeenCalled();
  });

  it('uses one ephemeral local target for control and Git without persisting it', async () => {
    await projects.saveMembership(membership());
    const localEndpoint = 'https://192.168.1.44:54546';
    const localFactory = new CollabAuthoritySessionFactory([
      new LanAuthorityAdapter({
        resolveLocalTarget: jest.fn().mockResolvedValue({ endpoint: localEndpoint }),
      }),
    ]);
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      localFactory,
    );

    await networkPort.withNetwork(context, async (_network, remoteUrl) => {
      expect(remoteUrl).toBe(`${localEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    });

    await expect(projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: membership().authority,
      member: membership().member,
    });
  });

  it('restarts control and Git on one authority-session generation after a route reset', async () => {
    await projects.saveMembership(membership());
    const firstEndpoint = 'https://192.168.1.44:54546';
    const secondEndpoint = 'https://192.168.1.45:54547';
    const resolveLocalTarget = jest.fn()
      .mockResolvedValueOnce({ endpoint: firstEndpoint })
      .mockResolvedValue({ endpoint: secondEndpoint });
    const localFactory = new CollabAuthoritySessionFactory([
      new LanAuthorityAdapter({ resolveLocalTarget }),
    ]);
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    let reset = false;
    const probe = jest.fn(async (...args: readonly unknown[]) => {
      expect(args[0]).toMatchObject({ readSnapshot: expect.any(Function) });
      expect(args[1]).toBe(PROJECT_ID);
      if (!reset) {
        reset = true;
        sessions.resetProject(PROJECT_ID);
      }
    });
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      localFactory,
      probe,
    );

    await expect(networkPort.withNetwork(context, async (_network, remoteUrl) => remoteUrl))
      .resolves.toBe(`${secondEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    expect(resolveLocalTarget).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('retries Publish on the newly reconnected generation after a stale control endpoint', async () => {
    await projects.saveMembership(membership());
    const firstEndpoint = 'https://192.168.1.44:54546';
    const secondEndpoint = 'https://192.168.1.45:54547';
    const resolveLocalTarget = jest.fn()
      .mockResolvedValueOnce({ endpoint: firstEndpoint })
      .mockResolvedValue({ endpoint: secondEndpoint });
    const localFactory = new CollabAuthoritySessionFactory([
      new LanAuthorityAdapter({ resolveLocalTarget }),
    ]);
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const probe = jest.fn(async () => {
      if (probe.mock.calls.length === 1) {
        sessions.resetProject(PROJECT_ID);
        throw new CollabError({ code: 'endpoint-unreachable' });
      }
    });
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      localFactory,
      probe,
    );

    await expect(networkPort.withNetwork(context, async (_network, remoteUrl) => remoteUrl))
      .resolves.toBe(`${secondEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    expect(resolveLocalTarget).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('refreshes the Publish context after reconnect persists a new authority route', async () => {
    await projects.saveMembership(membership());
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const reconnectedEndpoint = 'https://192.168.1.45:54547';
    const probe = jest.fn(async () => {
      if (probe.mock.calls.length !== 1) return;
      await projects.saveMembership(membership({
        authority: {
          ...membership().authority,
          endpoint: reconnectedEndpoint,
          gitRemoteUrl: `${reconnectedEndpoint}/v1/git/${PROJECT_ID}/repository.git`,
        },
      }));
      sessions.resetProject(PROJECT_ID);
      throw new CollabError({ code: 'endpoint-unreachable' });
    });
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
      probe,
    );

    await expect(networkPort.withNetwork(context, async (_network, remoteUrl) => remoteUrl))
      .resolves.toBe(`${reconnectedEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reconnects and retries when the Git route fails after a successful control probe', async () => {
    await projects.saveMembership(membership());
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const reconnectedEndpoint = 'https://192.168.1.45:54547';
    const probe = jest.fn(async () => {
      if (probe.mock.calls.length !== 2) return;
      await projects.saveMembership(membership({
        authority: {
          ...membership().authority,
          endpoint: reconnectedEndpoint,
          gitRemoteUrl: `${reconnectedEndpoint}/v1/git/${PROJECT_ID}/repository.git`,
        },
      }));
      sessions.resetProject(PROJECT_ID);
    });
    const operation = jest.fn()
      .mockRejectedValueOnce(new CollabError({ code: 'operation-failed' }))
      .mockImplementation(async (_network, remoteUrl) => remoteUrl);
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
      probe,
    );

    await expect(networkPort.withNetwork(context, operation))
      .resolves.toBe(`${reconnectedEndpoint}/v1/git/${PROJECT_ID}/repository.git`);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('preserves a Git failure when the control route remains healthy', async () => {
    await projects.saveMembership(membership());
    const context = await new LocalPublishProjectPort(
      projects,
      workspace,
      repositories,
    ).load(PROJECT_ID);
    const probe = jest.fn().mockResolvedValue(undefined);
    const gitFailure = new CollabError({ code: 'operation-failed' });
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
      probe,
    );

    await expect(networkPort.withNetwork(context, async () => {
      throw gitFailure;
    })).rejects.toBe(gitFailure);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

function membership(
  overrides: Partial<CollabLocalLanMembershipRecord> = {},
): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:54545',
      gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: [
        '-----BEGIN CERTIFICATE-----',
        'TEST CERTIFICATE DATA',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: NOW,
    hostOwnership: { ownsAuthority: true },
    lastEventSequence: 0,
    member: {
      credential: 'A'.repeat(43),
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Project A',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: NOW,
    ...overrides,
  };
}
