import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { LeaveProjectResponse } from '@claudian-collab/protocol';

import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { LocalExitProjectStore } from '@/app/collab/exit/LocalExitStores';
import {
  type LocalCleanupGitIdentityPort,
  LocalProjectCleanupCoordinator,
} from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import {
  type LocalExitActivityPort,
  type LocalExitAuthorityPort,
  LocalProjectExitCoordinator,
} from '@/app/collab/exit/LocalProjectExitCoordinator';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import { ManagerResponsibilityOperationCoordinator } from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = '2026-08-26T00:00:00.000Z';

describe('Pending Cloud Leave lost-response recovery', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-leave-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it.each(['keep-files', 'delete-files'] as const)(
    'replays the submitted %s Leave after real cleanup removed local Project state',
    async cleanupChoice => {
      const workspace = new CollabWorkspaceService(vaultRoot);
      await workspace.claimProjectsFolder('workspace');
      const projectRoot = path.join(vaultRoot, 'workspace', 'project-cloud');
      await mkdir(path.join(projectRoot, '.git'), { recursive: true });
      await writeFile(path.join(projectRoot, 'note.md'), 'visible\n');
      const projects = new CollabLocalProjectRepository(vaultRoot);
      await projects.upsertProject({
        authorityKind: 'cloud',
        createdAt: NOW,
        id: 'project-cloud',
        name: 'Cloud Project',
        updatedAt: NOW,
        workspacePath: 'workspace/project-cloud',
      });
      await projects.saveMembership({
        authority: {
          authorityGeneration: 4,
          bindingVersion: 4,
          gitRemoteUrl: 'https://cloud.example.test/v4/projects/project-cloud/repository.git',
          kind: 'cloud',
          serverUrl: 'https://cloud.example.test',
          wireVersion: 8,
        },
        createdAt: NOW,
        lastEventSequence: 3,
        lifecycle: 'active',
        member: {
          displayName: 'Alice',
          id: 'member-alice',
          personalRef: 'refs/heads/members/member-alice',
          role: 'member',
        },
        project: {
          id: 'project-cloud',
          name: 'Cloud Project',
          workspacePath: 'workspace/project-cloud',
        },
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        updatedAt: NOW,
      });
      const git: jest.Mocked<LocalCleanupGitIdentityPort> = {
        assertLocalRepositoryIdentity: jest.fn(async (
          _repositoryPath,
          _expected,
        ) => undefined),
      };
      const cleanup = new LocalProjectCleanupCoordinator(
        workspace,
        git,
        projects.localCleanup,
        { nonce: () => 'q'.repeat(43), now: () => new Date(NOW) },
      );
      const firstJournal = new CollabLifecycleJournalStore(vaultRoot).pendingLeaves;
      let settleAttempts = 0;
      const authority = authorityPort(() => {
        settleAttempts += 1;
        if (settleAttempts === 1) {
          throw new CollabError({ code: 'endpoint-unreachable' });
        }
        return leaveResponse();
      });
      const activity = activityPort();
      const first = coordinator(
        projects,
        firstJournal,
        authority,
        cleanup,
        activity,
      );

      await expect(first.leave({
        cleanupChoice,
        projectId: 'project-cloud',
      })).resolves.toEqual({ status: 'queued' });

      await expect(firstJournal.load('project-cloud')).resolves.toMatchObject({
        authorityKind: 'cloud',
        localCleanupComplete: true,
        phase: 'submitted',
        request: {
          expectedMembershipRevision: 9,
          idempotencyKey: 'leave-cloud-request-one',
        },
      });
      await expect(projects.loadIndex()).resolves.toMatchObject({ projects: [] });
      await expect(projects.loadMembership('project-cloud')).resolves.toBeNull();
      const rootState = await lstat(projectRoot)
        .then(() => 'present', error => (error as NodeJS.ErrnoException).code);
      const noteState = await readFile(path.join(projectRoot, 'note.md'), 'utf8')
        .catch(error => (error as NodeJS.ErrnoException).code);
      const gitState = await lstat(path.join(projectRoot, '.git'))
        .then(() => 'present', error => (error as NodeJS.ErrnoException).code);
      expect(rootState).toBe(cleanupChoice === 'keep-files' ? 'present' : 'ENOENT');
      expect(noteState).toBe(cleanupChoice === 'keep-files' ? 'visible\n' : 'ENOENT');
      expect(gitState).toBe('ENOENT');

      git.assertLocalRepositoryIdentity.mockClear();
      git.assertLocalRepositoryIdentity.mockRejectedValue(new Error('Native Git unavailable'));
      authority.prepareLeave.mockRejectedValue(new Error('active snapshot unavailable'));
      const restartedJournal = new CollabLifecycleJournalStore(vaultRoot).pendingLeaves;
      const restarted = coordinator(
        projects,
        restartedJournal,
        authority,
        cleanup,
        activityPort(),
      );

      await expect(restarted.resume('project-cloud')).resolves.toEqual({ status: 'complete' });

      expect(authority.prepareLeave).toHaveBeenCalledTimes(1);
      expect(authority.settleLeave).toHaveBeenCalledTimes(2);
      expect(git.assertLocalRepositoryIdentity).not.toHaveBeenCalled();
      await expect(restartedJournal.load('project-cloud')).resolves.toBeNull();
    },
  );
});

function authorityPort(
  settle: () => LeaveProjectResponse,
): jest.Mocked<LocalExitAuthorityPort> {
  return {
    prepareLeave: jest.fn(async (_input) => ({
      memberRole: 'member' as const,
      request: {
        expectedManagerSetGeneration: 7,
        expectedMembershipRevision: 9,
        expectedOfferRevision: null,
        expectedPersonalRefOid: 'a'.repeat(40),
        idempotencyKey: 'leave-cloud-request-one',
        managerResponsibilityOfferId: null,
        projectId: 'project-cloud',
      },
    })),
    recoverRejectedLeave: jest.fn(async (_input) => ({
      memberRole: 'member' as const,
    })),
    refreshLeave: jest.fn(),
    resolveLeaveHost: jest.fn(async input => { throw input.failure; }),
    settleLeave: jest.fn(async (_input) => settle()),
  };
}

function activityPort(): jest.Mocked<LocalExitActivityPort> {
  const suspension = { projectId: 'project-cloud', token: Symbol('cloud-leave') };
  return {
    completeProject: jest.fn(async (_suspension) => undefined),
    resumeProject: jest.fn(async (_suspension) => undefined),
    suspendProject: jest.fn(async (_projectId) => suspension),
  };
}

function coordinator(
  projects: CollabLocalProjectRepository,
  pendingLeaves: CollabLifecycleJournalStore['pendingLeaves'],
  authority: LocalExitAuthorityPort,
  cleanup: LocalProjectCleanupCoordinator,
  activity: LocalExitActivityPort,
): LocalProjectExitCoordinator {
  return new LocalProjectExitCoordinator(
    new LocalExitProjectStore(projects),
    pendingLeaves,
    authority,
    cleanup,
    activity,
    {
      createIdempotencyKey: () => 'leave-cloud-request-one',
      createOperationId: () => 'leave-cloud-one',
      managerReceipts: { load: async () => null },
      managerResponsibilityOperations: new ManagerResponsibilityOperationCoordinator(),
      now: () => new Date(NOW),
    },
  );
}

function leaveResponse(): LeaveProjectResponse {
  return {
    discardedRequestId: null,
    leftAt: NOW,
    managerSetGeneration: 8,
    memberId: 'member-alice',
    projectId: 'project-cloud',
    promotedSuccessorMemberId: null,
    status: 'left',
  };
}
