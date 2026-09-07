import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type CollabChangeRequest } from '@claudian-collab/protocol';

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
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.setTimeout(30_000);

const PERSONAL_REF = 'refs/heads/members/member-a';
const PROJECT_ID = 'project-a';

describe('Publish offline recovery integration', () => {
  let root: string;
  let git: GitRepositoryService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-publish-'));
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

  it('commits once while offline and resumes push/request sync from repository state', async () => {
    const authorityPath = path.join(root, 'authority.git');
    const seedPath = path.join(root, 'seed');
    const clonesPath = path.join(root, 'clones');
    await Promise.all([mkdir(authorityPath), mkdir(seedPath), mkdir(clonesPath)]);
    await git.initializeWorkingRepository(seedPath);
    await git.configureLocalRepository(seedPath, {
      memberId: 'member-a',
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
      branch: 'members/member-a',
      directoryName: 'project-a',
      parentDirectory: clonesPath,
      remoteUrl: authorityPath,
    });
    await git.configureLocalRepository(repositoryPath, {
      memberId: 'member-a',
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await writeFile(path.join(repositoryPath, 'note.md'), 'offline change\n');

    const context: PublishProjectContext = {
      memberId: 'member-a',
      personalRef: PERSONAL_REF,
      projectId: PROJECT_ID,
      remoteUrl: authorityPath,
      repositoryPath,
    };
    const network = new ToggleNetworkPort();
    network.online = false;
    const nativeRepository = new NativeGitPublishRepository(git, {
      acceptedState: rejectingAcceptedState(),
      network,
    });
    const requests = new RecordingRequestPort();
    const publicationState = new MemoryPublicationState(mainOid);
    const candidates = unusedCandidates();
    const comparisons = { compare: async () => [] };

    const offline = new PublishCoordinator(
      fixedProject(context),
      nativeRepository,
      requests,
      noOpSafety(),
      publicationState,
      candidates,
      comparisons,
      { createOperationId: () => 'offline-publish' },
    );
    const publishRequest = { description: 'Offline note', projectId: PROJECT_ID };
    const first = await offline.publish(publishRequest);
    expect(first).toMatchObject({
      status: 'success',
      value: { state: 'committed-locally' },
    });
    const committedOid = await git.resolveRef(repositoryPath, PERSONAL_REF);
    expect(committedOid).not.toBe(mainOid);
    expect(await git.countDivergence(repositoryPath, committedOid!, mainOid))
      .toEqual({ leftOnly: 1, rightOnly: 0 });

    network.online = true;

    const resumed = new PublishCoordinator(
      fixedProject(context),
      new NativeGitPublishRepository(git, {
        acceptedState: rejectingAcceptedState(),
        network,
      }),
      requests,
      noOpSafety(),
      publicationState,
      candidates,
      comparisons,
      { createOperationId: () => 'resumed-publish' },
    );
    const second = await resumed.publish(publishRequest);

    expect(second).toMatchObject({
      status: 'success',
      value: {
        localHeadOid: committedOid,
        remoteHeadOid: committedOid,
        state: 'request-synchronized',
      },
    });
    expect(await git.resolveRef(authorityPath, PERSONAL_REF)).toBe(committedOid);
    expect(await git.listRemoteUrls(repositoryPath, 'origin')).toEqual([authorityPath]);
    expect(network.calls).toBe(4);
    expect(requests.heads).toEqual([committedOid]);
    expect(await git.countDivergence(repositoryPath, committedOid!, mainOid))
      .toEqual({ leftOnly: 1, rightOnly: 0 });
  });
});

class ToggleNetworkPort implements PublishGitNetworkPort {
  calls = 0;
  online = true;

  async withNetwork<T>(
    context: PublishProjectContext,
    operation: Parameters<PublishGitNetworkPort['withNetwork']>[1],
  ): Promise<T> {
    this.calls += 1;
    if (!this.online) throw new CollabError({ code: 'endpoint-unreachable' });
    return operation(undefined, context.remoteUrl!) as Promise<T>;
  }
}

class MemoryPublicationState {
  private record: CollabPublicationStateRecord;

  constructor(baseMainOid: string) {
    this.record = {
      baseMainOid,
      operation: null,
      projectId: PROJECT_ID,
      schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
  }

  async load(): Promise<CollabPublicationStateRecord> {
    return this.record;
  }

  async save(record: CollabPublicationStateRecord): Promise<void> {
    this.record = record;
  }
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

class RecordingRequestPort {
  heads: string[] = [];

  async ensure(input: { headOid: string }): Promise<CollabChangeRequest> {
    this.heads.push(input.headOid);
    return {
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      description: 'Published change',
      firstBaseOid: input.headOid,
      id: 'request-a',
      latestHeadOid: input.headOid,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
  }
}

function fixedProject(context: PublishProjectContext) {
  return {
    load: async () => context,
    revalidate: async () => undefined,
  };
}

function noOpSafety() {
  return { assertSafe: async () => undefined };
}

function rejectingAcceptedState(): PublishAcceptedStatePort {
  return {
    classifyDivergence: async () => {
      throw new Error('Accepted integration is not expected');
    },
  };
}
