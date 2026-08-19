import type { GitCommandRequest } from '@/app/collab/git/GitCommandRunner';
import type {
  GitCommitTreeInput,
  GitMergeTreeResult,
  GitRefUpdateResult,
} from '@/app/collab/git/GitRepositoryService';
import {
  NativeGitPublicationCandidateRepository,
  type PublicationCandidateGitPort,
  publicationCandidateRef,
} from '@/app/collab/publish/NativeGitPublicationCandidateRepository';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';

const CONTRIBUTION = '1'.repeat(40);
const MAIN = '2'.repeat(40);
const TREE = '3'.repeat(40);
const CANDIDATE = '4'.repeat(40);
const CONTEXT: PublishProjectContext = {
  allowHostRemoteRepair: false,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.2/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};
const INPUT = {
  contributionHeadOid: CONTRIBUTION,
  currentMainOid: MAIN,
  operationId: 'publish-a',
};

class FakeGit implements PublicationCandidateGitPort {
  ref: string | null = null;
  personalOid = CONTRIBUTION;
  mainOid = MAIN;
  status: readonly never[] = [];
  merge: GitMergeTreeResult = { kind: 'clean', treeOid: TREE };
  commitTree = jest.fn(async (_path: string, _input: GitCommitTreeInput) => CANDIDATE);
  createRef = jest.fn(async (_path: string, _ref: string, oid: string) => {
    this.ref = oid;
  });
  deleteRefIfMatches = jest.fn(async (
    _path: string,
    _ref: string,
    expectedOid: string,
  ): Promise<GitRefUpdateResult> => {
    if (this.ref !== expectedOid) return { currentOid: this.ref, updated: false };
    this.ref = null;
    return { currentOid: null, updated: true };
  });
  getWorkingTreeStatus = jest.fn(async () => this.status);
  isAncestor = jest.fn(async () => true);
  mergeTree = jest.fn(async () => this.merge);
  resolveRef = jest.fn(async (_path: string, ref: string) => {
    if (ref === CONTEXT.personalRef) return this.personalOid;
    if (ref === 'refs/remotes/origin/main') return this.mainOid;
    if (ref === publicationCandidateRef(INPUT.operationId)) return this.ref;
    return null;
  });
}

function snapshot(
  overrides: Partial<PublishRepositorySnapshot> = {},
): PublishRepositorySnapshot {
  return {
    acceptedMainOid: MAIN,
    changedFiles: [],
    headOid: CONTRIBUTION,
    includesAcceptedMain: false,
    personalAheadBy: 1,
    personalBehindBy: 0,
    personalRemoteOid: CONTRIBUTION,
    workingTreeClean: true,
    ...overrides,
  };
}

function createSubject() {
  const git = new FakeGit();
  const runner = {
    run: jest.fn(async (request: GitCommandRequest) => {
      if (request.args[0] === 'show') {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(`${TREE}\n${CONTRIBUTION} ${MAIN}\n`),
        };
      }
      if (request.args[0] === 'symbolic-ref') {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(`${CONTEXT.personalRef}\n`),
        };
      }
      if (request.args[0] === 'merge') {
        git.personalOid = CANDIDATE;
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
      }
      throw new Error('Unexpected Git command');
    }),
  };
  return {
    git,
    runner,
    subject: new NativeGitPublicationCandidateRepository(git, runner as never),
  };
}

describe('NativeGitPublicationCandidateRepository', () => {
  it('retains a clean two-parent candidate without moving the personal ref', async () => {
    const { git, subject } = createSubject();

    await expect(subject.prepare(CONTEXT, INPUT)).resolves.toBe(CANDIDATE);
    expect(git.mergeTree).toHaveBeenCalledWith(
      CONTEXT.repositoryPath,
      MAIN,
      CONTRIBUTION,
    );
    expect(git.commitTree).toHaveBeenCalledWith(CONTEXT.repositoryPath, {
      identity: {
        email: 'collab@claudian.local',
        name: 'Claudian Collab',
      },
      message: 'Prepare publication candidate',
      parents: [CONTRIBUTION, MAIN],
      treeOid: TREE,
    });
    expect(git.createRef).toHaveBeenCalledWith(
      CONTEXT.repositoryPath,
      'refs/claudian/publications/publish-a',
      CANDIDATE,
    );
    expect(git.personalOid).toBe(CONTRIBUTION);
  });

  it('reuses only an exact retained candidate after interrupted persistence', async () => {
    const { git, subject } = createSubject();
    git.ref = CANDIDATE;

    await expect(subject.prepare(CONTEXT, INPUT)).resolves.toBe(CANDIDATE);
    expect(git.commitTree).not.toHaveBeenCalled();
    expect(git.createRef).not.toHaveBeenCalled();
  });

  it('accepts an exact retained resolution candidate without recomputing a clean merge', async () => {
    const { git, subject } = createSubject();
    git.ref = CANDIDATE;
    git.merge = { kind: 'conflicting', treeOid: null };

    await expect(subject.assertRetained(
      CONTEXT,
      { ...INPUT, candidateOid: CANDIDATE },
    )).resolves.toBeUndefined();

    expect(git.mergeTree).not.toHaveBeenCalled();
  });

  it('treats an exact personal head as retained for a reprepared current-base review', async () => {
    const { git, runner, subject } = createSubject();

    await expect(subject.assertRetained(
      CONTEXT,
      { ...INPUT, candidateOid: CONTRIBUTION },
    )).resolves.toBeUndefined();

    expect(git.isAncestor).toHaveBeenCalledWith(
      CONTEXT.repositoryPath,
      MAIN,
      CONTRIBUTION,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('fast-forwards the visible personal branch only after exact validation', async () => {
    const { git, runner, subject } = createSubject();
    git.ref = CANDIDATE;

    await subject.apply(CONTEXT, snapshot(), { ...INPUT, candidateOid: CANDIDATE });

    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['merge', '--ff-only', CANDIDATE]),
      suppressHooks: true,
    }));
    expect(git.personalOid).toBe(CANDIDATE);
  });

  it('recognizes an exact candidate already applied before phase persistence', async () => {
    const { git, runner, subject } = createSubject();
    git.ref = CANDIDATE;
    git.personalOid = CANDIDATE;

    await expect(subject.apply(
      CONTEXT,
      snapshot({ headOid: CANDIDATE }),
      { ...INPUT, candidateOid: CANDIDATE },
    )).resolves.toBeUndefined();

    expect(runner.run).not.toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['merge']),
    }));
  });

  it('uses expected-OID cleanup and rejects a changed private ref', async () => {
    const { git, subject } = createSubject();
    git.ref = '5'.repeat(40);

    await expect(subject.cleanup(CONTEXT, INPUT.operationId, CANDIDATE))
      .rejects.toMatchObject({
        code: 'repository-invalid',
        safeContext: { reason: 'publication-candidate-cleanup-mismatch' },
      });
  });
});
