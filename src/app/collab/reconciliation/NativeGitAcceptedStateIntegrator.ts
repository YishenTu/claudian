import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  COLLAB_MEMBER_REF_PREFIX,
  collabMemberRef,
  type CollabOperationId,
  isCollabGitOid,
} from '@claudian/collab-protocol';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import {
  COLLAB_ORIGIN_MAIN_REF,
  collabOriginTrackingRef,
} from '@/app/collab/git/collabGitRefs';
import {
  type GitCommandRunner,
  parseGitNulFields,
} from '@/app/collab/git/GitCommandRunner';
import type {
  GitRepositoryReadSession,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import type {
  PublishAcceptedStatePort,
} from '@/app/collab/publish/NativeGitPublishRepository';
import {
  type PublishAcceptedState,
  type PublishProjectContext,
  type PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import {
  type ReconciliationFastForwardResult,
  type ReconciliationPlan,
} from '@/app/collab/reconciliation/ReconciliationCoordinator';
import type { ReconciliationRepositoryLockPort } from '@/app/collab/reconciliation/ReconciliationMutationSafety';
import { type CollabConflictEntry } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const TEXT_EXTENSIONS = new Set([
  '.canvas', '.css', '.csv', '.html', '.js', '.json', '.jsx', '.md',
  '.markdown', '.mermaid', '.svg', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
]);

interface MergeAnalysis {
  readonly conflictPaths: readonly string[];
  readonly kind: 'clean' | 'conflicting';
}

function integrationError(
  code:
    | 'cancelled'
    | 'content-conflict'
    | 'repository-invalid'
    | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'content-conflict'
      ? ['review-conflicts']
      : code === 'repository-invalid'
        ? ['open-diagnostics']
        : ['retry'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw integrationError('cancelled', 'reconciliation-cancelled');
  }
}

function requireOid(oid: string | null, reason: string): string {
  if (!isCollabGitOid(oid)) {
    throw integrationError('repository-invalid', reason);
  }
  return oid;
}

function remotePersonalRef(personalRef: string): string {
  if (!personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)) {
    throw integrationError('repository-invalid', 'reconciliation-personal-ref-invalid');
  }
  return collabOriginTrackingRef(personalRef);
}

function isTextPath(repositoryPath: string): boolean {
  return TEXT_EXTENSIONS.has(
    path.posix.extname(repositoryPath).toLocaleLowerCase('en-US'),
  );
}

function isUtf8(contents: Buffer | null): boolean {
  if (contents === null) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return true;
  } catch {
    return false;
  }
}

