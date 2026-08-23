import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  COLLAB_MEMBER_REF_PREFIX,
  type CollabFileChangeKind,
  type CollabOperationId,
} from '@claudian-collab/protocol';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { ensureTrustedCollabOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import {
  COLLAB_MAIN_FETCH_REFSPEC,
  COLLAB_ORIGIN_MAIN_REF,
  collabBranchName,
  collabOriginTrackingRef,
} from '@/app/collab/git/collabGitRefs';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import type {
  GitRepositoryService,
  GitStatusEntry,
  GitWorkingTreeBranchState,
} from '@/app/collab/git/GitRepositoryService';
import {
  type PublishAcceptedState,
  type PublishChangedFile,
  type PublishProjectContext,
  type PublishRepositoryPort,
  type PublishRepositorySnapshot,
  publishSnapshotFingerprint,
} from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const ORIGIN = 'origin';

export interface PublishAcceptedStatePort {
  classifyDivergence(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<PublishAcceptedState>;
}

export interface PublishGitNetworkPort {
  withNetwork<T>(
    context: PublishProjectContext,
    operation: (network?: GitNetworkEnvironment) => Promise<T>,
  ): Promise<T>;
}

export interface NativeGitPublishRepositoryOptions {
  readonly acceptedState: PublishAcceptedStatePort;
  readonly network?: PublishGitNetworkPort;
  readonly pathPolicy?: CollabPathPolicy;
}

function repositoryError(
  code:
    | 'path-outside-project'
    | 'repository-invalid'
    | 'unsupported-file-type'
    | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'working-tree-busy' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function remotePersonalRef(personalRef: string): string {
  if (!personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)) {
    throw repositoryError('repository-invalid', 'publish-personal-ref-invalid');
  }
  return collabOriginTrackingRef(personalRef);
}

function branchDivergence(
  branch: GitWorkingTreeBranchState,
  personalRef: string,
  headOid: string,
): { readonly leftOnly: number; readonly rightOnly: number } | null {
  if (!personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)) return null;
  const branchName = collabBranchName(personalRef);
  if (
    branch.headOid !== headOid
    || branch.headName !== branchName
    || branch.upstreamName !== `${ORIGIN}/${branchName}`
    || branch.aheadBy === null
    || branch.behindBy === null
  ) {
    return null;
  }
  return { leftOnly: branch.aheadBy, rightOnly: branch.behindBy };
}

function statusKind(entry: GitStatusEntry): CollabFileChangeKind {
  if (entry.kind === 'unmerged') {
    throw repositoryError('working-tree-busy', 'publish-unmerged-index');
  }
  if (entry.kind === 'untracked') return 'added';
  const status = entry.indexStatus === '.' ? entry.worktreeStatus : entry.indexStatus;
  switch (status) {
    case 'A': return 'added';
    case 'C': return 'copied';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'T': return 'type-changed';
    default: throw repositoryError('repository-invalid', 'publish-status-unknown');
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class NativeGitPublishRepository implements PublishRepositoryPort {
  private readonly network: PublishGitNetworkPort;
  private readonly pathPolicy: CollabPathPolicy;

  constructor(
    private readonly git: GitRepositoryService,
    private readonly options: NativeGitPublishRepositoryOptions,
  ) {
    this.pathPolicy = options.pathPolicy ?? new CollabPathPolicy();
    this.network = options.network ?? {
      withNetwork: (_context, operation) => operation(),
    };
  }

  async inspect(
    context: PublishProjectContext,
    _signal?: AbortSignal,
  ): Promise<PublishRepositorySnapshot> {
    return this.git.withReadSession(context.repositoryPath, 'working', async session => {
      const workingTree = await session.getWorkingTreeState();
      const entries = workingTree.entries;
      const changedFiles = await Promise.all(entries.map(entry => this.changedFile(
        context.repositoryPath,
        entry,
      )));
      changedFiles.sort((left, right) => (
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      ));
      const remotePersonal = remotePersonalRef(context.personalRef);
      const remoteMain = COLLAB_ORIGIN_MAIN_REF;
      const refs = await session.resolveRefs([
        context.personalRef,
        remotePersonal,
        remoteMain,
      ]);
      const headOid = refs.get(context.personalRef) ?? null;
      const personalRemoteOid = refs.get(remotePersonal) ?? null;
      const acceptedMainOid = refs.get(remoteMain) ?? null;
      const includesAcceptedMain = headOid && acceptedMainOid
        ? headOid === acceptedMainOid || await session.isAncestor(acceptedMainOid, headOid)
        : null;
      const divergence = headOid && personalRemoteOid
        ? branchDivergence(workingTree.branch, context.personalRef, headOid)
          ?? await session.countDivergence(headOid, personalRemoteOid)
        : { leftOnly: 0, rightOnly: 0 };
      return {
        acceptedMainOid,
        changedFiles,
        headOid,
        includesAcceptedMain,
        personalAheadBy: divergence.leftOnly,
        personalBehindBy: divergence.rightOnly,
        personalRemoteOid,
        workingTreeClean: entries.length === 0,
      };
    });
  }

  async validateChangedFiles(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
  ): Promise<void> {
    const countError = this.pathPolicy.validateChangedPathCount(snapshot.changedFiles.length);
    if (countError) throw countError;
    for (const changedFile of snapshot.changedFiles) {
      const pathResult = this.pathPolicy.validateRepositoryPath(changedFile.path);
      if (!pathResult.ok) throw pathResult.error;
      if (changedFile.previousPath) {
        const previousResult = this.pathPolicy.validateRepositoryPath(changedFile.previousPath);
        if (!previousResult.ok) throw previousResult.error;
      }
    }
    const candidates = snapshot.changedFiles
      .filter(file => file.status !== 'deleted')
      .map(file => ({
        kind: 'file' as const,
        path: file.path,
        size: file.size ?? Number.NaN,
      }));
    const result = this.pathPolicy.validateImportCandidates(candidates);
    if (!result.ok) {
      throw result.aggregateError ?? result.rejected[0]?.error
        ?? repositoryError('repository-invalid', 'publish-change-validation-failed');
    }
  }

  async stageAll(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertExpected(context, expected, signal);
    await this.git.stageAll(context.repositoryPath, signal);
  }

  async commitStaged(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.assertExpected(context, expected, signal);
    const headOid = expected.headOid;
    if (!headOid) throw repositoryError('repository-invalid', 'publish-head-missing');
    return this.git.createCommitFromIndex(context.repositoryPath, {
      expectedRefOid: headOid,
      message,
      parents: [headOid],
      ref: context.personalRef,
    });
  }

  async fetch(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertExpected(context, expected, signal);
    await this.assertRemote(context);
    await this.network.withNetwork(context, network => this.git.fetch(
      context.repositoryPath,
      ORIGIN,
      [
        COLLAB_MAIN_FETCH_REFSPEC,
        `+${context.personalRef}:${remotePersonalRef(context.personalRef)}`,
      ],
      network,
      signal,
    ));
  }

  async classifyAcceptedState(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<PublishAcceptedState> {
    const headOid = snapshot.headOid;
    const acceptedMainOid = snapshot.acceptedMainOid;
    if (!headOid || !acceptedMainOid) {
      throw repositoryError('repository-invalid', 'publish-required-ref-missing');
    }
    if (
      headOid === acceptedMainOid
      || await this.git.isAncestor(context.repositoryPath, acceptedMainOid, headOid)
    ) {
      return { kind: 'current' };
    }
    if (await this.git.isAncestor(context.repositoryPath, headOid, acceptedMainOid)) {
      return { kind: 'advanced' };
    }
    return this.options.acceptedState.classifyDivergence(
      context,
      snapshot,
      operationId,
      signal,
    );
  }

  isAncestor(
    context: PublishProjectContext,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    return this.git.isAncestor(context.repositoryPath, ancestorOid, descendantOid);
  }

  async pushPersonal(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertExpected(context, expected, signal);
    await this.assertRemote(context);
    await this.network.withNetwork(context, network => this.git.push(
      context.repositoryPath,
      ORIGIN,
      `${context.personalRef}:${context.personalRef}`,
      network,
      signal,
    ));
  }

  private async assertExpected(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    const actual = await this.inspect(context, signal);
    if (publishSnapshotFingerprint(actual) !== publishSnapshotFingerprint(expected)) {
      throw repositoryError('working-tree-busy', 'publish-repository-state-changed');
    }
  }

  private async assertRemote(context: PublishProjectContext): Promise<void> {
    await ensureTrustedCollabOrigin(
      this.git,
      context,
      'publish-origin-url-mismatch',
    );
  }

  private async changedFile(
    repositoryPath: string,
    entry: GitStatusEntry,
  ): Promise<PublishChangedFile> {
    const status = statusKind(entry);
    const base = {
      path: entry.path,
      ...(entry.originalPath === undefined ? {} : { previousPath: entry.originalPath }),
      status,
    };
    if (status === 'deleted') return base;
    const absolutePath = path.resolve(repositoryPath, entry.path);
    if (!isContainedPath(repositoryPath, absolutePath)) {
      throw repositoryError('path-outside-project', 'publish-change-outside-project');
    }
    const file = await lstat(absolutePath).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink()) {
      throw repositoryError('unsupported-file-type', 'publish-change-not-regular-file');
    }
    return {
      ...base,
      mode: file.mode,
      modifiedAtMs: file.mtimeMs,
      size: file.size,
    };
  }
}
