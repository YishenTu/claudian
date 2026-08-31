import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabChangeRequest } from '@claudian-collab/protocol';
import {
  completeCollabFeatureOptions,
  TEST_COLLAB_FEATURE_PORT_METHODS,
} from '@test/helpers/collab/CollabFeatureTestHarness';

import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import {
  type CollabFeatureFoundationPort,
  CollabFeatureService,
  type CollabHostTransferPort,
  type CollabLocalExitPort,
  type CollabMembershipPort,
  type CollabProjectSetupPort,
  type CollabPublicationPort,
} from '@/app/collab/CollabFeatureService';
import type { CollabLocalProjectIndex } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { CollabLanProjectSnapshot } from '@/core/collab';
import { type CollabPublishOutcome, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

function publishedRequest(): CollabChangeRequest {
  return {
    commentCount: 0,
    createdAt: CREATED_AT,
    description: 'Published change',
    firstBaseOid: 'a'.repeat(40),
    id: 'request-a',
    latestHeadOid: 'b'.repeat(40),
    memberId: 'member-host',
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: CREATED_AT,
  };
}

function projectIndex(): CollabLocalProjectIndex {
  return {
    projects: [{
      authorityKind: 'lan' as const,
      createdAt: CREATED_AT,
      id: 'project-alpha',
      name: 'Alpha',
      updatedAt: CREATED_AT,
      workspacePath: 'workspace/alpha',
    }],
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    selectedProjectId: 'project-alpha',
  };
}

function membership(options: { readonly hostAutoStart?: boolean } = {}) {
  return {
    authority: {
      endpoint: null,
      gitRemoteUrl: null,
      hostCaCertificatePem: null,
      hostCaFingerprint: null,
      kind: 'lan' as const,
    },
    createdAt: CREATED_AT,
    hostOwnership: {
      ...(options.hostAutoStart === undefined
        ? {}
        : { autoStart: options.hostAutoStart }),
      ownsAuthority: true,
    },
    lastEventSequence: 1,
    member: {
      credential: 'A'.repeat(43),
      displayName: 'Alice',
      id: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      role: 'manager' as const,
    },
    project: {
      id: 'project-alpha',
      name: 'Alpha',
      workspacePath: 'workspace/alpha',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

function pendingSetup() {
  return {
    cloneDirectoryName: '.claudian-clone-project-alpha',
    createdAt: CREATED_AT,
    initialCommitOid: null,
    memberCredential: 'A'.repeat(43),
    memberDisplayName: 'Alice',
    memberId: 'member-host',
    name: 'Alpha',
    operationId: 'create-project-alpha',
    phase: 'planned',
    projectId: 'project-alpha',
    projectsFolder: 'workspace',
    schemaVersion: 2,
    seedDirectoryName: '.claudian-seed-project-alpha',
    slug: 'alpha',
    updatedAt: CREATED_AT,
  };
}

function pendingJoin() {
  return {
    createdAt: CREATED_AT,
    encodedInvitation: null,
    endpoint: 'https://127.0.0.1:54545',
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'ab'.repeat(32),
    joinAttemptId: 'join-alpha',
    lastEventSequence: null,
    memberCredential: 'B'.repeat(43),
    memberDisplayName: 'Bob',
    memberId: 'member-bob',
    memberRole: null,
    membershipExpiresAt: '2026-08-08T01:00:00.000Z',
    operationId: 'join-alpha',
    operationKind: 'join-project',
    phase: 'membership-created',
    projectId: 'project-alpha',
    projectName: null,
    schemaVersion: 1,
    slug: 'alpha',
    stagingDirectoryName: '.claudian-join-join-alpha',
    updatedAt: CREATED_AT,
  };
}

function authoritySnapshot(): CollabLanProjectSnapshot {
  const currentMember = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: 'Alice',
    id: 'member-host',
    personalRef: 'refs/heads/members/member-host',
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 2,
    members: [currentMember],
    openTicketCount: 0,
    openRequests: [],
    project: {
      authorityKind: 'lan',
      createdAt: CREATED_AT,
      hostMemberId: currentMember.id,
      id: 'project-alpha',
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function membershipControl(): jest.Mocked<CollabMembershipPort> {
  const offer = {
    expiresAt: '2026-08-08T00:10:00.000Z',
    offerId: 'offer-a',
    offeredAt: CREATED_AT,
    purpose: 'manager-promotion' as const,
    sourceManagerMemberId: 'member-host',
    status: 'offered' as const,
    targetMemberId: 'member-a',
  };
  return {
    cancelManagerResponsibilityOffer: jest.fn().mockResolvedValue({
      ...offer,
      status: 'cancelled',
    }),
    createInvitation: jest.fn().mockResolvedValue({
      encodedInvitation: 'claudian-collab:v2:test',
      expiresAt: '2026-08-08T01:00:00.000Z',
    }),
    createManagerResponsibilityOffer: jest.fn().mockResolvedValue(offer),
    removeMember: jest.fn().mockResolvedValue(undefined),
    revokeInvitation: jest.fn().mockResolvedValue(undefined),
    promoteManager: jest.fn().mockResolvedValue(undefined),
    demoteManager: jest.fn().mockResolvedValue(undefined),
  };
}

function localExit(): jest.Mocked<CollabLocalExitPort> {
  return {
    leaveProject: jest.fn().mockResolvedValue(undefined),
  };
}

function hostTransfer(): jest.Mocked<CollabHostTransferPort> {
  return {
    acceptHostTransfer: jest.fn().mockResolvedValue(undefined),
    cancelHostTransfer: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    createHostTransfer: jest.fn().mockResolvedValue(undefined),
    declineHostTransfer: jest.fn().mockResolvedValue(undefined),
  };
}

function publication(): jest.Mocked<CollabPublicationPort> {
  const coordinationSubscription = { dispose: jest.fn() };
  const sessions = new CollabProjectWorkSessionRegistry();
  const port = {
    acceptRequest: jest.fn().mockResolvedValue({
      mainOid: 'c'.repeat(40),
      mergeCommitOid: 'c'.repeat(40),
      request: {
        commentCount: 0,
        createdAt: CREATED_AT,
        description: 'Published change',
        firstBaseOid: 'a'.repeat(40),
        id: 'request-a',
        latestHeadOid: 'b'.repeat(40),
        memberId: 'member-host',
        mergedOid: 'c'.repeat(40),
        revision: 2,
        status: 'merged',
        ticketRelations: [],
        updatedAt: CREATED_AT,
      },
    }),
    addComment: jest.fn().mockResolvedValue({
      authorMemberId: 'member-host',
      body: 'Please revise',
      createdAt: CREATED_AT,
      id: 'comment-a',
      requestId: 'request-a',
    }),
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: 'b'.repeat(40),
        projectId: 'project-alpha',
        remoteHeadOid: 'b'.repeat(40),
        state: 'request-synchronized',
      },
    }),
    createTicket: jest.fn(),
    preparePublicationReview: jest.fn(),
    prepareWorkingTreeReview: jest.fn(),
    readPublicationReviewFile: jest.fn(),
    readWorkingTreeReviewFile: jest.fn(),
    findConflict: jest.fn().mockResolvedValue({ status: 'success', value: null }),
    inspectPersonalChanges: jest.fn().mockResolvedValue({
      action: 'publish',
      hasContribution: true,
      unpublishedReview: {
        baseOid: 'a'.repeat(40),
        files: [],
        headOid: 'a'.repeat(40),
        kind: 'working-tree',
        projectId: 'project-alpha',
        snapshotId: 'd'.repeat(64),
      },
      updateAvailable: true,
    }),
    listTickets: jest.fn(),
    synchronizeAcceptedMain: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        headOid: 'a'.repeat(40),
        projectId: 'project-alpha',
        state: 'already-current',
      },
    }),
    publish: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: 'b'.repeat(40),
        projectId: 'project-alpha',
        remoteHeadOid: 'b'.repeat(40),
        state: 'request-synchronized',
      },
    }),
    prepareReview: jest.fn().mockResolvedValue({
      canAccept: true,
      comparisonBaseOid: 'a'.repeat(40),
      comparisonKind: 'candidate',
      comparisonTargetOid: 'd'.repeat(40),
      detail: {
        changedFiles: [],
        comments: [],
        currentMainOid: 'a'.repeat(40),
        request: publishedRequest(),
        reviewCondition: 'clean',
        reviewedHeadOid: 'b'.repeat(40),
      },
      files: [],
      projectId: 'project-alpha',
    }),
    readGitStatus: jest.fn().mockResolvedValue({
      acceptedMainOid: 'a'.repeat(40),
      aheadBy: 1,
      behindBy: 0,
      changedFiles: [{
        binary: false,
        kind: 'modified',
        largeForReview: false,
        path: 'note.md',
      }],
      headOid: 'b'.repeat(40),
      includesAcceptedMain: false,
      personalRemoteOid: 'a'.repeat(40),
      workingTreeClean: false,
    }),
    readCoordinationSnapshot: jest.fn().mockResolvedValue({
      snapshot: authoritySnapshot(),
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 2,
        generation: 1,
        projectId: 'project-alpha',
        status: 'synchronized',
      },
    }),
    readPublishDescription: jest.fn().mockResolvedValue(null),
    readConflict: jest.fn().mockResolvedValue({
      status: 'success',
      value: conflictSession(),
    }),
    readConflictFile: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        accepted: { path: 'note.md', text: 'accepted' },
        base: { path: 'note.md', text: 'base' },
        kind: 'text',
        path: 'note.md',
        personal: { path: 'note.md', text: 'personal' },
      },
    }),
    readTicket: jest.fn(),
    readReviewFile: jest.fn().mockResolvedValue({
      file: {
        binary: false,
        kind: 'modified',
        largeForReview: false,
        path: 'note.md',
      },
      kind: 'text',
      newText: 'new',
      oldText: 'old',
    }),
    reconnectProject: jest.fn(),
    reopenTicket: jest.fn(),
    subscribeCoordination: jest.fn().mockReturnValue(coordinationSubscription),
    tryAutoReconnect: jest.fn().mockResolvedValue(false),
    updateRequestMetadata: jest.fn(),
    updateTicketContent: jest.fn(),
  } as unknown as jest.Mocked<CollabPublicationPort>;
  port.abortProjectBackgroundWork = jest.fn(projectId => {
    sessions.acquire(projectId).abortBackgroundSynchronization();
  });
  port.beginProjectInspection = jest.fn(projectId => (
    sessions.acquire(projectId).beginInspection()
  ));
  port.close = jest.fn(() => sessions.close());
  port.scheduleAcceptedMainSynchronization = jest.fn(projectId => {
    sessions.acquire(projectId).scheduleSynchronization(signal => (
      port.synchronizeAcceptedMain(projectId, { signal })
    ));
  });
  return port;
}

