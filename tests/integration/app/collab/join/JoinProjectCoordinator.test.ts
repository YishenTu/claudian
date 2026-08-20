import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef } from '@claudian/collab-protocol';

import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  JoinProjectCoordinator,
  type JoinProjectFoundationPort,
} from '@/app/collab/join/JoinProjectCoordinator';
import {
  decodeJoinProjectRecord,
  type JoinProjectRecord,
} from '@/app/collab/join/JoinProjectRecord';
import type {
  CollabJsonRequest,
} from '@/app/collab/lan/CollabHttpClient';
import {
  InvitationCodec,
  type LanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = new Date('2026-08-08T00:00:00.000Z');
const OID = 'a'.repeat(40);
const CA_FINGERPRINT = 'ab'.repeat(32);
const CA_PEM = '-----BEGIN CERTIFICATE-----\nTEST CA\n-----END CERTIFICATE-----\n';

interface TestHarness {
  readonly cloneInputs: unknown[];
  readonly controlPaths: string[];
  readonly coordinator: JoinProjectCoordinator;
  readonly projects: CollabLocalProjectRepository;
  readonly root: string;
  readonly seedTrustedPendingJoin: (encodedInvitation: string) => Promise<void>;
  readonly setCloneFailure: (failure: boolean) => void;
  readonly setExpiry: (expiresAt: string) => void;
  readonly setIndexPath: (path: string) => void;
  readonly setRecordSaveFailure: (phase: string | null) => void;
  readonly setMembershipSaveFailure: (failure: boolean) => void;
}

describe('JoinProjectCoordinator', () => {
  let roots: string[];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map(root => rm(root, { force: true, recursive: true })));
  });

  it('persists the attempt, stages and validates clone, activates, and atomically finishes', async () => {
    const harness = await createHarness({
      getProjectsFolder: () => 'Shared/Collab Projects',
    });
    const invitation = createInvitation('project-alpha');

    await expect(harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(invitation),
      memberDisplayName: 'Alice',
    })).resolves.toEqual({
      status: 'success',
      value: expect.objectContaining({
        connectionStatus: 'connected',
        health: 'healthy',
        id: 'project-alpha',
        name: 'Alpha',
        role: 'member',
        workspacePath: 'Shared/Collab Projects/project-alpha',
      }),
    });

    const membership = await harness.projects.loadMembership('project-alpha');
    expect(membership).toMatchObject({
      authority: {
        endpoint: invitation.endpoint,
        gitRemoteUrl: `${invitation.endpoint}/v1/git/project-alpha/repository.git`,
        hostCaFingerprint: invitation.caFingerprint,
      },
      member: {
        credential: Buffer.alloc(32, 9).toString('base64url'),
        id: 'member-alice',
        personalRef: collabMemberRef('member-alice'),
      },
      project: {
        name: 'Alpha',
        workspacePath: 'Shared/Collab Projects/project-alpha',
      },
    });
    await expect(stat(path.join(
      harness.root,
      'Shared',
      'Collab Projects',
      'project-alpha',
      'note.md',
    )))
      .resolves.toMatchObject({});
    await expect(stat(path.join(
      harness.root,
      'Shared',
      'Collab Projects',
      '.claudian-join-join-alpha',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(harness.projects.loadProjectDocument(
      'project-alpha',
      'pending-operation',
      decodeJoinProjectRecord,
    )).resolves.toBeNull();
    expect(JSON.stringify(harness.cloneInputs)).not.toContain(invitation.invitationSecret);
  });

  it('rejects invalid invitations and duplicate local membership without workspace mutation', async () => {
    const harness = await createHarness();
    await expect(harness.coordinator.joinProject({
      encodedInvitation: 'not-an-invitation',
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({
      error: { code: 'invitation-invalid' },
      status: 'failure',
    });
    expect((await harness.projects.loadIndex()).projects).toEqual([]);

    const encodedInvitation = encodeInvitation(createInvitation('project-alpha'));
    await expect(harness.coordinator.joinProject({
      encodedInvitation,
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({ status: 'success' });
    await expect(harness.coordinator.joinProject({
      encodedInvitation,
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'operation-failed' }),
      status: 'failure',
    });
  });

  it('rejects a newly pasted v7 invitation but recovers an already-owned v7 Join over v9', async () => {
    const legacyInvitation = {
      ...createInvitation('project-alpha'),
      protocolVersion: 7 as const,
    };
    const encodedInvitation = encodeLegacyInvitation(legacyInvitation);
    const interactive = await createHarness();

    await expect(interactive.coordinator.joinProject({
      encodedInvitation,
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({
      error: { code: 'protocol-version-unsupported' },
      status: 'failure',
    });
    expect((await interactive.projects.loadIndex()).projects).toEqual([]);

    const recovering = await createHarness();
    await recovering.seedTrustedPendingJoin(encodedInvitation);
    recovering.setRecordSaveFailure('membership-created');
    await expect(recovering.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({
        durablePhase: 'committed',
        operationId: 'join-alpha',
        status: 'recovery-required',
      });
    await expect(recovering.projects.loadProjectDocument(
      'project-alpha',
      'pending-operation',
      decodeJoinProjectRecord,
    )).resolves.toMatchObject({
      encodedInvitation,
      phase: 'trusted',
    });

    await expect(recovering.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({ status: 'success' });
    expect(recovering.controlPaths).toEqual([
      '/v9/projects/project-alpha/join-attempts',
      '/v9/projects/project-alpha/join-attempts',
      '/v9/projects/project-alpha/join-attempts/join-alpha/activate',
    ]);
  });

  it('preserves pending credential after clone failure and resumes with the same attempt', async () => {
    let projectsFolder = 'Shared/First Projects';
    const harness = await createHarness({ getProjectsFolder: () => projectsFolder });
    harness.setCloneFailure(true);
    const result = await harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    });
    expect(result).toMatchObject({
      durablePhase: 'committed',
      durableProgress: true,
      operationId: 'join-alpha',
      status: 'recovery-required',
    });
    const pending = await harness.projects.loadProjectDocument(
      'project-alpha',
      'pending-operation',
      decodeJoinProjectRecord,
    );
    expect(pending).toMatchObject({
      encodedInvitation: null,
      joinAttemptId: 'join-alpha',
      memberCredential: Buffer.alloc(32, 9).toString('base64url'),
      memberId: 'member-alice',
      phase: 'membership-created',
      projectsFolder: 'Shared/First Projects',
    });
    await expect(stat(path.join(
      harness.root,
      'Shared',
      'First Projects',
      '.claudian-join-join-alpha',
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    harness.setCloneFailure(false);
    projectsFolder = 'Shared/Second Projects';
    await expect(harness.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({
        status: 'success',
        value: { workspacePath: 'Shared/First Projects/project-alpha' },
      });
    await expect(stat(path.join(
      harness.root,
      'Shared',
      'Second Projects',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never cleans generated-looking staging from an unowned captured root', async () => {
    const projectsFolder = 'Captured Projects';
    const harness = await createHarness({ getProjectsFolder: () => projectsFolder });
    harness.setCloneFailure(true);
    await expect(harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({ status: 'recovery-required' });

    await rm(path.join(harness.root, projectsFolder), { recursive: true });
    const stagingPath = path.join(
      harness.root,
      projectsFolder,
      '.claudian-join-join-alpha',
    );
    await mkdir(stagingPath, { recursive: true });
    await writeFile(path.join(stagingPath, 'keep.md'), 'user content\n');

    await expect(harness.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({ status: 'recovery-required' });
    await expect(stat(path.join(stagingPath, 'keep.md'))).resolves.toBeDefined();
  });

  it('rejects an unsafe tracked path before exposing the final working copy', async () => {
    const harness = await createHarness();
    harness.setIndexPath('../outside.md');
    await expect(harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({ status: 'recovery-required' });
    await expect(stat(path.join(harness.root, 'workspace', 'project-alpha')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(
      harness.root,
      'workspace',
      '.claudian-join-join-alpha',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('expires an unactivated membership without exposing a final directory', async () => {
    const harness = await createHarness();
    harness.setExpiry(NOW.toISOString());
    await expect(harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({
      error: { code: 'membership-revoked' },
      status: 'failure',
    });
    expect((await harness.projects.loadIndex()).projects).toEqual([]);
    await expect(stat(path.join(harness.root, 'workspace', 'project-alpha')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['membership-created', 'trusted'],
    ['clone-completed', 'membership-created'],
    ['placed', 'clone-completed'],
    ['activated', 'placed'],
  ])('resumes after interruption while saving %s', async (failedPhase, persistedPhase) => {
    const harness = await createHarness();
    harness.setRecordSaveFailure(failedPhase);
    const interrupted = await harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    });
    expect(interrupted).toMatchObject({
      operationId: 'join-alpha',
      status: 'recovery-required',
    });
    await expect(harness.projects.loadProjectDocument(
      'project-alpha',
      'pending-operation',
      decodeJoinProjectRecord,
    )).resolves.toMatchObject({ phase: persistedPhase });

    await expect(harness.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({ status: 'success' });
  });

  it('resumes after activation when final membership persistence fails', async () => {
    const harness = await createHarness();
    harness.setMembershipSaveFailure(true);
    await expect(harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-alpha')),
      memberDisplayName: 'Alice',
    })).resolves.toMatchObject({ status: 'recovery-required' });
    await expect(harness.projects.loadProjectDocument(
      'project-alpha',
      'pending-operation',
      decodeJoinProjectRecord,
    )).resolves.toMatchObject({ phase: 'activated' });

    await expect(harness.coordinator.resumeJoin({ operationId: 'join-alpha' }))
      .resolves.toMatchObject({ status: 'success' });
  });

  it('cancels the older intent before the latest Join proceeds', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstStarted = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const harness = await createHarness({
      onBootstrap: async (projectId, signal) => {
        if (projectId !== 'project-first') return;
        releaseFirst?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new CollabError({
            code: 'cancelled',
            recoveryActions: ['retry'],
            safeContext: { reason: 'test-cancelled' },
          })), { once: true });
        });
      },
    });
    const first = harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-first')),
      memberDisplayName: 'Alice',
    });
    await firstStarted;
    const second = harness.coordinator.joinProject({
      encodedInvitation: encodeInvitation(createInvitation('project-second')),
      memberDisplayName: 'Alice',
    });

    await expect(first).resolves.toMatchObject({
      durableProgress: false,
      status: 'cancelled',
    });
    await expect(second).resolves.toMatchObject({
      status: 'success',
      value: { id: 'project-second' },
    });
    expect((await harness.projects.loadIndex()).projects.map(project => project.id))
      .toEqual(['project-second']);
  });

  async function createHarness(options: {
    readonly getProjectsFolder?: () => string;
    readonly onBootstrap?: (projectId: string, signal?: AbortSignal) => Promise<void>;
  } = {}): Promise<TestHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-join-coordinator-'));
    roots.push(root);
    const projects = new CollabLocalProjectRepository(root, { now: () => NOW });
    const workspace = new CollabWorkspaceService(root);
    const pathPolicy = new CollabPathPolicy();
    const cloneInputs: unknown[] = [];
    const controlPaths: string[] = [];
    let cloneFailure = false;
    let expiresAt = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
    let failMembershipSave = false;
    let failRecordSavePhase: string | null = null;
    let indexPath = 'note.md';
    let currentProjectId = 'project-alpha';
    const credential = Buffer.alloc(32, 9).toString('base64url');
    const git = fakeGitFoundation(
      root,
      cloneInputs,
      () => cloneFailure,
      () => indexPath,
    );
    const projectPort = {
      loadIndex: projects.loadIndex.bind(projects),
      loadMembership: projects.loadMembership.bind(projects),
      loadProjectDocument: projects.loadProjectDocument.bind(projects),
      listPendingOperationProjectIds: projects.listPendingOperationProjectIds.bind(projects),
      discardPendingOperation: projects.discardPendingOperation.bind(projects),
      removeProject: projects.removeProject.bind(projects),
      removeProjectDocument: projects.removeProjectDocument.bind(projects),
      saveMembership: async (...args: Parameters<CollabLocalProjectRepository['saveMembership']>) => {
        if (failMembershipSave) {
          failMembershipSave = false;
          throw new Error('Injected membership save failure');
        }
        return projects.saveMembership(...args);
      },
      saveProjectDocument: async (
        ...args: Parameters<CollabLocalProjectRepository['saveProjectDocument']>
      ) => {
        const document = args[2] as { readonly phase?: string };
        if (document.phase === failRecordSavePhase) {
          failRecordSavePhase = null;
          throw new Error('Injected record save failure');
        }
        return projects.saveProjectDocument(...args);
      },
      selectProject: projects.selectProject.bind(projects),
      upsertProject: projects.upsertProject.bind(projects),
    } as JoinProjectFoundationPort['local']['projects'];
    const foundation: JoinProjectFoundationPort = {
      local: { pathPolicy, projects: projectPort, workspace },
      requireGitFoundation: async () => git,
    };
    const coordinator = new JoinProjectCoordinator(foundation, {
      createHttpClient: trustStore => ({
        bootstrapInvitation: async (invitation, requestOptions) => {
          currentProjectId = invitation.projectId;
          await options.onBootstrap?.(invitation.projectId, requestOptions?.signal);
          await trustStore.save({
            caCertificatePem: CA_PEM,
            caFingerprint: invitation.caFingerprint,
            endpoint: invitation.endpoint,
            projectId: invitation.projectId,
          });
          return fakePinnedClient(
            () => currentProjectId,
            () => expiresAt,
            credential,
            controlPaths,
          ) as never;
        },
        fromStoredTrust: async projectId => {
          currentProjectId = projectId;
          expect(await trustStore.read(projectId)).toMatchObject({ projectId });
          return fakePinnedClient(
            () => currentProjectId,
            () => expiresAt,
            credential,
            controlPaths,
          ) as never;
        },
      }),
      createJoinAttemptId: () => 'join-alpha',
      ...(options.getProjectsFolder
        ? { getProjectsFolder: options.getProjectsFolder }
        : {}),
      invitationCodec: new InvitationCodec({
        isAddressAllowed: address => address === '127.0.0.1',
        now: () => NOW,
      }),
      now: () => NOW,
      vaultRoot: root,
    });
    return {
      cloneInputs,
      controlPaths,
      coordinator,
      projects,
      root,
      seedTrustedPendingJoin: async encodedInvitation => {
        await workspace.claimProjectsFolder('workspace');
        const record: JoinProjectRecord = {
          createdAt: NOW.toISOString(),
          encodedInvitation,
          endpoint: 'https://127.0.0.1:54545',
          hostCaCertificatePem: CA_PEM,
          hostCaFingerprint: CA_FINGERPRINT,
          joinAttemptId: 'join-alpha',
          lastEventSequence: null,
          memberCredential: null,
          memberDisplayName: 'Alice',
          memberId: null,
          memberRole: null,
          membershipExpiresAt: null,
          operationId: 'join-alpha',
          operationKind: 'join-project',
          phase: 'trusted',
          projectId: 'project-alpha',
          projectName: null,
          projectsFolder: 'workspace',
          schemaVersion: 2,
          slug: 'project-alpha',
          stagingDirectoryName: '.claudian-join-join-alpha',
          updatedAt: NOW.toISOString(),
        };
        await projects.saveProjectDocument(
          record.projectId,
          'pending-operation',
          record,
        );
        await projects.upsertProject({
          authorityKind: 'lan',
          createdAt: record.createdAt,
          id: record.projectId,
          name: record.projectId,
          updatedAt: record.updatedAt,
          workspacePath: 'workspace/project-alpha',
        });
      },
      setCloneFailure: value => {
        cloneFailure = value;
      },
      setExpiry: value => {
        expiresAt = value;
      },
      setIndexPath: value => {
        indexPath = value;
      },
      setMembershipSaveFailure: value => {
        failMembershipSave = value;
      },
      setRecordSaveFailure: phase => {
        failRecordSavePhase = phase;
      },
    };
  }
});

function fakeGitFoundation(
  root: string,
  cloneInputs: unknown[],
  shouldFailClone: () => boolean,
  indexPath: () => string,
): CollabGitFoundation {
  return {
    repositories: {
      assertHealthy: jest.fn(),
      cloneRepository: jest.fn(async input => {
        cloneInputs.push(input);
        if (shouldFailClone()) throw new CollabError({
          code: 'endpoint-unreachable',
          recoveryActions: ['retry'],
          safeContext: { reason: 'test-clone-failed' },
        });
        const clonePath = path.join(input.parentDirectory, input.directoryName);
        await mkdir(path.join(clonePath, '.git'), { recursive: true });
        await writeFile(path.join(clonePath, 'note.md'), 'joined\n');
        return clonePath;
      }),
      configureLocalRepository: jest.fn(),
      getWorkingTreeStatus: jest.fn(async () => []),
      resolveRef: jest.fn(async () => OID),
    },
    runner: {
      run: jest.fn(async request => {
        if (request.args[0] === 'symbolic-ref') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: Buffer.from(`${collabMemberRef('member-alice')}\n`),
          };
        }
        if (request.args[0] === 'ls-files') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: Buffer.from(`100644 ${OID} 0\t${indexPath()}\0`),
          };
        }
        throw new Error(`Unexpected Git request: ${request.args.join(' ')}`);
      }),
    },
    runtime: {
      capabilities: {
        catFileBatch: true,
        commitTree: true,
        diffTreeNul: true,
        httpBackend: true,
        mergeTreeWriteTree: true,
        statusPorcelainV2Nul: true,
      },
      execPath: path.join(root, 'git-core'),
      executablePath: path.join(root, 'git'),
      httpBackendPath: path.join(root, 'git-http-backend'),
      version: { major: 2, minor: 50, patch: 0, raw: '2.50.0' },
    },
  } as unknown as CollabGitFoundation;
}

function fakePinnedClient(
  projectId: () => string,
  expiresAt: () => string,
  credential: string,
  controlPaths: string[] = [],
) {
  const request = async <T>(definition: CollabJsonRequest<T>): Promise<T> => {
    controlPaths.push(definition.path);
    const id = projectId();
    if (definition.path.endsWith('/activate')) {
      return definition.decode(envelope({
        currentMember: member('active'),
        eventSequence: 3,
        members: [member('active')],
        openRequests: [],
        openTicketCount: 0,
        project: {
          authorityKind: 'lan',
          createdAt: NOW.toISOString(),
          hostMemberId: 'member-host',
          id,
          mainOid: OID,
          mainRef: COLLAB_MAIN_REF,
          managerSetGeneration: 0,
          name: id === 'project-alpha'
            ? 'Alpha'
            : id.slice('project-'.length),
        },
        ticketHighlights: [],
      }));
    }
    return definition.decode(envelope({
      joinAttempt: {
        expiresAt: expiresAt(),
        id: 'join-alpha',
        member: member('pending'),
        memberCredential: credential,
        projectId: id,
      },
    }));
  };
  return {
    requestWithInvitation: request,
    requestWithMember: request,
  };
}

function member(status: 'active' | 'pending') {
  return {
    ...(status === 'active' ? { activatedAt: NOW.toISOString() } : {}),
    createdAt: NOW.toISOString(),
    displayName: 'Alice',
    id: 'member-alice',
    personalRef: collabMemberRef('member-alice'),
    role: 'member',
    status,
  };
}

function envelope(data: unknown) {
  return {
    data,
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-alpha',
  };
}

function createInvitation(projectId: string): LanCollabInvitation {
  return {
    caFingerprint: CA_FINGERPRINT,
    endpoint: 'https://127.0.0.1:54545',
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    invitationId: `invite-${projectId}`,
    invitationSecret: Buffer.alloc(32, 5).toString('base64url'),
    projectId,
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
  };
}

function encodeInvitation(invitation: LanCollabInvitation): string {
  return new InvitationCodec({
    isAddressAllowed: address => address === '127.0.0.1',
    now: () => NOW,
  }).encode(invitation);
}

function encodeLegacyInvitation(
  invitation: Omit<LanCollabInvitation, 'protocolVersion'> & { protocolVersion: 7 },
): string {
  const payload = Buffer.from(JSON.stringify(invitation), 'utf8').toString('base64url');
  return `claudian-collab:v7:${payload}`;
}
