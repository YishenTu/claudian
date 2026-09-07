import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';

import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import {
  NativeGitPublishRepository,
  type PublishAcceptedStatePort,
  type PublishGitNetworkPort,
} from '@/app/collab/publish/NativeGitPublishRepository';
import {
  PublishCoordinator,
  type PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';
import {
  CloudAuthorityAdapter,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type {
  CloudAuthorityHttpRequest,
  CloudAuthorityHttpResponse,
} from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.setTimeout(30_000);

const ACTOR_ID = 'member-a';
const CREATED_AT = '2026-08-23T00:00:00.000Z';
const PERSONAL_REF = `refs/heads/members/${ACTOR_ID}`;
const PROJECT_ID = 'project-a';

describe('Cloud Publish recovery integration', () => {
  let git: GitRepositoryService;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-publish-'));
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    git = new GitRepositoryService(new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    }));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('replays one durable Request after its first Cloud JSON response is lost', async () => {
    const authorityPath = path.join(root, 'authority.git');
    const clonesPath = path.join(root, 'clones');
    const seedPath = path.join(root, 'seed');
    await Promise.all([mkdir(authorityPath), mkdir(clonesPath), mkdir(seedPath)]);
    await git.initializeWorkingRepository(seedPath);
    await git.configureLocalRepository(seedPath, {
      memberId: ACTOR_ID,
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await git.stageAll(seedPath);
    const mainOid = await git.createCommitFromIndex(seedPath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    await git.createRef(seedPath, PERSONAL_REF, mainOid);
    await git.initializeBareRepository(authorityPath);
    await git.addRemote(seedPath, 'origin', authorityPath);
    await git.push(seedPath, 'origin', 'refs/heads/main:refs/heads/main');
    await git.push(seedPath, 'origin', `${PERSONAL_REF}:${PERSONAL_REF}`);

    const repositoryPath = await git.cloneRepository({
      branch: `members/${ACTOR_ID}`,
      directoryName: PROJECT_ID,
      parentDirectory: clonesPath,
      remoteUrl: authorityPath,
    });
    await git.configureLocalRepository(repositoryPath, {
      memberId: ACTOR_ID,
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await writeFile(path.join(repositoryPath, 'note.md'), 'Cloud contribution\n');

    const transport = new LostResponseCloudTransport(mainOid);
    const authority = await new CloudAuthorityAdapter({
      request: input => transport.request(input),
    }).create(membership(authorityPath));
    const context: PublishProjectContext = {
      memberId: ACTOR_ID,
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      remoteUrl: authority.git.remoteUrl,
      repositoryPath,
    };
    const repository = new NativeGitPublishRepository(git, {
      acceptedState: rejectingAcceptedState(),
      network: new DirectNetwork(),
    });
    const state = new MemoryPublicationState(mainOid);
    const createCoordinator = () => new PublishCoordinator(
      fixedProject(context),
      repository,
      authority.control,
      { assertSafe: async () => undefined },
      state,
      unusedCandidates(),
      { compare: async () => [] },
      { createOperationId: () => 'cloud-publish' },
    );

    await expect(createCoordinator().publish({
      description: 'Cloud contribution',
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({
      status: 'success',
      value: { state: 'pushed' },
    });
    expect(state.current.operation).toMatchObject({ phase: 'pushed' });
    const committedOid = await git.resolveRef(repositoryPath, PERSONAL_REF);
    expect(await git.resolveRef(authorityPath, PERSONAL_REF)).toBe(committedOid);

    await expect(createCoordinator().publish({
      description: 'Cloud contribution',
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        request: { id: 'request-cloud' },
        state: 'request-synchronized',
      },
    });

    expect(transport.createdRequests).toBe(1);
    expect(transport.requestIntents).toHaveLength(2);
    expect(transport.requestIntents[1]).toBe(transport.requestIntents[0]);
    expect(await git.countDivergence(repositoryPath, committedOid!, mainOid))
      .toEqual({ leftOnly: 1, rightOnly: 0 });
    expect(state.current.operation).toBeNull();
  });
});

class LostResponseCloudTransport {
  createdRequests = 0;
  private lostFirstResponse = false;
  requestIntents: string[] = [];
  private requestRecord: Readonly<Record<string, unknown>> | null = null;

  constructor(private readonly mainOid: string) {}

  async request(input: CloudAuthorityHttpRequest): Promise<CloudAuthorityHttpResponse> {
    if (input.method === 'GET') {
      return {
        body: collabCloudCapabilityDocument(['requests'], capabilityLimits()),
        contentType: 'application/json',
        status: 200,
      };
    }
    const envelope = input.body as {
      readonly data: Readonly<Record<string, unknown>>;
      readonly requestId: string;
    };
    const intent = String(envelope.data.idempotencyKey);
    this.requestIntents.push(intent);
    if (!this.requestRecord) {
      this.createdRequests += 1;
      this.requestRecord = {
        commentCount: 0,
        createdAt: CREATED_AT,
        description: envelope.data.description,
        firstBaseOid: this.mainOid,
        id: 'request-cloud',
        latestHeadOid: envelope.data.headOid,
        memberId: ACTOR_ID,
        revision: 1,
        status: 'open',
        ticketRelations: [],
        updatedAt: CREATED_AT,
      };
    }
    if (!this.lostFirstResponse) {
      this.lostFirstResponse = true;
      throw new CollabError({ code: 'endpoint-unreachable' });
    }
    return {
      body: collabCloudSuccessEnvelope(envelope.requestId, {
        mainOid: this.mainOid,
        request: this.requestRecord,
      }),
      contentType: 'application/json',
      status: 200,
    };
  }
}

class DirectNetwork implements PublishGitNetworkPort {
  withNetwork<T>(
    context: PublishProjectContext,
    operation: Parameters<PublishGitNetworkPort['withNetwork']>[1],
  ): Promise<T> {
    return operation(undefined, context.remoteUrl!) as Promise<T>;
  }
}

class MemoryPublicationState {
  current: CollabPublicationStateRecord;

  constructor(baseMainOid: string) {
    this.current = {
      baseMainOid,
      operation: null,
      projectId: PROJECT_ID,
      schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
      updatedAt: CREATED_AT,
    };
  }

  async load(): Promise<CollabPublicationStateRecord> { return this.current; }
  async save(record: CollabPublicationStateRecord): Promise<void> { this.current = record; }
}

function membership(gitRemoteUrl: string): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 2,
      developmentActorId: ACTOR_ID,
      gitRemoteUrl,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 6,
    },
    createdAt: CREATED_AT,
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: ACTOR_ID,
      personalRef: PERSONAL_REF,
      role: 'member',
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

function capabilityLimits() {
  return {
    maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maxCheckpointRepositoryBundleBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
    maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    maxDevelopmentBootstrapGitBundleBytes: 1_024,
    maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
    maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
    maxEventReplay: 100,
    maxGitReceivePackBytes: 1_024,
    maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
    maxRepositoryBytes: 1_024,
  };
}

function fixedProject(context: PublishProjectContext) {
  return {
    load: async () => context,
    revalidate: async () => undefined,
  };
}

function rejectingAcceptedState(): PublishAcceptedStatePort {
  return {
    classifyDivergence: async () => {
      throw new Error('Accepted integration is not expected');
    },
  };
}

function unusedCandidates() {
  const unused = async () => {
    throw new Error('A current-base Publish must not use a publication candidate');
  };
  return {
    apply: unused,
    assertRetained: unused,
    cleanup: unused,
    prepare: unused,
  };
}
