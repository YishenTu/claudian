import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabProjectRetirementResult } from '@claudian-collab/protocol';

import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  type LocalCleanupGitIdentityPort,
  LocalProjectCleanupCoordinator,
} from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import {
  type CloudRetirementActivityPort,
  type CloudRetirementAuthorityClientPort,
  CloudRetirementClient,
  type CloudRetirementIntentStore,
} from '@/app/collab/retirement/CloudRetirementClient';
import { decodeCloudRetirementIntent } from '@/app/collab/retirement/CloudRetirementIntent';
import { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = '2026-08-27T00:00:00.000Z';
const PROJECT_ID = 'project-cloud-retire';

describe('Cloud Retirement lost-response recovery', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-retirement-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('replays the exact request into the real terminal and cleanup owners after restart', async () => {
    const workspace = new CollabWorkspaceService(vaultRoot);
    await workspace.claimProjectsFolder('workspace');
    const projectRoot = path.join(vaultRoot, 'workspace', PROJECT_ID);
    await mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await writeFile(path.join(projectRoot, 'note.md'), 'visible\n');
    const projects = new CollabLocalProjectRepository(vaultRoot);
    await projects.upsertProject({
      authorityKind: 'cloud',
      createdAt: NOW,
      id: PROJECT_ID,
      name: 'Cloud Retire',
      updatedAt: NOW,
      workspacePath: `workspace/${PROJECT_ID}`,
    });
    const membership = {
      authority: {
        authorityGeneration: 3,
        bindingVersion: 4 as const,
        gitRemoteUrl: `https://cloud.example.test/operator/v4/projects/${PROJECT_ID}/repository.git`,
        kind: 'cloud' as const,
        serverUrl: 'https://cloud.example.test/operator',
        wireVersion: 8 as const,
      },
      createdAt: NOW,
      lastEventSequence: 4,
      lifecycle: 'active' as const,
      member: {
        displayName: 'Manager',
        id: 'member-manager' as const,
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager' as const,
      },
      project: {
        id: PROJECT_ID,
        name: 'Cloud Retire',
        workspacePath: `workspace/${PROJECT_ID}`,
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: NOW,
    };
    await projects.saveMembership(membership);
    const git: jest.Mocked<LocalCleanupGitIdentityPort> = {
      assertLocalRepositoryIdentity: jest.fn(async (
        ..._args: Parameters<LocalCleanupGitIdentityPort['assertLocalRepositoryIdentity']>
      ) => undefined),
    };
    const cleanup = new LocalProjectCleanupCoordinator(
      workspace,
      git,
      projects.localCleanup,
      { nonce: () => 'q'.repeat(43), now: () => new Date(NOW) },
    );
    const acknowledgements = { schedule: jest.fn() };
    const terminal = new RetirementClientHandler(
      projects,
      {
        closeProject: jest.fn(async () => undefined),
        drainProject: jest.fn(async () => undefined),
      },
      acknowledgements,
      cleanup,
      { createOperationId: () => 'retire-cleanup-one', now: () => new Date(NOW) },
    );
    const intents = intentStore(projects);
    const firstAuthority = authorityClient();
    firstAuthority.retireProject.mockRejectedValueOnce(new CollabError({
      code: 'operation-timeout',
    }));
    const first = client(projects, intents, firstAuthority, terminal);

    await expect(first.retire(membership, { projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'operation-timeout' });
    await expect(intents.load(PROJECT_ID)).resolves.toMatchObject({
      phase: 'submitted',
      request: {
        expectedAuthorityGeneration: 3,
        expectedMainOid: 'a'.repeat(40),
        idempotencyKey: 'retire-request-one',
        projectId: PROJECT_ID,
      },
    });

    const replayAuthority = authorityClient();
    replayAuthority.readSnapshot.mockRejectedValue(new Error('active snapshot unavailable'));
    replayAuthority.listProjectMembers.mockRejectedValue(new Error('member list unavailable'));
    const restarted = client(projects, intents, replayAuthority, terminal);

    await restarted.resume(PROJECT_ID);

    expect(replayAuthority.readSnapshot).not.toHaveBeenCalled();
    expect(replayAuthority.listProjectMembers).not.toHaveBeenCalled();
    expect(replayAuthority.retireProject).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'retire-request-one' }),
      {},
    );
    await expect(intents.load(PROJECT_ID)).resolves.toBeNull();
    await expect(projects.loadMembership(PROJECT_ID)).resolves.toBeNull();
    await expect(projects.loadIndex()).resolves.toMatchObject({
      projects: [{ id: PROJECT_ID, lifecycle: 'retired' }],
    });
    await expect(readFile(path.join(projectRoot, 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
    await expect(lstat(path.join(projectRoot, '.git')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(acknowledgements.schedule).toHaveBeenCalledWith(PROJECT_ID);
  });
});

function intentStore(
  projects: CollabLocalProjectRepository,
): CloudRetirementIntentStore {
  return {
    listProjectIds: () => projects.listCloudRetirementIntentProjectIds(),
    load: projectId => projects.loadProjectDocument(
      projectId,
      'cloud-retirement-intent',
      decodeCloudRetirementIntent,
    ),
    loadRetirementRecord: projectId => projects.loadRetirementRecord(projectId),
    remove: projectId => projects.removeProjectDocument(
      projectId,
      'cloud-retirement-intent',
    ),
    save: intent => projects.saveProjectDocument(
      intent.projectId,
      'cloud-retirement-intent',
      intent,
    ),
  };
}

function client(
  projects: CollabLocalProjectRepository,
  intents: CloudRetirementIntentStore,
  authority: CloudRetirementAuthorityClientPort,
  terminal: RetirementClientHandler,
): CloudRetirementClient {
  return new CloudRetirementClient({
    activity: activity(),
    connect: async () => { throw new Error('acknowledgement not expected'); },
    connectRetirement: async () => authority,
    createIdempotencyKey: () => 'retire-request-one',
    intents: {
      ...intents,
      loadRetirementRecord: projectId => projects.loadRetirementRecord(projectId),
    },
    now: () => new Date(NOW),
    terminal,
  });
}

function activity(): jest.Mocked<CloudRetirementActivityPort> {
  return {
    complete: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['complete']>
    ) => undefined),
    resume: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['resume']>
    ) => undefined),
    suspend: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['suspend']>
    ) => undefined),
  };
}

