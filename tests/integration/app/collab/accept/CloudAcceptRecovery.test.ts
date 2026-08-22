import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
} from '@claudian/collab-protocol';

import { CollabClientProjection } from '@/app/collab/client/CollabClientProjection';
import {
  type CollabLocalCloudMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import {
  COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
} from '@/app/collab/publish/CollabRequestDraftRecord';
import { CollabRequestDraftStore } from '@/app/collab/publish/CollabRequestDraftStore';
import {
  NativeGitPublishRepository,
  type PublishGitNetworkPort,
} from '@/app/collab/publish/NativeGitPublishRepository';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
import { ReconciliationCoordinator } from '@/app/collab/reconciliation/ReconciliationCoordinator';
import { ReconciliationMutationSafety } from '@/app/collab/reconciliation/ReconciliationMutationSafety';
import { ReconciliationRepository } from '@/app/collab/reconciliation/ReconciliationRepository';
import {
  CloudAuthorityAdapter,
  type CloudAuthorityHttpRequest,
  type CloudAuthorityHttpResponse,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.setTimeout(30_000);

const PROJECT_ID = 'project-a';
const MANAGER_ID = 'member-a';
const CONTRIBUTOR_ID = 'member-b';
const MANAGER_REF = `refs/heads/members/${MANAGER_ID}`;
const CONTRIBUTOR_REF = `refs/heads/members/${CONTRIBUTOR_ID}`;
const CREATED_AT = '2026-08-23T00:00:00.000Z';
const ACCEPTED_AT = '2026-08-23T00:01:00.000Z';

describe('Cloud Accept recovery integration', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('recovers a committed Accept from snapshot, detail, and main without repeating it', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-accept-'));
    const authorityPath = path.join(root, 'authority.git');
    const clonesPath = path.join(root, 'clones');
    const seedPath = path.join(root, 'seed');
    const vaultRoot = path.join(root, 'vault');
    await Promise.all([
      mkdir(authorityPath),
      mkdir(clonesPath),
      mkdir(seedPath),
      mkdir(vaultRoot),
    ]);
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    const git = new GitRepositoryService(runner);
    await git.initializeWorkingRepository(seedPath);
    await git.configureLocalRepository(seedPath, {
      memberId: MANAGER_ID,
      personalRef: MANAGER_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await writeFile(path.join(seedPath, 'base.md'), 'Base\n');
    await git.stageAll(seedPath);
    const baseOid = await git.createCommitFromIndex(seedPath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    await git.createRef(seedPath, MANAGER_REF, baseOid);
    await writeFile(path.join(seedPath, 'accepted.md'), 'Accepted contribution\n');
    await git.stageAll(seedPath);
    const acceptedOid = await git.createCommitFromIndex(seedPath, {
      expectedRefOid: null,
      message: 'Contribution',
      parents: [baseOid],
      ref: CONTRIBUTOR_REF,
    });
    await git.initializeBareRepository(authorityPath);
    await git.addRemote(seedPath, 'origin', authorityPath);
    await git.push(seedPath, 'origin', 'refs/heads/main:refs/heads/main');
    await git.push(seedPath, 'origin', `${MANAGER_REF}:${MANAGER_REF}`);
    await git.push(seedPath, 'origin', `${CONTRIBUTOR_REF}:${CONTRIBUTOR_REF}`);

    const repositoryPath = await git.cloneRepository({
      branch: `members/${MANAGER_ID}`,
      directoryName: PROJECT_ID,
      parentDirectory: clonesPath,
      remoteUrl: authorityPath,
    });
    await git.configureLocalRepository(repositoryPath, {
      memberId: MANAGER_ID,
      personalRef: MANAGER_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });

    const projects = new CollabLocalProjectRepository(vaultRoot, {
      now: () => new Date(CREATED_AT),
    });
    await projects.saveMembership(membership());
    const drafts = new CollabRequestDraftStore(projects);
    const retainedDraft = {
      createdAt: CREATED_AT,
      description: 'Keep this unpublished draft',
      projectId: PROJECT_ID,
      schemaVersion: COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
      syncState: 'local' as const,
      updatedAt: CREATED_AT,
    };
    await drafts.save(retainedDraft);
    const publicationState = new CollabPublicationStateStore(projects);
    await publicationState.save({
      baseMainOid: baseOid,
      operation: null,
      projectId: PROJECT_ID,
      schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
      updatedAt: CREATED_AT,
    });

    const transport = new CommitThenDisconnectTransport(
      git,
      authorityPath,
      baseOid,
      acceptedOid,
    );
    const firstAuthority = await new CloudAuthorityAdapter({
      request: input => transport.request(input),
    }).create(membership());
    const firstProjection = new CollabClientProjection(projects, firstAuthority.control);

    await expect(firstProjection.acceptRequest(
      PROJECT_ID,
      'request-one',
      baseOid,
      acceptedOid,
      1,
      [],
      {},
      'accept-lost-response',
    )).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    expect(await git.resolveRef(authorityPath, 'refs/heads/main')).toBe(acceptedOid);
    firstProjection.dispose();
    firstAuthority.dispose();

    const restartedAuthority = await new CloudAuthorityAdapter({
      request: input => transport.request(input),
    }).create(await projects.loadMembership(PROJECT_ID) as CollabLocalCloudMembershipRecord);
    const projection = new CollabClientProjection(
      new CollabLocalProjectRepository(vaultRoot),
      restartedAuthority.control,
      { now: () => new Date(ACCEPTED_AT) },
    );

    await expect(projection.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
      snapshot: {
        eventSequence: 1,
        openRequests: [],
        project: { authorityKind: 'cloud', mainOid: acceptedOid },
      },
      source: 'online',
      stale: false,
    });
    await expect(projection.readRequest(PROJECT_ID, 'request-one')).resolves.toMatchObject({
      currentMainOid: acceptedOid,
      request: {
        id: 'request-one',
        mergedOid: acceptedOid,
        status: 'merged',
      },
      reviewedHeadOid: acceptedOid,
    });
    expect((await projects.loadMembership(PROJECT_ID))?.lastEventSequence).toBe(1);

    const context: PublishProjectContext = {
      allowHostRemoteRepair: false,
      memberId: MANAGER_ID,
      personalRef: MANAGER_REF,
      projectId: PROJECT_ID,
      remoteUrl: authorityPath,
      repositoryPath,
    };
    const acceptedState = new NativeGitAcceptedStateIntegrator(git, runner);
    const repository = new NativeGitPublishRepository(git, {
      acceptedState,
      network: new DirectNetwork(),
    });
    const reconciliation = new ReconciliationCoordinator(
      fixedProject(context),
      new ReconciliationRepository(repository, acceptedState),
      restartedAuthority.control,
      new ReconciliationMutationSafety(acceptedState),
      publicationState,
      { createOperationId: () => 'cloud-accept-recovery' },
    );

    await expect(reconciliation.reconcile(PROJECT_ID)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: acceptedOid,
        projectId: PROJECT_ID,
        state: 'fast-forwarded',
      },
    });
    expect(await git.resolveRef(repositoryPath, MANAGER_REF)).toBe(acceptedOid);
    expect(await git.resolveRef(authorityPath, MANAGER_REF)).toBe(acceptedOid);
    await expect(drafts.load(PROJECT_ID)).resolves.toEqual(retainedDraft);
    await expect(publicationState.load(PROJECT_ID)).resolves.toMatchObject({
      baseMainOid: acceptedOid,
      operation: null,
    });
    expect(transport.acceptCalls).toBe(1);
    expect(transport.acceptIntents).toEqual(['accept-lost-response']);

    projection.dispose();
    restartedAuthority.dispose();
  });
});