async function mutationSentinelExists(sentinel: string): Promise<boolean> {
  try {
    await lstat(sentinel);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export class NativeGitAcceptedStateIntegrator implements
  PublishAcceptedStatePort,
  ReconciliationRepositoryLockPort {
  private readonly pathPolicy: CollabPathPolicy;

  constructor(
    private readonly git: GitRepositoryService,
    private readonly runner: GitCommandRunner,
    pathPolicy = new CollabPathPolicy(),
  ) {
    this.pathPolicy = pathPolicy;
  }

  async plan(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<ReconciliationPlan> {
    return this.git.withReadSession(context.repositoryPath, 'working', session => (
      this.planInSession(session, context, snapshot, operationId, signal)
    ));
  }

  private async planInSession(
    session: GitRepositoryReadSession,
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<ReconciliationPlan> {
    throwIfCancelled(signal);
    const { acceptedMainOid, personalOid } = await this.assertExpectedState(
      session,
      context,
      snapshot,
    );
    if (
      personalOid === acceptedMainOid
      || await session.isAncestor(acceptedMainOid, personalOid)
    ) {
      return { kind: 'current' };
    }
    if (await session.isAncestor(personalOid, acceptedMainOid)) {
      return { kind: 'fast-forward' };
    }

    throwIfCancelled(signal);
    const analysis = await this.analyzeMerge(
      context.repositoryPath,
      personalOid,
      acceptedMainOid,
      signal,
    );
    if (analysis.kind === 'clean') return { kind: 'diverged' };
    const mergeBaseOid = await session.findMergeBase(personalOid, acceptedMainOid);
    const conflicts = await Promise.all(analysis.conflictPaths.map(conflictPath => (
      this.classifyConflict(
        session,
        conflictPath,
        mergeBaseOid,
        personalOid,
        acceptedMainOid,
      )
    )));
    return {
      conflict: {
        conflicts,
        mergeBaseOid,
        operationId,
        projectId: context.projectId,
        startingMainOid: acceptedMainOid,
        startingPersonalOid: personalOid,
      },
      kind: 'conflicting',
    };
  }

  async classifyDivergence(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<PublishAcceptedState> {
    const plan = await this.plan(context, snapshot, operationId, signal);
    if (plan.kind === 'current') return { kind: 'current' };
    if (plan.kind === 'conflicting') {
      return { conflict: plan.conflict, kind: 'conflicting' };
    }
    return { kind: 'advanced' };
  }

  async fastForward(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<ReconciliationFastForwardResult> {
    throwIfCancelled(signal);
    const plan = await this.plan(context, expected, 'reconciliation-preflight', signal);
    if (plan.kind === 'current') {
      throw integrationError('working-tree-busy', 'reconciliation-already-current');
    }
    if (plan.kind === 'conflicting') {
      throw integrationError('content-conflict', 'reconciliation-content-conflict');
    }
    if (plan.kind === 'diverged') {
      throw integrationError('working-tree-busy', 'reconciliation-contribution-present');
    }
    if (await this.hasMutationLock(context)) {
      throw integrationError('working-tree-busy', 'reconciliation-repository-lock');
    }
    const { acceptedMainOid } = await this.git.withReadSession(
      context.repositoryPath,
      'working',
      session => this.assertExpectedState(session, context, expected),
    );
    throwIfCancelled(signal);

    await this.runner.run({
      args: ['merge', '--ff-only', '--no-edit', '--no-stat', '--no-verify', acceptedMainOid],
      cwd: context.repositoryPath,
      suppressHooks: true,
    });

    const snapshot = await this.inspectAfterIntegration(context, expected);
    return {
      kind: 'fast-forwarded',
      snapshot,
    };
  }

  async hasMutationLock(context: PublishProjectContext): Promise<boolean> {
    this.assertCurrentMemberRef(context);
    const gitDirectory = path.join(context.repositoryPath, '.git');
    const personalLock = `${path.join(
      gitDirectory,
      ...context.personalRef.split('/'),
    )}.lock`;
    const sentinels = [
      path.join(gitDirectory, 'index.lock'),
      path.join(gitDirectory, 'HEAD.lock'),
      path.join(gitDirectory, 'MERGE_HEAD'),
      path.join(gitDirectory, 'CHERRY_PICK_HEAD'),
      path.join(gitDirectory, 'REBASE_HEAD'),
      path.join(gitDirectory, 'rebase-apply'),
      path.join(gitDirectory, 'rebase-merge'),
      personalLock,
    ];
    const states = await Promise.all(sentinels.map(mutationSentinelExists));
    return states.some(Boolean);
  }

  private async assertExpectedState(
    session: GitRepositoryReadSession,
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
  ): Promise<{ acceptedMainOid: string; personalOid: string }> {
    this.assertCurrentMemberRef(context);
    if (!expected.workingTreeClean || expected.changedFiles.length !== 0) {
      throw integrationError('working-tree-busy', 'reconciliation-working-tree-dirty');
    }
    const remotePersonal = remotePersonalRef(context.personalRef);
    const [symbolicHead, refs, status] = await Promise.all([
      this.readSymbolicHead(context),
      session.resolveRefs([context.personalRef, remotePersonal, COLLAB_ORIGIN_MAIN_REF]),
      session.getWorkingTreeStatus(),
    ]);
    const personalOid = refs.get(context.personalRef) ?? null;
    const remotePersonalOid = refs.get(remotePersonal) ?? null;
    const acceptedMainOid = refs.get(COLLAB_ORIGIN_MAIN_REF) ?? null;
    if (
      symbolicHead !== context.personalRef
      || status.length !== 0
      || personalOid !== expected.headOid
      || remotePersonalOid !== expected.personalRemoteOid
      || acceptedMainOid !== expected.acceptedMainOid
    ) {
      throw integrationError(
        'working-tree-busy',
        'reconciliation-repository-state-changed',
      );
    }
    const requiredPersonalOid = requireOid(
      personalOid,
      'reconciliation-personal-ref-missing',
    );
    const requiredMainOid = requireOid(
      acceptedMainOid,
      'reconciliation-main-ref-missing',
    );
    const requiredRemotePersonalOid = requireOid(
      remotePersonalOid,
      'reconciliation-remote-personal-ref-missing',
    );
    const divergence = await session.countDivergence(requiredPersonalOid, requiredRemotePersonalOid);
    if (
      divergence.leftOnly !== expected.personalAheadBy
      || divergence.rightOnly !== expected.personalBehindBy
    ) {
      throw integrationError(
        'working-tree-busy',
        'reconciliation-repository-state-changed',
      );
    }
    return { acceptedMainOid: requiredMainOid, personalOid: requiredPersonalOid };
  }

  private assertCurrentMemberRef(context: PublishProjectContext): void {
    if (context.personalRef !== collabMemberRef(context.memberId)) {
      throw integrationError(
        'repository-invalid',
        'reconciliation-personal-ref-mismatch',
      );
    }
  }

  private async readSymbolicHead(context: PublishProjectContext): Promise<string | null> {
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: ['symbolic-ref', '--quiet', 'HEAD'],
      cwd: context.repositoryPath,
      maxStdoutBytes: 512,
    });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
  }

  private async analyzeMerge(
    repositoryPath: string,
    personalOid: string,
    acceptedMainOid: string,
    signal?: AbortSignal,
  ): Promise<MergeAnalysis> {
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        '-z',
        personalOid,
        acceptedMainOid,
      ],
      cwd: repositoryPath,
      maxStdoutBytes: 4 * 1024 * 1024,
      signal,
    });
    const fields = parseGitNulFields(result.stdout);
    if (!isCollabGitOid(fields[0])) {
      throw integrationError('repository-invalid', 'reconciliation-merge-output-invalid');
    }
    const conflictPaths = [...new Set(fields.slice(1).filter(Boolean))].sort();
    if (result.exitCode === 0) {
      if (conflictPaths.length !== 0) {
        throw integrationError('repository-invalid', 'reconciliation-merge-output-invalid');
      }
      return { conflictPaths, kind: 'clean' };
    }
    if (conflictPaths.length === 0) {
      throw integrationError('repository-invalid', 'reconciliation-conflict-paths-missing');
    }
    if (conflictPaths.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths) {
      throw new CollabError({
        code: 'quota-exceeded',
        recoveryActions: ['open-diagnostics'],
        safeContext: {
          limit: CLAUDIAN_COLLAB_LIMITS.maxChangedPaths,
          quota: 'maxChangedPaths',
        },
      });
    }
    for (const conflictPath of conflictPaths) {
      const validation = this.pathPolicy.validateRepositoryPath(conflictPath);
      if (!validation.ok) throw validation.error;
    }
    return { conflictPaths, kind: 'conflicting' };
  }

  private async classifyConflict(
    session: GitRepositoryReadSession,
    conflictPath: string,
    mergeBaseOid: string,
    personalOid: string,
    acceptedMainOid: string,
  ): Promise<CollabConflictEntry> {
    let blobs: readonly (Buffer | null)[];
    try {
      blobs = await session.readBlobsAtPaths([
        { repositoryRelativePath: conflictPath, treeish: mergeBaseOid },
        { repositoryRelativePath: conflictPath, treeish: personalOid },
        { repositoryRelativePath: conflictPath, treeish: acceptedMainOid },
      ]);
    } catch (error) {
      if (
        error instanceof CollabError
        && error.safeContext.reason === 'git-tree-entry-invalid'
      ) {
        return { kind: 'directory-file', path: conflictPath };
      }
      throw error;
    }
    const [base, personal, accepted] = blobs;
    if (personal === null || accepted === null) {
      return { kind: 'delete-modify', path: conflictPath };
    }
    if (
      !isTextPath(conflictPath)
      || !isUtf8(base)
      || !isUtf8(personal)
      || !isUtf8(accepted)
    ) {
      return { kind: 'binary', path: conflictPath };
    }
    return { kind: 'text', path: conflictPath };
  }

  private async inspectAfterIntegration(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
  ): Promise<PublishRepositorySnapshot> {
    return this.git.withReadSession(context.repositoryPath, 'working', async session => {
      const remotePersonal = remotePersonalRef(context.personalRef);
      const [symbolicHead, refs, status] = await Promise.all([
        this.readSymbolicHead(context),
        session.resolveRefs([context.personalRef, remotePersonal, COLLAB_ORIGIN_MAIN_REF]),
        session.getWorkingTreeStatus(),
      ]);
      const headOid = refs.get(context.personalRef) ?? null;
      const personalRemoteOid = refs.get(remotePersonal) ?? null;
      const acceptedMainOid = refs.get(COLLAB_ORIGIN_MAIN_REF) ?? null;
      if (
        symbolicHead !== context.personalRef
        || !headOid
        || !acceptedMainOid
        || acceptedMainOid !== expected.acceptedMainOid
        || personalRemoteOid !== expected.personalRemoteOid
        || status.length !== 0
        || !await session.isAncestor(acceptedMainOid, headOid)
      ) {
        throw integrationError('repository-invalid', 'reconciliation-post-merge-invalid');
      }
      const divergence = personalRemoteOid
        ? await session.countDivergence(headOid, personalRemoteOid)
        : { leftOnly: 0, rightOnly: 0 };
      return {
        acceptedMainOid,
        changedFiles: [],
        headOid,
        includesAcceptedMain: true,
        personalAheadBy: divergence.leftOnly,
        personalBehindBy: divergence.rightOnly,
        personalRemoteOid,
        workingTreeClean: true,
      };
    });
  }
}
