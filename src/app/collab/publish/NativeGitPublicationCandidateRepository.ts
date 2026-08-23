import { collabMemberRef, type CollabOperationId, isCollabGitOid, isCollabOpaqueId } from '@claudian-collab/protocol';

import { COLLAB_ORIGIN_MAIN_REF } from '@/app/collab/git/collabGitRefs';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import type {
  GitCommitTreeInput,
  GitMergeTreeResult,
  GitRefUpdateResult,
  GitRepositoryService,
  GitStatusEntry,
} from '@/app/collab/git/GitRepositoryService';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CANDIDATE_IDENTITY = Object.freeze({
  email: 'collab@claudian.local',
  name: 'Claudian Collab',
});
const CANDIDATE_MESSAGE = 'Prepare publication candidate';

export interface PublicationCandidateGitPort {
  commitTree(repositoryPath: string, input: GitCommitTreeInput): Promise<string>;
  createRef(repositoryPath: string, ref: string, oid: string): Promise<void>;
  deleteRefIfMatches(
    repositoryPath: string,
    ref: string,
    expectedOid: string,
  ): Promise<GitRefUpdateResult>;
  getWorkingTreeStatus(repositoryPath: string): Promise<readonly GitStatusEntry[]>;
  isAncestor(
    repositoryPath: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean>;
  mergeTree(
    repositoryPath: string,
    acceptedOid: string,
    memberOid: string,
  ): Promise<GitMergeTreeResult>;
  resolveRef(repositoryPath: string, ref: string): Promise<string | null>;
}

export interface PublicationCandidateInput {
  readonly contributionHeadOid: string;
  readonly currentMainOid: string;
  readonly operationId: CollabOperationId;
}

function candidateError(
  code: 'content-conflict' | 'repository-invalid' | 'stale-main' | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'content-conflict'
      ? ['review-conflicts']
      : code === 'stale-main' || code === 'working-tree-busy'
        ? ['retry']
        : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function requireOid(value: string, reason: string): string {
  if (!isCollabGitOid(value)) throw candidateError('repository-invalid', reason);
  return value;
}

export function publicationCandidateRef(operationId: CollabOperationId): string {
  if (!isCollabOpaqueId(operationId)) {
    throw candidateError('repository-invalid', 'publication-operation-id-invalid');
  }
  return `refs/claudian/publications/${operationId}`;
}

export class NativeGitPublicationCandidateRepository {
  constructor(
    private readonly git: PublicationCandidateGitPort,
    private readonly runner: Pick<GitCommandRunner, 'run'>,
  ) {}

  async prepare(
    context: PublishProjectContext,
    input: PublicationCandidateInput,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertContext(context);
    const contributionHeadOid = requireOid(
      input.contributionHeadOid,
      'publication-contribution-head-invalid',
    );
    const currentMainOid = requireOid(
      input.currentMainOid,
      'publication-current-main-invalid',
    );
    const candidateRef = publicationCandidateRef(input.operationId);
    const merge = await this.git.mergeTree(
      context.repositoryPath,
      currentMainOid,
      contributionHeadOid,
    );
    if (merge.kind !== 'clean') {
      throw candidateError('content-conflict', 'publication-candidate-conflicting');
    }

    const existingOid = await this.git.resolveRef(context.repositoryPath, candidateRef);
    if (existingOid) {
      if (await this.matchesCandidate(
        context.repositoryPath,
        existingOid,
        merge.treeOid,
        contributionHeadOid,
        currentMainOid,
        signal,
      )) {
        return existingOid;
      }
      const deleted = await this.git.deleteRefIfMatches(
        context.repositoryPath,
        candidateRef,
        existingOid,
      );
      if (!deleted.updated) {
        throw candidateError('repository-invalid', 'publication-candidate-ref-changed');
      }
    }

    const candidateOid = await this.git.commitTree(context.repositoryPath, {
      identity: CANDIDATE_IDENTITY,
      message: CANDIDATE_MESSAGE,
      parents: [contributionHeadOid, currentMainOid],
      treeOid: merge.treeOid,
    });
    await this.git.createRef(context.repositoryPath, candidateRef, candidateOid);
    return candidateOid;
  }

  async assertRetained(
    context: PublishProjectContext,
    input: PublicationCandidateInput & { readonly candidateOid: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const candidateOid = requireOid(input.candidateOid, 'publication-candidate-oid-invalid');
    if (candidateOid === input.contributionHeadOid) {
      const [personalOid, mainOid] = await Promise.all([
        this.git.resolveRef(context.repositoryPath, context.personalRef),
        this.git.resolveRef(context.repositoryPath, COLLAB_ORIGIN_MAIN_REF),
      ]);
      if (
        personalOid !== candidateOid
        || mainOid !== input.currentMainOid
        || !await this.git.isAncestor(
          context.repositoryPath,
          input.currentMainOid,
          candidateOid,
        )
      ) {
        throw candidateError('repository-invalid', 'publication-direct-candidate-invalid');
      }
      return;
    }
    const retained = await this.git.resolveRef(
      context.repositoryPath,
      publicationCandidateRef(input.operationId),
    );
    if (retained !== candidateOid) {
      throw candidateError('repository-invalid', 'publication-candidate-ref-mismatch');
    }
    if (!await this.matchesCandidate(
      context.repositoryPath,
      candidateOid,
      null,
      input.contributionHeadOid,
      input.currentMainOid,
      signal,
    )) {
      throw candidateError('repository-invalid', 'publication-candidate-invalid');
    }
  }

  async apply(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    input: PublicationCandidateInput & { readonly candidateOid: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertRetained(context, input, signal);
    const [symbolicHead, personalOid, mainOid, status] = await Promise.all([
      this.readSymbolicHead(context, signal),
      this.git.resolveRef(context.repositoryPath, context.personalRef),
      this.git.resolveRef(context.repositoryPath, COLLAB_ORIGIN_MAIN_REF),
      this.git.getWorkingTreeStatus(context.repositoryPath),
    ]);
    if (
      symbolicHead !== context.personalRef
      || mainOid !== input.currentMainOid
      || mainOid !== expected.acceptedMainOid
      || !expected.workingTreeClean
      || expected.changedFiles.length !== 0
      || status.length !== 0
    ) {
      throw candidateError('working-tree-busy', 'publication-apply-state-changed');
    }
    if (personalOid === input.candidateOid && expected.headOid === input.candidateOid) return;
    if (
      personalOid !== input.contributionHeadOid
      || personalOid !== expected.headOid
      || !await this.git.isAncestor(
        context.repositoryPath,
        input.contributionHeadOid,
        input.candidateOid,
      )
    ) {
      throw candidateError('working-tree-busy', 'publication-apply-state-changed');
    }
    await this.runner.run({
      args: [
        'merge',
        '--ff-only',
        '--no-edit',
        '--no-stat',
        '--no-verify',
        input.candidateOid,
      ],
      cwd: context.repositoryPath,
      signal,
      suppressHooks: true,
    });
    const [appliedOid, appliedStatus] = await Promise.all([
      this.git.resolveRef(context.repositoryPath, context.personalRef),
      this.git.getWorkingTreeStatus(context.repositoryPath),
    ]);
    if (appliedOid !== input.candidateOid || appliedStatus.length !== 0) {
      throw candidateError('repository-invalid', 'publication-apply-not-exact');
    }
  }

  async cleanup(
    context: PublishProjectContext,
    operationId: CollabOperationId,
    candidateOid: string,
  ): Promise<void> {
    const result = await this.git.deleteRefIfMatches(
      context.repositoryPath,
      publicationCandidateRef(operationId),
      requireOid(candidateOid, 'publication-candidate-oid-invalid'),
    );
    if (!result.updated && result.currentOid !== null) {
      throw candidateError('repository-invalid', 'publication-candidate-cleanup-mismatch');
    }
  }

  private assertContext(context: PublishProjectContext): void {
    if (context.personalRef !== collabMemberRef(context.memberId)) {
      throw candidateError('repository-invalid', 'publication-personal-ref-mismatch');
    }
  }

  private async matchesCandidate(
    repositoryPath: string,
    candidateOid: string,
    expectedTreeOid: string | null,
    contributionHeadOid: string,
    currentMainOid: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.runner.run({
      args: ['show', '-s', '--format=%T%n%P', candidateOid],
      cwd: repositoryPath,
      maxStdoutBytes: 512,
      signal,
    });
    const [treeOid, parents, ...extra] = result.stdout.toString('utf8').trim().split(/\r?\n/);
    return extra.length === 0
      && isCollabGitOid(treeOid)
      && (expectedTreeOid === null || treeOid === expectedTreeOid)
      && parents === `${contributionHeadOid} ${currentMainOid}`;
  }

  private async readSymbolicHead(
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: ['symbolic-ref', '--quiet', 'HEAD'],
      cwd: context.repositoryPath,
      maxStdoutBytes: 512,
      signal,
    });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
  }
}

export function createNativeGitPublicationCandidateRepository(
  git: GitRepositoryService,
  runner: GitCommandRunner,
): NativeGitPublicationCandidateRepository {
  return new NativeGitPublicationCandidateRepository(git, runner);
}