function authorityClient(): jest.Mocked<CloudRetirementAuthorityClientPort> {
  const currentMember = {
    activatedAt: NOW,
    createdAt: NOW,
    displayName: 'Manager',
    id: 'member-manager' as const,
    personalRef: 'refs/heads/members/member-manager',
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    dispose: jest.fn(),
    listProjectMembers: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['listProjectMembers']>
    ): Promise<Awaited<ReturnType<CloudRetirementAuthorityClientPort['listProjectMembers']>>> => ({
      managerSetGeneration: 7,
      members: [{
        bindingState: 'bound',
        displayName: 'Manager',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-manager',
        membershipRevision: 9,
        role: 'manager',
      }],
      projectId: PROJECT_ID,
    })),
    readSnapshot: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['readSnapshot']>
    ): Promise<Awaited<ReturnType<CloudRetirementAuthorityClientPort['readSnapshot']>>> => ({
      currentMember,
      eventSequence: 4,
      members: [currentMember],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 3,
        authorityKind: 'cloud',
        createdAt: NOW,
        id: PROJECT_ID,
        mainOid: 'a'.repeat(40),
        mainRef: 'refs/heads/main',
        name: 'Cloud Retire',
      },
      ticketHighlights: [],
    })),
    retireProject: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['retireProject']>
    ): Promise<CollabProjectRetirementResult> => ({
      acknowledgementRequired: true,
      kind: 'project-retired',
      projectId: PROJECT_ID,
      retiredAt: NOW,
      retirementId: 'retirement-cloud-one',
      terminalExpiresAt: '2026-09-26T00:00:00.000Z',
    })),
  };
}