function conflictSession() {
  return {
    descriptor: {
      conflicts: [{ kind: 'text' as const, path: 'note.md' }],
      mergeBaseOid: 'a'.repeat(40),
      operationId: 'conflict-alpha',
      projectId: 'project-alpha',
      startingMainOid: 'b'.repeat(40),
      startingPersonalOid: 'c'.repeat(40),
    },
    pending: [{ kind: 'text' as const, path: 'note.md' }],
    resolvedPaths: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

describe('CollabFeatureService', () => {
  let vaultRoot: string;
  let pending: ReturnType<typeof pendingSetup> | ReturnType<typeof pendingJoin> | null;
  let currentIndex: ReturnType<typeof projectIndex>;
  let foundation: CollabFeatureFoundationPort;
  let setup: jest.Mocked<CollabProjectSetupPort>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-feature-service-'));
    await mkdir(path.join(vaultRoot, 'workspace', 'alpha', '.git'), { recursive: true });
    pending = null;
    currentIndex = projectIndex();
    foundation = {
      local: {
        projects: {
          loadIndex: jest.fn(async () => currentIndex),
          loadMembership: jest.fn(async () => membership()),
          loadProjectDocument: jest.fn(async (_projectId, _kind, decode) => (
            pending ? decode(pending) : null
          )),
          listPendingOperationProjectIds: jest.fn(async () => (
            pending ? [pending.projectId] : []
          )),
          selectProject: jest.fn(async projectId => {
            currentIndex = { ...currentIndex, selectedProjectId: projectId };
          }),
        },
        workspace: {
          resolveManagedProjectPath: jest.fn(async workspacePath => (
            path.join(vaultRoot, ...workspacePath.split('/'))
          )),
        },
      },
      requireGitFoundation: jest.fn().mockResolvedValue({}),
    } as unknown as CollabFeatureFoundationPort;
    setup = {
      createProject: jest.fn(),
      resumeSetup: jest.fn(),
    } as jest.Mocked<CollabProjectSetupPort>;
  });

  function createService(
    overrides: Omit<
      Parameters<typeof completeCollabFeatureOptions>[0],
      'vaultRoot'
    > = {},
  ): CollabFeatureService {
    return new CollabFeatureService(
      foundation,
      setup,
      completeCollabFeatureOptions({ ...overrides, vaultRoot }),
    );
  }

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('shares initialization and publishes the durable local Project projection', async () => {
    const service = createService();
    const states: string[] = [];
    service.subscribe(state => states.push(state.lifecycle));

    const [first, concurrent] = await Promise.all([
      service.initialize(),
      service.initialize(),
    ]);

    expect(first).toEqual(concurrent);
    expect(first).toEqual({
      status: 'success',
      value: expect.objectContaining({
        lifecycle: 'ready',
        projects: [{
          authorityKind: 'lan',
          connectionStatus: 'host-stopped',
          health: 'healthy',
          hostInstallationStatus: 'hosted-here',
          hostStatus: 'stopped',
          id: 'project-alpha',
          name: 'Alpha',
          role: 'manager',
          workspacePath: 'workspace/alpha',
        }],
        selectedProjectId: 'project-alpha',
      }),
    });
    expect(foundation.requireGitFoundation).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['uninitialized', 'initializing', 'initializing', 'ready']);
  });

  it.each([
    ['hosted-here', 'stopped', 'host-stopped'],
    ['hosted-elsewhere', 'not-host', 'offline'],
    ['legacy-unbound', 'stopped', 'host-stopped'],
    ['absent', 'not-host', 'offline'],
  ] as const)(
    'projects a Host Member with %s authority independently from Member identity',
    async (installationStatus, hostStatus, connectionStatus) => {
      const service = createService({
        hostInstallation: {
          inspect: jest.fn().mockResolvedValue(installationStatus),
        },
      });

      await expect(service.listProjects()).resolves.toMatchObject({
        status: 'success',
        value: [{
          connectionStatus,
          hostInstallationStatus: installationStatus === 'absent'
            ? 'not-host'
            : installationStatus,
          hostStatus,
          role: 'manager',
        }],
      });
    },
  );

  it('keeps non-Host and Retired Projects outside installation inspection', async () => {
    const inspect = jest.fn().mockResolvedValue('hosted-here');
    foundation.local.projects.loadMembership = jest.fn().mockResolvedValue({
      ...membership(),
      hostOwnership: { ownsAuthority: false },
    });
    const active = createService({ hostInstallation: { inspect } });

    await expect(active.listProjects()).resolves.toMatchObject({
      status: 'success',
      value: [{ hostInstallationStatus: 'not-host', hostStatus: 'not-host' }],
    });

    currentIndex = {
      ...currentIndex,
      projects: [{ ...currentIndex.projects[0], lifecycle: 'retired' }],
    };
    foundation.local.projects.loadMembership = jest.fn().mockResolvedValue(membership());
    const retired = createService({ hostInstallation: { inspect } });
    await expect(retired.listProjects()).resolves.toMatchObject({
      status: 'success',
      value: [{ hostInstallationStatus: 'not-host', hostStatus: 'not-host' }],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('isolates an incompatible legacy Cloud membership from healthy Projects', async () => {
    await mkdir(path.join(vaultRoot, 'workspace', 'legacy', '.git'), { recursive: true });
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          authorityKind: 'cloud',
          createdAt: CREATED_AT,
          id: 'project-legacy-cloud',
          name: 'Legacy Cloud',
          updatedAt: CREATED_AT,
          workspacePath: 'workspace/legacy',
        },
      ],
    };
    foundation.local.projects.loadMembership = jest.fn(async projectId => {
      if (projectId === 'project-legacy-cloud') {
        throw new CollabError({
          code: 'schema-version-unsupported',
          recoveryActions: ['open-diagnostics'],
          safeContext: { recordKind: 'membership' },
        });
      }
      return membership();
    });
    const service = createService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        lifecycle: 'ready',
        projects: [
          expect.objectContaining({ health: 'healthy', id: 'project-alpha' }),
          expect.objectContaining({
            authorityKind: 'cloud',
            connectionStatus: 'offline',
            health: 'needs-attention',
            id: 'project-legacy-cloud',
          }),
        ],
      },
    });
  });

  it('does not let a selected Project needing attention block healthy Projects', async () => {
    await mkdir(path.join(vaultRoot, 'workspace', 'legacy', '.git'), { recursive: true });
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          authorityKind: 'cloud',
          createdAt: CREATED_AT,
          id: 'project-legacy-cloud',
          name: 'Legacy Cloud',
          updatedAt: CREATED_AT,
          workspacePath: 'workspace/legacy',
        },
      ],
      selectedProjectId: 'project-legacy-cloud',
    };
    foundation.local.projects.loadMembership = jest.fn(async projectId => {
      if (projectId === 'project-legacy-cloud') {
        throw new CollabError({
          code: 'schema-version-unsupported',
          recoveryActions: ['open-diagnostics'],
          safeContext: { recordKind: 'membership' },
        });
      }
      return membership();
    });
    const publish = publication();
    publish.scheduleAcceptedMainSynchronization.mockImplementation(() => {
      throw new CollabError({
        code: 'project-retired',
        safeContext: {
          projectId: 'project-legacy-cloud',
          reason: 'project-activity-closed',
        },
      });
    });
    const service = createService({ publication: publish });

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        lifecycle: 'ready',
        projects: [
          expect.objectContaining({ health: 'healthy', id: 'project-alpha' }),
          expect.objectContaining({
            health: 'needs-attention',
            id: 'project-legacy-cloud',
          }),
        ],
      },
    });
    expect(publish.scheduleAcceptedMainSynchronization).not.toHaveBeenCalled();
  });

  it('isolates invalid Host marker state without blocking other Project summaries', async () => {
    await mkdir(path.join(vaultRoot, 'workspace', 'beta', '.git'), { recursive: true });
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          ...currentIndex.projects[0],
          id: 'project-beta',
          name: 'Beta',
          workspacePath: 'workspace/beta',
        },
      ],
    };
    foundation.local.projects.loadMembership = jest.fn(async projectId => ({
      ...membership(),
      project: {
        id: projectId,
        name: projectId === 'project-beta' ? 'Beta' : 'Alpha',
        workspacePath: projectId === 'project-beta' ? 'workspace/beta' : 'workspace/alpha',
      },
    }));
    const service = createService({
      hostInstallation: {
        inspect: jest.fn(async projectId => {
          if (projectId === 'project-alpha') throw new Error('corrupt marker');
          return 'hosted-elsewhere';
        }),
      },
    });

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        lifecycle: 'ready',
        projects: [
          expect.objectContaining({
            connectionStatus: 'offline',
            health: 'needs-attention',
            hostInstallationStatus: 'not-host',
            id: 'project-alpha',
          }),
          expect.objectContaining({
            health: 'healthy',
            hostInstallationStatus: 'hosted-elsewhere',
            id: 'project-beta',
          }),
        ],
      },
    });
  });

  it('loads the Project index and Git foundation concurrently', async () => {
    const indexRead = deferred<ReturnType<typeof projectIndex>>();
    foundation.local.projects.loadIndex = jest.fn(() => indexRead.promise);
    const service = createService();

    const initialization = service.initialize();
    await Promise.resolve();

    expect(foundation.requireGitFoundation).toHaveBeenCalledTimes(1);
    indexRead.resolve(currentIndex);
    await expect(initialization).resolves.toMatchObject({ status: 'success' });
  });

  it('reads the effective Project selection without initializing Git', async () => {
    currentIndex = { ...currentIndex, selectedProjectId: 'project-missing' };
    const service = createService();

    await expect(service.readProjectSelection()).resolves.toEqual({
      status: 'success',
      value: {
        projects: [{ id: 'project-alpha', name: 'Alpha' }],
        selectedProjectId: 'project-alpha',
      },
    });
    expect(foundation.requireGitFoundation).not.toHaveBeenCalled();
  });

  it('retains Project state when Git setup blocks initialization', async () => {
    (foundation.requireGitFoundation as jest.Mock).mockRejectedValue(new CollabError({
      code: 'git-not-found',
      recoveryActions: ['install-git'],
    }));
    const service = createService();

    await expect(service.initialize()).resolves.toMatchObject({
      error: { code: 'git-not-found' },
      status: 'failure',
    });
    expect(service.state).toMatchObject({
      lifecycle: 'failed',
      projects: [expect.objectContaining({ id: 'project-alpha' })],
    });
  });

  it('initializes a selected Retired Project without native Git', async () => {
    currentIndex = {
      ...currentIndex,
      projects: [{
        ...currentIndex.projects[0],
        cleanupStatus: 'complete',
        lifecycle: 'retired',
        retiredAt: '2026-08-08T01:00:00.000Z',
      }],
    };
    (foundation.requireGitFoundation as jest.Mock).mockRejectedValue(new CollabError({
      code: 'git-not-found',
      recoveryActions: ['install-git'],
    }));
    const service = createService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        lifecycle: 'ready',
        projects: [{ lifecycle: 'retired' }],
        selectedProjectId: 'project-alpha',
      },
    });
  });

  it('keeps interrupted and missing working copies visible for recovery', async () => {
    pending = pendingSetup();
    await rm(path.join(vaultRoot, 'workspace', 'alpha'), { recursive: true });
    const service = createService();

    await expect(service.listProjects()).resolves.toEqual({
      status: 'success',
      value: [expect.objectContaining({
        health: 'needs-attention',
        id: 'project-alpha',
      })],
    });
    await expect(service.getPendingSetupOperationId('project-alpha'))
      .resolves.toBe('create-project-alpha');

    pending = null;
    await expect(service.listProjects()).resolves.toEqual({
      status: 'success',
      value: [expect.objectContaining({ health: 'missing' })],
    });
  });

  it('refreshes state after successful creation and durable partial setup', async () => {
    const service = createService();
    setup.createProject.mockResolvedValue({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'host-stopped',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
        id: 'project-alpha',
        name: 'Alpha',
        role: 'manager',
        workspacePath: 'workspace/alpha',
      },
    });
    setup.resumeSetup.mockResolvedValue({
      durablePhase: 'committed',
      durableProgress: true,
      error: new CollabError({ code: 'durable-progress-recovery-required' }),
      operationId: 'create-project-alpha',
      status: 'recovery-required',
    });

    await service.createProject({
      memberDisplayName: 'Alice',
      name: 'Alpha',
    });
    pending = pendingSetup();
    await service.resumeSetup({ operationId: 'create-project-alpha' });

    expect(foundation.local.projects.loadIndex).toHaveBeenCalledTimes(2);
    expect(foundation.local.projects.listPendingOperationProjectIds)
      .toHaveBeenCalledTimes(1);
    expect(service.state.projects[0]).toMatchObject({ health: 'needs-attention' });
  });

  it('starts a newly created Host Project immediately', async () => {
    let hostStatus = 'stopped' as 'running' | 'stopped';
    const lanHost = {
      getProjectState: jest.fn(() => ({
        projectId: 'project-alpha',
        status: hostStatus,
      })),
      startProject: jest.fn(async () => {
        hostStatus = 'running';
        return {
          endpoint: 'https://127.0.0.1:54545',
          projectId: 'project-alpha',
          status: 'running' as const,
        };
      }),
      stopProject: jest.fn(),
    };
    const service = createService({ lanHost });
    setup.createProject.mockResolvedValue({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'host-stopped',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
        id: 'project-alpha',
        name: 'Alpha',
        role: 'manager',
        workspacePath: 'workspace/alpha',
      },
    });

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Alpha',
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        connectionStatus: 'connected',
        hostStatus: 'running',
      },
    });
    expect(lanHost.startProject).toHaveBeenCalledWith('project-alpha');
  });

  it('dispatches Join resume by the persisted operation kind and refreshes state', async () => {
    pending = pendingJoin();
    const join = {
      joinProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'connected',
          health: 'healthy',
          hostInstallationStatus: 'not-host',
          hostStatus: 'not-host',
          id: 'project-alpha',
          name: 'Alpha',
          role: 'member',
          workspacePath: 'workspace/alpha',
        },
      }),
      resumeJoin: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'connected',
          health: 'healthy',
          hostInstallationStatus: 'not-host',
          hostStatus: 'not-host',
          id: 'project-alpha',
          name: 'Alpha',
          role: 'member',
          workspacePath: 'workspace/alpha',
        },
      }),
    };
    const service = createService({
      join,
    });

    await expect(service.getPendingSetupOperationId('project-alpha'))
      .resolves.toBe('join-alpha');
    await expect(service.resumeSetup({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({ status: 'success' });
    expect(join.resumeJoin).toHaveBeenCalledWith(
      { operationId: 'join-alpha' },
      undefined,
    );
    expect(setup.resumeSetup).not.toHaveBeenCalled();

    await expect(service.joinProject({
      encodedInvitation: 'invitation',
      memberDisplayName: 'Bob',
    })).resolves.toMatchObject({ status: 'success' });
    expect(join.joinProject).toHaveBeenCalledTimes(1);
  });

  it('reconnects the selected Project and resets endpoint-bound clients', async () => {
    const publish = publication();
    publish.reconnectProject.mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'connected',
          health: 'healthy',
          hostInstallationStatus: 'not-host',
          hostStatus: 'not-host',
          id: 'project-alpha',
          name: 'Alpha',
          role: 'member',
          workspacePath: 'workspace/alpha',
        },
      });
    const service = createService({
      publication: publish,
    });
    const request = {
      encodedInvitation: 'claudian-collab:v2:invitation',
      projectId: 'project-alpha',
    };

    await expect(service.reconnectProject(request)).resolves.toMatchObject({
      status: 'success',
      value: { id: 'project-alpha' },
    });

    expect(publish.reconnectProject).toHaveBeenCalledWith(request, {
      signal: expect.any(AbortSignal),
    });
    expect(service.state.activeOperation).toBeUndefined();
  });

  it('starts and stops LAN hosting through the facade projection', async () => {
    let hostStatus = 'stopped' as 'running' | 'stopped';
    const lanHost = {
      getProjectState: jest.fn(() => ({
        projectId: 'project-alpha',
        status: hostStatus,
      })),
      startProject: jest.fn(async () => {
        hostStatus = 'running';
        return {
          endpoint: 'https://127.0.0.1:54545',
          projectId: 'project-alpha',
          status: 'running' as const,
        };
      }),
      stopProject: jest.fn(async () => {
        hostStatus = 'stopped';
        return { projectId: 'project-alpha', status: 'stopped' as const };
      }),
    };
    const access = membershipControl();
    const service = createService({
      lanHost,
      membership: access,
    });

    await expect(service.startHost('project-alpha')).resolves.toEqual({
      status: 'success',
      value: { projectId: 'project-alpha', status: 'running' },
    });
    expect(service.state.projects[0]).toMatchObject({
      connectionStatus: 'connected',
      hostStatus: 'running',
    });
    await expect(service.createInvitation('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { encodedInvitation: 'claudian-collab:v2:test' },
    });
    expect(access.createInvitation).toHaveBeenCalledWith('project-alpha', {});
    await expect(service.stopHost('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { status: 'stopped' },
    });
    expect(service.state.projects[0]).toMatchObject({
      connectionStatus: 'host-stopped',
      hostStatus: 'stopped',
    });
  });

  it('claims a legacy Host explicitly, refreshes its projection, and is idempotent when owned', async () => {
    let status = 'legacy-unbound' as 'legacy-unbound' | 'hosted-here';
    const claimLegacy = jest.fn(async () => {
      status = 'hosted-here';
      return {} as never;
    });
    const service = createService({
      hostInstallation: {
        claimLegacy,
        inspect: jest.fn(async () => status),
      },
    });

    await expect(service.claimLegacyHostInstallation('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
      },
    });
    await expect(service.claimLegacyHostInstallation('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { hostInstallationStatus: 'hosted-here' },
    });
    expect(claimLegacy).toHaveBeenCalledTimes(2);
  });

  it('resumes legacy recovery migration after marker ownership committed', async () => {
    let status = 'legacy-unbound' as 'legacy-unbound' | 'hosted-here';
    const claimLegacy = jest.fn()
      .mockImplementationOnce(async () => {
        status = 'hosted-here';
        throw new Error('fault after marker upgrade');
      })
      .mockResolvedValue({});
    const service = createService({
      hostInstallation: {
        claimLegacy,
        inspect: jest.fn(async () => status),
      },
    });

    await expect(service.claimLegacyHostInstallation('project-alpha')).resolves.toMatchObject({
      status: 'failure',
    });
    await expect(service.claimLegacyHostInstallation('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { hostInstallationStatus: 'hosted-here' },
    });
    expect(claimLegacy).toHaveBeenCalledTimes(2);
  });

  it('rejects legacy claim for a foreign authority', async () => {
    const claimLegacy = jest.fn();
    const service = createService({
      hostInstallation: {
        claimLegacy,
        inspect: jest.fn().mockResolvedValue('hosted-elsewhere'),
      },
    });

    await expect(service.claimLegacyHostInstallation('project-alpha')).resolves.toMatchObject({
      error: { safeContext: { reason: 'host-installation-claim-unavailable' } },
      status: 'failure',
    });
    expect(claimLegacy).not.toHaveBeenCalled();
  });

  it('restores legacy and enabled Host-owned Projects but respects explicit stop intent', async () => {
    const lanHost = {
      getProjectState: jest.fn(() => ({
        projectId: 'project-alpha',
        status: 'stopped' as const,
      })),
      startProject: jest.fn().mockResolvedValue({
        endpoint: 'https://127.0.0.1:54545',
        projectId: 'project-alpha',
        status: 'running' as const,
      }),
      stopProject: jest.fn(),
    };
    const service = createService({
      lanHost,
    });

    await service.restoreHosts();
    expect(lanHost.startProject).toHaveBeenCalledWith('project-alpha');

    (foundation.local.projects.loadMembership as jest.Mock)
      .mockResolvedValue(membership({ hostAutoStart: false }));
    lanHost.startProject.mockClear();
    await service.restoreHosts();

    expect(lanHost.startProject).not.toHaveBeenCalled();
  });

  it.each(['hosted-elsewhere', 'legacy-unbound', 'absent'] as const)(
    'does not auto-start a Host Member whose authority is %s',
    async installationStatus => {
      const lanHost = {
        getProjectState: jest.fn(() => ({
          projectId: 'project-alpha',
          status: 'stopped' as const,
        })),
        startProject: jest.fn(),
        stopProject: jest.fn(),
      };
      const service = createService({
        hostInstallation: {
          inspect: jest.fn().mockResolvedValue(installationStatus),
        },
        lanHost,
      });

      await expect(service.restoreHosts()).resolves.toBeUndefined();
      expect(lanHost.startProject).not.toHaveBeenCalled();
    },
  );

  it('retries Host restoration once while the previous plugin instance releases its lock', async () => {
    jest.useFakeTimers();
    try {
      const lanHost = {
        getProjectState: jest.fn(() => ({
          projectId: 'project-alpha',
          status: 'stopped' as const,
        })),
        startProject: jest.fn()
          .mockRejectedValueOnce(new CollabError({
            code: 'authorization-denied',
            safeContext: { reason: 'vault-host-already-running' },
          }))
          .mockResolvedValue({
            endpoint: 'https://127.0.0.1:54545',
            projectId: 'project-alpha',
            status: 'running' as const,
          }),
        stopProject: jest.fn(),
      };
      const service = createService({
        lanHost,
      });

      const restoring = service.restoreHosts();
      await jest.advanceTimersByTimeAsync(750);
      await restoring;

      expect(lanHost.startProject).toHaveBeenCalledTimes(2);
      expect(lanHost.startProject).toHaveBeenNthCalledWith(1, 'project-alpha');
      expect(lanHost.startProject).toHaveBeenNthCalledWith(2, 'project-alpha');
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks stale callers and drains an admitted Host restore before closing', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const lanHost = {
      getProjectState: jest.fn(() => ({
        projectId: 'project-alpha',
        status: 'stopped' as const,
      })),
      startProject: jest.fn(async () => {
        started.resolve();
        await release.promise;
        return {
          endpoint: 'https://127.0.0.1:54545',
          projectId: 'project-alpha',
          status: 'running' as const,
        };
      }),
      stopProject: jest.fn(),
    };
    const service = createService({
      lanHost,
    });

    const restoring = service.restoreHosts();
    await started.promise;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });

    await expect(service.listProjects()).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'collab-feature-closing' },
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await restoring;
    await closing;
    expect(closed).toBe(true);
  });

  it('closes required owners in the feature lifecycle order', async () => {
    const hostStarted = deferred<void>();
    const releaseHost = deferred<void>();
    const releaseRecoveryClose = deferred<void>();
    const order: string[] = [];
    const publish = publication();
    publish.subscribeCoordination.mockReturnValue({
      dispose: jest.fn(() => order.push('publication-subscription')),
    });
    publish.close.mockImplementation(async () => {
      order.push('publication');
    });
    const service = createService({
      hostTransfer: {
        close: jest.fn(async () => {
          order.push('host-transfer');
        }),
      },
      lanHost: {
        startProject: jest.fn(async projectId => {
          hostStarted.resolve();
          await releaseHost.promise;
          order.push('admitted-operation');
          return { projectId, status: 'running' as const };
        }),
      },
      lifecycleRecovery: {
        close: jest.fn(() => {
          order.push('recovery-close-started');
          return releaseRecoveryClose.promise.then(() => {
            order.push('recovery-close-finished');
          });
        }),
      },
      publication: publish,
      retirement: {
        close: jest.fn(async () => {
          order.push('retirement');
        }),
      },
    });

    const restoring = service.restoreHosts();
    await hostStarted.promise;
    const closing = service.close();

    expect(order).toEqual(['recovery-close-started']);
    releaseHost.resolve();
    await restoring;
    await Promise.resolve();
    expect(order).toEqual(['recovery-close-started', 'admitted-operation']);

    releaseRecoveryClose.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(order).toEqual([
      'recovery-close-started',
      'admitted-operation',
      'recovery-close-finished',
      'retirement',
      'host-transfer',
      'publication-subscription',
      'publication',
    ]);
    expect(service).not.toHaveProperty('dispose');
  });

  it('continues feature close when best-effort owners throw synchronously', async () => {
    const publish = publication();
    const service = createService({
      hostTransfer: {
        close: jest.fn(() => {
          throw new Error('host-transfer-close-failed');
        }),
      },
      lifecycleRecovery: {
        close: jest.fn(() => {
          throw new Error('recovery-close-failed');
        }),
      },
      publication: publish,
      retirement: {
        close: jest.fn(() => {
          throw new Error('retirement-close-failed');
        }),
      },
    });

    await expect(service.close()).resolves.toBeUndefined();
    expect(publish.close).toHaveBeenCalledTimes(1);
  });

  it('clears feature listeners when publication close fails', async () => {
    const closeError = new Error('publication-close-failed');
    const publish = publication();
    publish.close.mockRejectedValue(closeError);
    const service = createService({ publication: publish });
    service.subscribe(jest.fn());

    await expect(service.close()).rejects.toBe(closeError);

    const core = service as unknown as {
      readonly core: { readonly listeners: ReadonlySet<unknown> };
    };
    expect(core.core.listeners.size).toBe(0);
  });

  it('routes membership administration independently from LAN Host ownership', async () => {
    const access = membershipControl();
    const exits = localExit();
    const service = createService({
      localExit: exits,
      membership: access,
    });

    await expect(service.promoteManager({
      intentId: 'promote-a',
      managerResponsibilityOfferId: 'offer-a',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.demoteManager({
      intentId: 'demote-a',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.removeMember({
      intentId: 'remove-a',
      memberId: 'member-a',
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.leaveProject({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toMatchObject({
      status: 'success',
    });

    expect(access.promoteManager).toHaveBeenCalledWith({
      intentId: 'promote-a',
      managerResponsibilityOfferId: 'offer-a',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    }, {});
    expect(access.demoteManager).toHaveBeenCalledWith({
      intentId: 'demote-a',
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    }, {});
    expect(access.removeMember).toHaveBeenCalledWith({
      intentId: 'remove-a',
      memberId: 'member-a',
      projectId: 'project-alpha',
    }, {});
    expect(exits.leaveProject).toHaveBeenCalledWith({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    }, {});
  });

  it('delegates lifecycle intents and refreshes the local Project projection', async () => {
    const access = membershipControl();
    const exits = localExit();
    const transfers = hostTransfer();
    const retirement = {
      finalizeRetiredProject: jest.fn().mockResolvedValue(undefined),
      retireProject: jest.fn().mockResolvedValue(undefined),
      retryProjectCleanup: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService({
      hostTransfer: transfers,
      localExit: exits,
      membership: access,
      retirement,
    });
    const initialReads = (foundation.local.projects.loadIndex as jest.Mock).mock.calls.length;

    await expect(service.createManagerResponsibilityOffer({
      intentId: 'offer-a',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    })).resolves.toMatchObject({ status: 'success', value: { offerId: 'offer-a' } });
    await expect(service.cancelManagerResponsibilityOffer({
      offerId: 'offer-a',
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'success', value: { status: 'cancelled' } });
    await expect(service.createHostTransfer({
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.acceptHostTransfer({
      projectId: 'project-alpha', transferId: 'transfer-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.declineHostTransfer({
      projectId: 'project-alpha', transferId: 'transfer-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.cancelHostTransfer({
      projectId: 'project-alpha', transferId: 'transfer-a',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.retireProject({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-host',
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.finalizeRetiredProject({
      cleanupChoice: 'keep-files', projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(service.retryProjectCleanup('project-alpha'))
      .resolves.toMatchObject({ status: 'success' });

    expect(retirement.retireProject).toHaveBeenCalledTimes(1);
    expect(transfers.createHostTransfer).toHaveBeenCalledTimes(1);
    expect(retirement.finalizeRetiredProject).toHaveBeenCalledTimes(1);
    expect((foundation.local.projects.loadIndex as jest.Mock).mock.calls.length)
      .toBe(initialReads + 9);
  });

  it('projects Retired lifecycle without requiring the detached Git directory', async () => {
    await rm(path.join(vaultRoot, 'workspace', 'alpha', '.git'), { recursive: true });
    currentIndex = {
      ...currentIndex,
      projects: [{
        ...currentIndex.projects[0],
        cleanupStatus: 'complete',
        lifecycle: 'retired',
        retiredAt: '2026-08-08T01:00:00.000Z',
      }],
    };
    foundation.local.projects.loadMembership = jest.fn().mockResolvedValue({
      ...membership(),
      lifecycle: 'leaving',
    });
    const service = createService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: {
        projects: [{
          cleanupStatus: 'complete',
          connectionStatus: 'offline',
          health: 'healthy',
          hostStatus: 'not-host',
          lifecycle: 'retired',
          retiredAt: '2026-08-08T01:00:00.000Z',
        }],
      },
    });
  });

  it('inspects a Retired Project after its work session closes permanently', async () => {
    currentIndex = {
      ...currentIndex,
      projects: [{
        ...currentIndex.projects[0],
        cleanupStatus: 'complete',
        lifecycle: 'retired',
        retiredAt: '2026-08-08T01:00:00.000Z',
      }],
    };
    const retiredPublication = publication();
    retiredPublication.beginProjectInspection.mockImplementation(() => {
      throw new CollabError({ code: 'project-retired' });
    });
    const service = createService({ publication: retiredPublication });

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        project: {
          cleanupStatus: 'complete',
          lifecycle: 'retired',
          retiredAt: '2026-08-08T01:00:00.000Z',
        },
      },
    });
  });

  it('closes Project operation admission while preserving local Retired actions', async () => {
    const access = membershipControl();
    const retirement = {
      finalizeRetiredProject: jest.fn().mockResolvedValue(undefined),
      retireProject: jest.fn().mockResolvedValue(undefined),
      retryProjectCleanup: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService({
      membership: access,
      retirement,
    });

    service.closeProjectAdmission('project-alpha');

    await expect(service.removeMember({ projectId: 'project-alpha', memberId: 'member-a' })).rejects.toMatchObject({
      code: 'project-retired',
    });
    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
    });
    await expect(service.finalizeRetiredProject({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'success' });
    expect(access.removeMember).not.toHaveBeenCalled();
  });

  it('keeps every public async operation behind the global admission boundary', async () => {
    const service = createService();
    await service.close();
    const operations = TEST_COLLAB_FEATURE_PORT_METHODS.filter(name => name !== 'subscribe');
    const target = service as unknown as Record<
      typeof operations[number],
      (...args: readonly unknown[]) => Promise<unknown>
    >;

    for (const operation of operations) {
      await expect(target[operation]()).rejects.toMatchObject({
        code: 'cancelled',
        safeContext: { reason: 'collab-feature-closing' },
      });
    }
  });

  it('applies Project admission to the current blocked-operation inventory', async () => {
    const service = createService();
    const projectRequest = { projectId: 'project-alpha' };
    const blockedOperations = [
      ['reconnectProject', [projectRequest]],
      ['readSnapshot', ['project-alpha']],
      ['readPublishDescription', ['project-alpha']],
      ['publish', [projectRequest]],
      ['confirmPublish', [projectRequest]],
      ['prepareWorkingTreeReview', ['project-alpha']],
      ['readWorkingTreeReviewFile', [projectRequest]],
      ['preparePublicationReview', ['project-alpha']],
      ['readPublicationReviewFile', [projectRequest]],
      ['createInvitation', ['project-alpha']],
      ['revokeInvitation', ['project-alpha']],
      ['startHost', ['project-alpha']],
      ['stopHost', ['project-alpha']],
      ['prepareReview', ['project-alpha']],
      ['readReviewFile', [projectRequest]],
      ['addComment', [projectRequest]],
      ['listTickets', [projectRequest]],
      ['readTicket', ['project-alpha']],
      ['createTicket', [projectRequest]],
      ['updateTicketContent', [projectRequest]],
      ['addTicketComment', [projectRequest]],
      ['closeTicket', [projectRequest]],
      ['reopenTicket', [projectRequest]],
      ['updateRequestMetadata', [projectRequest]],
      ['acceptRequest', [projectRequest]],
      ['removeMember', [projectRequest]],
      ['leaveProject', [projectRequest]],
      ['createManagerResponsibilityOffer', [projectRequest]],
      ['cancelManagerResponsibilityOffer', [projectRequest]],
      ['promoteManager', [projectRequest]],
      ['demoteManager', [projectRequest]],
      ['createHostTransfer', [projectRequest]],
      ['acceptHostTransfer', [projectRequest]],
      ['declineHostTransfer', [projectRequest]],
      ['cancelHostTransfer', [projectRequest]],
      ['retireProject', [projectRequest]],
    ] as const;
    const target = service as unknown as Record<
      string,
      (...args: readonly unknown[]) => Promise<unknown>
    >;

    service.closeProjectAdmission('project-alpha');

    for (const [operation, args] of blockedOperations) {
      const outcome = await target[operation](...args).then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ error, status: 'rejected' as const }),
      );
      if (outcome.status === 'resolved') {
        throw new Error(`${operation} bypassed Project admission`);
      }
      expect(outcome.error).toMatchObject({
        code: 'project-retired',
        safeContext: {
          projectId: 'project-alpha',
          reason: 'collab-feature-project-closed',
        },
      });
    }
  });

  it('aborts and drains lifecycle recovery before feature disposal', async () => {
    const started = deferred<AbortSignal>();
    const settled = deferred<void>();
    const lifecycleRecovery = {
      close: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn(async ({ signal }: { signal?: AbortSignal } = {}) => {
        if (!signal) throw new Error('Missing lifecycle recovery signal');
        started.resolve(signal);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {
          once: true,
        }));
        settled.resolve();
      }),
    };
    const service = createService({
      lifecycleRecovery,
    });

    const recovery = service.restoreLifecycle();
    const signal = await started.promise;
    const closing = service.close();
    expect(signal.aborted).toBe(true);
    await settled.promise;
    await expect(Promise.all([recovery, closing])).resolves.toBeDefined();
    expect(lifecycleRecovery.close).toHaveBeenCalledTimes(1);
    await expect(service.restoreLifecycle()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('closes the Host-transfer lifecycle owner before feature disposal completes', async () => {
    const hostTransfer = {
      acceptHostTransfer: jest.fn(),
      cancelHostTransfer: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      createHostTransfer: jest.fn(),
      declineHostTransfer: jest.fn(),
    };
    const service = createService({
      hostTransfer,
    });

    await service.close();

    expect(hostTransfer.close).toHaveBeenCalledTimes(1);
  });

  it('closes the retirement event owner after admitted mutations drain', async () => {
    const retirement = {
      close: jest.fn().mockResolvedValue(undefined),
      finalizeRetiredProject: jest.fn(),
      retireProject: jest.fn(),
      retryProjectCleanup: jest.fn(),
    };
    const service = createService({
      retirement,
    });

    await service.close();

    expect(retirement.close).toHaveBeenCalledTimes(1);
  });

  it('reports a completed membership mutation after late presentation cancellation', async () => {
    const access = membershipControl();
    const controller = new AbortController();
    access.removeMember.mockImplementation(async () => {
      controller.abort();
    });
    const service = createService({
      membership: access,
    });

    await expect(service.removeMember({
      memberId: 'member-a',
      projectId: 'project-alpha',
    }, { signal: controller.signal })).resolves.toMatchObject({
      status: 'success',
    });
  });

  it('combines local Git and online coordination in Project inspection', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        coordination: {
          snapshot: { eventSequence: 2 },
          source: 'online',
          stale: false,
        },
        gitStatus: {
          aheadBy: 1,
          changedFiles: [{ path: 'note.md' }],
        },
        project: { id: 'project-alpha' },
      },
    });
    expect(publish.readGitStatus).toHaveBeenCalledWith(
      'project-alpha',
      {},
    );
    expect(publish.readCoordinationSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not publish feature state while reading Project inspection', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    const listener = jest.fn();
    service.subscribe(listener);

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { project: { id: 'project-alpha' } },
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves a final connectivity failure from publication visible as offline', async () => {
    const publish = publication();
    publish.tryAutoReconnect = jest.fn().mockResolvedValue(true);
    publish.readCoordinationSnapshot.mockRejectedValueOnce(
      new CollabError({ code: 'endpoint-unreachable' }),
    );
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { project: { id: 'project-alpha' } },
    });
    expect(publish.tryAutoReconnect).not.toHaveBeenCalled();
    expect(publish.readCoordinationSnapshot).toHaveBeenCalledTimes(1);
  });

  it('leaves a final operation timeout from publication visible as offline', async () => {
    const publish = publication();
    publish.tryAutoReconnect = jest.fn().mockResolvedValue(true);
    publish.readCoordinationSnapshot.mockRejectedValueOnce(
      new CollabError({ code: 'operation-timeout' }),
    );
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { project: { id: 'project-alpha' } },
    });
    expect(publish.tryAutoReconnect).not.toHaveBeenCalled();
    expect(publish.readCoordinationSnapshot).toHaveBeenCalledTimes(1);
  });

  it('accepts the publication session offline projection without reconnecting again', async () => {
    const publish = publication();
    publish.tryAutoReconnect = jest.fn().mockResolvedValue(true);
    publish.readCoordinationSnapshot.mockResolvedValueOnce({
      snapshot: authoritySnapshot(),
      source: 'cache',
      stale: true,
      syncState: {
        eventSequence: 1,
        generation: 1,
        projectId: 'project-alpha',
        status: 'offline',
      },
    });
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        coordination: { source: 'cache', stale: true },
        project: { id: 'project-alpha' },
      },
    });
    expect(publish.tryAutoReconnect).not.toHaveBeenCalled();
    expect(publish.readCoordinationSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps an old-endpoint TLS failure visible when discovery cannot verify a Host', async () => {
    const publish = publication();
    publish.tryAutoReconnect = jest.fn().mockResolvedValue(false);
    publish.readCoordinationSnapshot.mockRejectedValue(
      new CollabError({ code: 'tls-untrusted' }),
    );
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        project: { connectionStatus: 'needs-attention' },
      },
    });
    expect(publish.tryAutoReconnect).not.toHaveBeenCalled();
  });

  it('surfaces an authority split reported by the publication session', async () => {
    const publish = publication();
    const integrityError = new CollabError({
      code: 'authority-integrity-error',
      recoveryActions: ['open-diagnostics'],
    });
    publish.readCoordinationSnapshot.mockRejectedValue(integrityError);
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        project: { connectionStatus: 'needs-attention' },
      },
    });
  });

  it('inspects selection before reconciling and exposes a resumable conflict', async () => {
    const publish = publication();
    publish.findConflict.mockResolvedValue({
      status: 'success',
      value: conflictSession(),
    });
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    const selectionOrder: string[] = [];
    publish.findConflict.mockImplementation(async () => {
      selectionOrder.push('inspect');
      return { status: 'success', value: conflictSession() };
    });
    publish.synchronizeAcceptedMain.mockImplementation(async () => {
      selectionOrder.push('synchronize');
      return {
        status: 'success',
        value: {
          headOid: 'a'.repeat(40),
          projectId: 'project-alpha',
          state: 'already-current',
        },
      };
    });

    await expect(service.selectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        conflict: { descriptor: { operationId: 'conflict-alpha' } },
        project: { id: 'project-alpha' },
      },
    });
    expect(selectionOrder).toEqual(['inspect', 'synchronize']);
    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledWith(
      'project-alpha',
      { signal: expect.any(AbortSignal) },
    );
    expect(publish.findConflict).toHaveBeenCalledWith('project-alpha', {});
  });

  it('checks the persisted Project for accepted updates when Collab initializes', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });

    await expect(service.initialize()).resolves.toMatchObject({ status: 'success' });

    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledWith(
      'project-alpha',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('publishes ready state without waiting for accepted-main synchronization', async () => {
    let finishSynchronization!: () => void;
    const publish = publication();
    publish.synchronizeAcceptedMain.mockImplementation(() => new Promise(resolve => {
      finishSynchronization = () => resolve({
        status: 'success',
        value: {
          headOid: 'a'.repeat(40),
          projectId: 'project-alpha',
          state: 'deferred',
        },
      });
    }));
    const service = createService({
      publication: publish,
    });

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'success',
      value: { lifecycle: 'ready' },
    });
    expect(service.state.lifecycle).toBe('ready');
    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledWith(
      'project-alpha',
      { signal: expect.any(AbortSignal) },
    );
    finishSynchronization();
    await Promise.resolve();
  });

  it('waits for scheduled accepted-main synchronization before inspecting Git state', async () => {
    const synchronization = deferred<CollabResult<{
      headOid: string;
      projectId: 'project-alpha';
      state: 'deferred';
    }>>();
    const publish = publication();
    publish.synchronizeAcceptedMain.mockReturnValue(synchronization.promise);
    const service = createService({
      publication: publish,
    });
    await service.initialize();

    const inspection = service.inspectProject('project-alpha');
    for (let index = 0; index < 20; index += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    expect(publish.findConflict).not.toHaveBeenCalled();
    expect(publish.readGitStatus).not.toHaveBeenCalled();
    synchronization.resolve({
      status: 'success',
      value: {
        headOid: 'a'.repeat(40),
        projectId: 'project-alpha',
        state: 'deferred',
      },
    });
    await expect(inspection).resolves.toMatchObject({ status: 'success' });
    expect(publish.findConflict).toHaveBeenCalledWith('project-alpha', {});
    expect(publish.readGitStatus).toHaveBeenCalledWith('project-alpha', {});
  });

  it('registers selection synchronization before notifying inspection subscribers', async () => {
    const synchronization = deferred<CollabResult<{
      headOid: string;
      projectId: 'project-alpha';
      state: 'deferred';
    }>>();
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    await new Promise<void>(resolve => setImmediate(resolve));
    publish.findConflict.mockClear();
    publish.synchronizeAcceptedMain.mockClear();
    publish.synchronizeAcceptedMain.mockReturnValue(synchronization.promise);

    let observeSelection = false;
    let subscriberInspection: Promise<CollabResult<unknown>> | null = null;
    service.subscribe(state => {
      if (!observeSelection || state.selectedProjectId !== 'project-alpha') return;
      observeSelection = false;
      subscriberInspection = service.inspectProject('project-alpha');
    });
    observeSelection = true;

    await expect(service.selectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
    });

    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledTimes(1);
    expect(publish.findConflict).toHaveBeenCalledTimes(1);
    synchronization.resolve({
      status: 'success',
      value: {
        headOid: 'a'.repeat(40),
        projectId: 'project-alpha',
        state: 'deferred',
      },
    });
    await expect(subscriberInspection).resolves.toMatchObject({ status: 'success' });
    expect(publish.findConflict).toHaveBeenCalledTimes(2);
  });

  it('does not start selection synchronization during an earlier Project inspection', async () => {
    const earlierConflictRead = deferred<CollabResult<null>>();
    const earlierConflictStarted = deferred<void>();
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    await new Promise<void>(resolve => setImmediate(resolve));
    publish.findConflict.mockReset();
    publish.findConflict
      .mockImplementationOnce(() => {
        earlierConflictStarted.resolve();
        return earlierConflictRead.promise;
      })
      .mockResolvedValue({ status: 'success', value: null });
    publish.synchronizeAcceptedMain.mockClear();

    const earlierInspection = service.inspectProject('project-alpha');
    await earlierConflictStarted.promise;
    expect(publish.findConflict).toHaveBeenCalledTimes(1);

    await expect(service.selectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
    });
    expect(publish.synchronizeAcceptedMain).not.toHaveBeenCalled();

    earlierConflictRead.resolve({ status: 'success', value: null });
    await expect(earlierInspection).resolves.toMatchObject({ status: 'success' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledTimes(1);
  });

  it('keeps an aborted Project synchronization fenced after switching Projects', async () => {
    const alphaSynchronization = deferred<CollabResult<{
      headOid: string;
      projectId: 'project-alpha';
      state: 'deferred';
    }>>();
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          ...currentIndex.projects[0],
          id: 'project-beta',
          name: 'Beta',
          workspacePath: 'workspace/beta',
        },
      ],
    };
    await mkdir(path.join(vaultRoot, 'workspace', 'beta', '.git'), { recursive: true });
    const publish = publication();
    publish.synchronizeAcceptedMain.mockImplementation(projectId => (
      projectId === 'project-alpha'
        ? alphaSynchronization.promise
        : Promise.resolve({
          status: 'success',
          value: {
            headOid: 'a'.repeat(40),
            projectId: 'project-beta',
            state: 'already-current',
          },
        })
    ));
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    await expect(service.selectProject('project-beta')).resolves.toMatchObject({
      status: 'success',
    });
    const alphaConflictStarted = deferred<void>();
    publish.findConflict.mockImplementation(async projectId => {
      if (projectId === 'project-alpha') alphaConflictStarted.resolve();
      return { status: 'success', value: null };
    });

    const alphaInspection = service.inspectProject('project-alpha');
    const startedBeforeSynchronizationSettled = await Promise.race([
      alphaConflictStarted.promise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    expect(startedBeforeSynchronizationSettled).toBe(false);

    alphaSynchronization.resolve({
      status: 'success',
      value: {
        headOid: 'a'.repeat(40),
        projectId: 'project-alpha',
        state: 'deferred',
      },
    });
    await alphaConflictStarted.promise;
    await expect(alphaInspection).resolves.toMatchObject({ status: 'success' });
  });

  it('routes accepted-main invalidations through the feature synchronization fence', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    await new Promise<void>(resolve => setImmediate(resolve));
    publish.synchronizeAcceptedMain.mockClear();
    const invalidate = (publish.subscribeCoordination as jest.Mock).mock.calls[0]?.[0];

    invalidate?.('project-alpha', 'coordination-changed');
    expect(publish.synchronizeAcceptedMain).not.toHaveBeenCalled();

    invalidate?.('project-alpha', 'accepted-main-changed');
    await Promise.resolve();
    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledWith(
      'project-alpha',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not publish a persisted selection before its synchronization is registered', async () => {
    const selectionConflict = deferred<CollabResult<null>>();
    const selectionInspectionStarted = deferred<void>();
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          ...currentIndex.projects[0],
          id: 'project-beta',
          name: 'Beta',
          workspacePath: 'workspace/beta',
        },
      ],
    };
    await mkdir(path.join(vaultRoot, 'workspace', 'beta', '.git'), { recursive: true });
    const publish = publication();
    publish.findConflict.mockImplementation(projectId => {
      if (projectId !== 'project-beta') {
        return Promise.resolve({ status: 'success', value: null });
      }
      selectionInspectionStarted.resolve();
      return selectionConflict.promise;
    });
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    const selectedProjectIds: Array<string | null> = [];
    service.subscribe(state => selectedProjectIds.push(state.selectedProjectId));
    selectedProjectIds.length = 0;

    const selection = service.selectProject('project-beta');
    await selectionInspectionStarted.promise;
    await service.listProjects();

    expect(selectedProjectIds).not.toContain('project-beta');
    selectionConflict.resolve({ status: 'success', value: null });
    await expect(selection).resolves.toMatchObject({ status: 'success' });
    expect(selectedProjectIds).toContain('project-beta');
  });

  it('does not schedule synchronization after close interrupts selection', async () => {
    const selectionPersisted = deferred<void>();
    const continueSelection = deferred<void>();
    (foundation.local.projects.selectProject as jest.Mock).mockImplementation(
      async (projectId: 'project-alpha') => {
        currentIndex = { ...currentIndex, selectedProjectId: projectId };
        selectionPersisted.resolve();
        await continueSelection.promise;
      },
    );
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    await new Promise<void>(resolve => setImmediate(resolve));
    publish.synchronizeAcceptedMain.mockClear();

    const selection = service.selectProject('project-alpha');
    await selectionPersisted.promise;
    const closing = service.close();
    continueSelection.resolve();

    await expect(selection).resolves.toMatchObject({ status: 'cancelled' });
    await expect(closing).resolves.toBeUndefined();
    expect(publish.synchronizeAcceptedMain).not.toHaveBeenCalled();
  });

  it('delegates conflict operations through the feature boundary', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await expect(service.readConflict('conflict-alpha')).resolves.toMatchObject({
      status: 'success',
      value: { descriptor: { operationId: 'conflict-alpha' } },
    });
    await expect(service.readConflictFile({
      operationId: 'conflict-alpha',
      path: 'note.md',
    })).resolves.toMatchObject({ status: 'success', value: { kind: 'text' } });
  });

  it('keeps cached coordination visible while marking the Project offline', async () => {
    const publish = publication();
    publish.readCoordinationSnapshot.mockResolvedValue({
      snapshot: authoritySnapshot(),
      source: 'cache',
      stale: true,
      syncState: {
        eventSequence: 2,
        generation: 1,
        projectId: 'project-alpha',
        status: 'offline',
      },
    });
    const service = createService({
      publication: publish,
    });

    await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
      status: 'success',
      value: {
        coordination: { source: 'cache', stale: true },
        project: { connectionStatus: 'host-stopped' },
      },
    });
  });

  it('never dispatches Accept while a distinct Manager is offline from the Host', async () => {
    const publish = publication();
    const currentRequest = publishedRequest();
    publish.readCoordinationSnapshot.mockResolvedValue({
      snapshot: {
        ...authoritySnapshot(),
        openRequests: [currentRequest],
        project: {
          ...authoritySnapshot().project,
          hostMemberId: 'member-host-other',
        },
      },
      source: 'cache',
      stale: true,
      syncState: {
        eventSequence: 2,
        generation: 3,
        projectId: 'project-alpha',
        status: 'offline',
      },
    });
    const service = createService({
      publication: publish,
    });

    await expect(service.acceptRequest({
      expectedHeadOid: currentRequest.latestHeadOid,
      expectedMainOid: 'a'.repeat(40),
      expectedRequestRevision: currentRequest.revision,
      expectedResolvingTickets: [],
      projectId: 'project-alpha',
      requestId: currentRequest.id,
    })).resolves.toMatchObject({
      error: { code: 'authority-not-synchronized' },
      status: 'failure',
    });
    expect(publish.acceptRequest).not.toHaveBeenCalled();
  });

  it('delegates Accept replay after the synchronized snapshot no longer has the request', async () => {
    const publish = publication();
    publish.readCoordinationSnapshot.mockResolvedValue({
      snapshot: {
        ...authoritySnapshot(),
        project: {
          ...authoritySnapshot().project,
          mainOid: 'c'.repeat(40),
        },
      },
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 3,
        generation: 1,
        projectId: 'project-alpha',
        status: 'synchronized',
      },
    });
    const service = createService({
      publication: publish,
    });
    const request = {
      expectedHeadOid: 'b'.repeat(40),
      expectedMainOid: 'a'.repeat(40),
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      intentId: 'accept-replay-stable',
      projectId: 'project-alpha',
      requestId: 'request-a',
    };

    await expect(service.acceptRequest(request)).resolves.toMatchObject({
      status: 'success',
      value: { mainOid: 'c'.repeat(40), request: { status: 'merged' } },
    });
    expect(publish.acceptRequest).toHaveBeenCalledWith(
      request,
      {},
      'accept-accept-replay-stable',
    );
  });

  it('prepares a Request review, adds comments, and disposes the client projection', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });

    await expect(service.prepareReview('project-alpha', 'request-a')).resolves.toMatchObject({
      status: 'success',
      value: { comparisonKind: 'candidate' },
    });
    await expect(service.readReviewFile({
      comparisonBaseOid: 'a'.repeat(40),
      comparisonTargetOid: 'd'.repeat(40),
      file: {
        binary: false,
        kind: 'modified',
        largeForReview: false,
        path: 'note.md',
      },
      projectId: 'project-alpha',
      requestId: 'request-a',
    })).resolves.toMatchObject({ status: 'success', value: { kind: 'text' } });
    const addCommentRequest = {
      body: 'Please revise',
      intentId: 'intent-stable',
      projectId: 'project-alpha',
      requestId: 'request-a',
    };
    await expect(service.addComment(addCommentRequest)).resolves.toMatchObject({
      status: 'success',
      value: { id: 'comment-a' },
    });
    expect(publish.addComment).toHaveBeenCalledWith(
      addCommentRequest,
      {},
      'comment-intent-stable',
    );
    const acceptRequest = {
      expectedHeadOid: 'b'.repeat(40),
      expectedMainOid: 'a'.repeat(40),
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      intentId: 'accept-intent-stable',
      projectId: 'project-alpha',
      requestId: 'request-a',
    };
    publish.readCoordinationSnapshot.mockResolvedValue({
      snapshot: {
        ...authoritySnapshot(),
        openRequests: [publishedRequest()],
      },
      source: 'online',
      stale: false,
      syncState: {
        eventSequence: 2,
        generation: 1,
        projectId: 'project-alpha',
        status: 'synchronized',
      },
    });
    publish.synchronizeAcceptedMain.mockClear();
    await expect(service.acceptRequest(acceptRequest)).resolves.toMatchObject({
      status: 'success',
      value: { mainOid: 'c'.repeat(40), request: { status: 'merged' } },
    });
    expect(publish.acceptRequest).toHaveBeenCalledWith(
      acceptRequest,
      {},
      'accept-accept-intent-stable',
    );
    await Promise.resolve();
    expect(publish.synchronizeAcceptedMain).toHaveBeenCalledWith(
      'project-alpha',
      { signal: expect.any(AbortSignal) },
    );
    await service.close();
    const coordinationSubscription = (publish.subscribeCoordination as jest.Mock)
      .mock.results[0]?.value as {
      dispose: jest.Mock;
    };
    expect(coordinationSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(publish.close).toHaveBeenCalledTimes(1);
  });

  it('exposes read-only working-tree review through the feature boundary', async () => {
    const publish = publication();
    const review = {
      baseOid: 'a'.repeat(40),
      files: [{
        binary: false,
        kind: 'modified' as const,
        largeForReview: false,
        path: 'note.md',
      }],
      headOid: 'b'.repeat(40),
      kind: 'working-tree' as const,
      projectId: 'project-alpha',
      snapshotId: 'd'.repeat(64),
    };
    publish.prepareWorkingTreeReview.mockResolvedValue(review);
    publish.readWorkingTreeReviewFile.mockResolvedValue({
      file: review.files[0],
      kind: 'text',
      newText: 'working\n',
      oldText: 'head\n',
    });
    const service = createService({
      publication: publish,
    });

    await expect(service.prepareWorkingTreeReview(
      'project-alpha',
      review.baseOid,
    )).resolves.toEqual({
      status: 'success',
      value: review,
    });
    await expect(service.readWorkingTreeReviewFile({
      baseOid: review.baseOid,
      file: review.files[0],
      headOid: review.headOid,
      projectId: review.projectId,
      snapshotId: review.snapshotId,
    })).resolves.toMatchObject({ status: 'success', value: { kind: 'text' } });

    expect(publish.publish).not.toHaveBeenCalled();
  });

  it('publishes a presentation invalidation when selected coordination changes', async () => {
    const publish = publication();
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    const listener = jest.fn();
    let observedCalls = 0;
    const invalidationPublished = new Promise<void>(resolve => {
      service.subscribe(state => {
        listener(state);
        observedCalls += 1;
        if (observedCalls === 2) resolve();
      });
    });
    const invalidate = (publish.subscribeCoordination as jest.Mock).mock.calls[0]?.[0];

    invalidate?.('project-alpha');
    await invalidationPublished;

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('publishes one observable operation and cancels it on Project switch', async () => {
    const publish = publication();
    const pending = deferred<CollabResult<CollabPublishOutcome>>();
    publish.publish.mockReturnValue(pending.promise);
    currentIndex = {
      ...currentIndex,
      projects: [
        ...currentIndex.projects,
        {
          ...currentIndex.projects[0],
          id: 'project-beta',
          name: 'Beta',
          workspacePath: 'workspace/beta',
        },
      ],
    };
    await mkdir(path.join(vaultRoot, 'workspace', 'beta', '.git'), { recursive: true });
    const service = createService({
      publication: publish,
    });
    await service.initialize();
    const result = service.publish({
      description: 'Published change',
      projectId: 'project-alpha',
    });
    await Promise.resolve();

    expect(service.state.activeOperation).toMatchObject({
      kind: 'publish',
      phase: 'validating',
    });
    const signal = publish.publish.mock.calls[0]?.[1]?.signal as AbortSignal;
    await service.selectProject('project-beta');
    expect(signal.aborted).toBe(true);
    pending.resolve({ durableProgress: false, status: 'cancelled' });
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
    expect(service.state.activeOperation).toBeUndefined();
    expect(service.state.selectedProjectId).toBe('project-beta');
  });

  it('does not let a failing presentation subscriber break initialization', async () => {
    const service = createService();
    service.subscribe(() => {
      throw new Error('detached view');
    });

    await expect(service.initialize()).resolves.toMatchObject({ status: 'success' });
    expect(service.state.lifecycle).toBe('ready');
  });
});
