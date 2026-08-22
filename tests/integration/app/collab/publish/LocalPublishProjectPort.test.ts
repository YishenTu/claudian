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
import { collabStoppedHostRemoteUrl } from '@/app/collab/git/GitRepositoryService';
import {
  LocalPublishGitNetworkPort,
  LocalPublishProjectPort,
} from '@/app/collab/publish/LocalPublishProjectPort';
import { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
import { LanAuthorityAdapter } from '@/app/collab/remote-authority/LanAuthorityAdapter';

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

  it('loads a stopped Host Project so Publish can still commit locally', async () => {
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
      allowHostRemoteRepair: true,
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: PROJECT_ID,
      remoteUrl: collabStoppedHostRemoteUrl(PROJECT_ID),
      repositoryPath: path.join(vaultRoot, 'workspace', PROJECT_ID),
    });
  });

  it('revalidates selection and reuses stable pinned CA material across network operations', async () => {
    await projects.saveMembership(membership());
    const projectPort = new LocalPublishProjectPort(projects, workspace, repositories);
    const context = await projectPort.load(PROJECT_ID);
    const networkPort = new LocalPublishGitNetworkPort(
      vaultRoot,
      projects,
      sessions,
      authoritySessions,
      () => true,
    );

    const result = await networkPort.withNetwork(context, async network => {
      expect(network).toEqual({
        headers: [{
          name: 'Authorization',
          value: `Basic ${Buffer.from(
            `member-a:${'A'.repeat(43)}`,
          ).toString('base64')}`,
        }],
        sslCaInfoPath: expect.stringContaining('git-ca.pem'),
      });
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
      () => true,
      probe,
    );

    await expect(networkPort.withNetwork(context, operation)).rejects.toThrow('offline');
    expect(probe).toHaveBeenCalledWith(PROJECT_ID);
    expect(operation).not.toHaveBeenCalled();
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
