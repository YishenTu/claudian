import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
} from '@claudian-collab/protocol';

import { AuthorityProjectionTransitionCoordinator } from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import {
  type CollabLocalCloudMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { decodeCloudRelocationRecord } from '@/app/collab/reconnect/CloudRelocationRecord';
import {
  type CloudRelocationActivityPort,
  ReconnectProjectCoordinator,
  type ReconnectProjectFoundationPort,
} from '@/app/collab/reconnect/ReconnectProjectCoordinator';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';

const GIT_EXECUTABLE = '/usr/bin/git';
const NOW = '2026-09-01T00:00:00.000Z';
const PROJECT_ID = 'project-cloud-relocate';
const MEMBER_ID = 'member-alice';
const PERSONAL_REF = 'refs/heads/members/member-alice';
const OLD_SERVER_URL = 'https://old.example.test/operator';
const NEW_SERVER_URL = 'http://new.example.test/proxy/cloud';
const OLD_REMOTE = `${OLD_SERVER_URL}/v3/projects/${PROJECT_ID}/repository.git`;
const NEW_REMOTE = `${NEW_SERVER_URL}/v3/projects/${PROJECT_ID}/repository.git`;

describe('Cloud relocation recovery', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-relocation-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('recovers an origin-before-membership interruption without losing local work or publication state', async () => {
    const projects = new CollabLocalProjectRepository(vaultRoot);
    const workspace = new CollabWorkspaceService(vaultRoot);
    await workspace.claimProjectsFolder('workspace');
    const repositoryPath = path.join(vaultRoot, 'workspace', PROJECT_ID);
    await mkdir(repositoryPath);
    const repositories = new GitRepositoryService(new GitCommandRunner({
      emptyConfigPath: await projects.ensureGitEmptyConfig(),
      executablePath: GIT_EXECUTABLE,
    }));
    await repositories.initializeWorkingRepository(repositoryPath);
    await repositories.configureLocalRepository(repositoryPath, {
      memberId: MEMBER_ID,
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await repositories.addRemote(repositoryPath, 'origin', OLD_REMOTE);
    await writeFile(path.join(repositoryPath, 'unpublished.md'), 'preserve me\n');
    await projects.upsertProject({
      authorityKind: 'cloud',
      createdAt: NOW,
      id: PROJECT_ID,
      name: 'Cloud Relocation',
      updatedAt: NOW,
      workspacePath: `workspace/${PROJECT_ID}`,
    });
    await projects.saveMembership(membership());
    const publicationState = {
      baseMainOid: 'a'.repeat(40),
      operation: null,
      projectId: PROJECT_ID,
      schemaVersion: 1 as const,
      updatedAt: NOW,
    };
    await projects.saveProjectDocument(
      PROJECT_ID,
      'publication-state',
      publicationState,
    );

    let failMembershipSave = true;
    const first = coordinator({
      projects: projectPort(projects, async value => {
        if (failMembershipSave) {
          failMembershipSave = false;
          throw new Error('simulated membership write interruption');
        }
        await projects.saveMembership(value);
      }),
      repositories,
      vaultRoot,
      workspace,
    });

    await expect(first.reconnectProject({
      authority: { kind: 'cloud', serverUrl: NEW_SERVER_URL },
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({
      durableProgress: true,
      status: 'recovery-required',
    });

    await expect(repositories.listRemoteUrls(repositoryPath, 'origin'))
      .resolves.toEqual([NEW_REMOTE]);
    await expect(projects.loadMembership(PROJECT_ID)).resolves.toEqual(membership());
    await expect(projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCloudRelocationRecord,
    )).resolves.toMatchObject({ phase: 'origin-updated' });

    const restartedConnect = jest.fn(async () => {
      throw new Error('candidate validation must not repeat during durable recovery');
    });
    const restartedActivity = activity();
    const restarted = coordinator({
      activity: restartedActivity,
      connect: restartedConnect,
      projects: projectPort(projects, value => projects.saveMembership(value)),
      repositories,
      vaultRoot,
      workspace,
    });

    await restarted.resumeCloudRelocations();

    expect(restartedConnect).not.toHaveBeenCalled();
    await expect(projects.loadMembership(PROJECT_ID)).resolves.toEqual({
      ...membership(),
      authority: {
        authorityGeneration: 4,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: NEW_REMOTE,
        kind: 'cloud',
        serverUrl: NEW_SERVER_URL,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      updatedAt: NOW,
    });
    await expect(projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCloudRelocationRecord,
    )).resolves.toBeNull();
    await expect(projects.loadProjectDocument(
      PROJECT_ID,
      'publication-state',
      decodeCollabPublicationStateRecord,
    )).resolves.toEqual(publicationState);
    await expect(readFile(path.join(repositoryPath, 'unpublished.md'), 'utf8'))
      .resolves.toBe('preserve me\n');
    expect(restartedActivity.activate).toHaveBeenCalledWith(PROJECT_ID, {});
    expect(restartedActivity.resume).toHaveBeenCalledWith(PROJECT_ID);
  });
});

function membership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 4,
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: OLD_REMOTE,
      kind: 'cloud',
      serverUrl: OLD_SERVER_URL,
      wireVersion: COLLAB_PROTOCOL_VERSION,
    },
    createdAt: NOW,
    lastEventSequence: 4,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: MEMBER_ID,
      personalRef: PERSONAL_REF,
      role: 'member',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Relocation',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: NOW,
  };
}

function projectPort(
  projects: CollabLocalProjectRepository,
  saveMembership: (value: CollabLocalCloudMembershipRecord) => Promise<void>,
): ReconnectProjectFoundationPort['local']['projects'] {
  return {
    listPendingOperationProjectIds: () => projects.listPendingOperationProjectIds(),
    loadMembership: projectId => projects.loadMembership(projectId),
    loadProjectDocument: (projectId, kind, decode) => (
      projects.loadProjectDocument(projectId, kind, decode)
    ),
    removeProjectDocument: (projectId, kind) => (
      projects.removeProjectDocument(projectId, kind)
    ),
    saveMembership: value => saveMembership(value as CollabLocalCloudMembershipRecord),
    saveProjectDocument: (projectId, kind, value) => (
      projects.saveProjectDocument(projectId, kind, value)
    ),
  };
}

function activity(): jest.Mocked<CloudRelocationActivityPort> {
  return {
    activate: jest.fn(async (
      ..._args: Parameters<CloudRelocationActivityPort['activate']>
    ) => undefined),
    resume: jest.fn(async (
      ..._args: Parameters<CloudRelocationActivityPort['resume']>
    ) => undefined),
    suspend: jest.fn(async (
      ..._args: Parameters<CloudRelocationActivityPort['suspend']>
    ) => undefined),
  };
}

function coordinator(input: {
  readonly activity?: jest.Mocked<CloudRelocationActivityPort>;
  readonly connect?: () => Promise<CloudAuthorityConnection>;
  readonly projects: ReconnectProjectFoundationPort['local']['projects'];
  readonly repositories: GitRepositoryService;
  readonly vaultRoot: string;
  readonly workspace: CollabWorkspaceService;
}): ReconnectProjectCoordinator {
  const localActivity = input.activity ?? activity();
  const foundation: ReconnectProjectFoundationPort = {
    local: {
      projects: input.projects,
      workspace: input.workspace,
    },
    requireGitFoundation: async () => ({
      repositories: input.repositories,
    } as CollabGitFoundation),
  };
  return new ReconnectProjectCoordinator(foundation, {
    authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
    cloudRelocation: {
      activity: localActivity,
      connect: input.connect ?? (async () => connection()),
      createOperationId: () => 'relocate-cloud-one',
    },
    hostInstallation: { inspect: async () => 'absent' },
    now: () => new Date(NOW),
    vaultRoot: input.vaultRoot,
  });
}

function connection(): CloudAuthorityConnection {
  const local = membership();
  return {
    createProject: async () => { throw new Error('not expected'); },
    dispose: jest.fn(),
    git: { headers: [], remoteUrl: NEW_REMOTE },
    joinProject: async () => { throw new Error('not expected'); },
    lifecycle: {} as CloudAuthorityConnection['lifecycle'],
    projectId: PROJECT_ID,
    readSnapshot: async () => ({
      currentMember: {
        activatedAt: NOW,
        createdAt: NOW,
        ...local.member,
        status: 'active',
      },
      eventSequence: 5,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 4,
        authorityKind: 'cloud',
        createdAt: NOW,
        id: PROJECT_ID,
        mainOid: 'a'.repeat(40),
        mainRef: 'refs/heads/main',
        name: 'Cloud Relocation',
      },
      ticketHighlights: [],
    }),
    serverUrl: NEW_SERVER_URL,
    supports: () => true,
  };
}