class CommitThenDisconnectTransport {
  acceptCalls = 0;
  acceptIntents: string[] = [];
  private accepted = false;

  constructor(
    private readonly git: GitRepositoryService,
    private readonly authorityPath: string,
    private readonly baseOid: string,
    private readonly acceptedOid: string,
  ) {}

  async request(input: CloudAuthorityHttpRequest): Promise<CloudAuthorityHttpResponse> {
    if (input.method === 'GET') {
      return {
        body: collabCloudCapabilityDocument(
          ['accept', 'project-snapshot', 'requests'],
          capabilityLimits(),
        ),
        contentType: 'application/json',
        status: 200,
      };
    }
    const operation = input.url.split('/').at(-1);
    const envelope = input.body as {
      readonly data: Readonly<Record<string, unknown>>;
      readonly requestId: string;
    };
    if (operation === 'acceptRequest') {
      this.acceptCalls += 1;
      this.acceptIntents.push(String(envelope.data.idempotencyKey));
      if (!this.accepted) {
        const result = await this.git.compareAndSwapRef(
          this.authorityPath,
          'refs/heads/main',
          this.acceptedOid,
          this.baseOid,
        );
        if (!result.updated) throw new Error('Expected authoritative main to advance');
        this.accepted = true;
      }
      throw new CollabError({ code: 'endpoint-unreachable' });
    }
    if (operation === 'getProjectSnapshot') {
      return this.success(envelope.requestId, cloudSnapshot(this.acceptedOid));
    }
    if (operation === 'getRequest') {
      return this.success(envelope.requestId, {
        comments: { comments: [] },
        currentMainOid: this.acceptedOid,
        request: acceptedRequest(this.baseOid, this.acceptedOid),
        reviewedHeadOid: this.acceptedOid,
        reviewCondition: 'clean',
      });
    }
    throw new Error(`Unexpected Cloud operation: ${String(operation)}`);
  }

  private success(requestId: string, data: unknown): CloudAuthorityHttpResponse {
    return {
      body: collabCloudSuccessEnvelope(requestId, data),
      contentType: 'application/json; charset=utf-8',
      status: 200,
    };
  }
}

class DirectNetwork implements PublishGitNetworkPort {
  withNetwork<T>(
    _context: PublishProjectContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }
}

function fixedProject(context: PublishProjectContext) {
  return {
    load: async () => context,
    revalidate: async () => undefined,
  };
}

function membership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 1,
      developmentActorId: MANAGER_ID,
      gitRemoteUrl: `https://cloud.example.test/v1/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 4,
    },
    createdAt: CREATED_AT,
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: MANAGER_ID,
      personalRef: MANAGER_REF,
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Project',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

function member(id: string, displayName: string, role: 'manager' | 'member') {
  return {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName,
    id,
    personalRef: `refs/heads/members/${id}`,
    role,
    status: 'active',
  };
}

function cloudSnapshot(mainOid: string) {
  const currentMember = member(MANAGER_ID, 'Alice', 'manager');
  return {
    currentMember,
    eventSequence: 1,
    members: [
      currentMember,
      member(CONTRIBUTOR_ID, 'Bob', 'member'),
    ],
    openRequests: [],
    openTicketCount: 0,
    project: {
      createdAt: CREATED_AT,
      expectedMainOid: mainOid,
      id: PROJECT_ID,
      mainRef: 'refs/heads/main',
      name: 'Cloud Project',
    },
    ticketHighlights: [],
  };
}

function acceptedRequest(baseOid: string, acceptedOid: string) {
  return {
    commentCount: 0,
    createdAt: CREATED_AT,
    description: 'Accepted contribution',
    firstBaseOid: baseOid,
    id: 'request-one',
    latestHeadOid: acceptedOid,
    memberId: CONTRIBUTOR_ID,
    mergedOid: acceptedOid,
    revision: 1,
    status: 'merged',
    ticketRelations: [],
    updatedAt: ACCEPTED_AT,
  };
}

function capabilityLimits() {
  return {
    maxDevelopmentBootstrapGitBundleBytes: 1_024,
    maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
    maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
    maxEventReplay: 100,
    maxGitReceivePackBytes: 1_024,
    maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
    maxRepositoryBytes: 1_024,
  };
}
