import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { isCollabGitOid } from '@claudian-collab/protocol';

import { type GitCommandRunner, parseGitNulFields } from '@/app/collab/git/GitCommandRunner';
import { canonicalConflictStagePaths, parseGitConflictStages } from '@/app/collab/git/gitConflictPaths';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import type { CollabPersonalReviewBaselineRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { personalChangesReviewBaseOid } from '@/app/collab/publish/LocalContributionClassifier';
import type { PublishProjectContext, PublishRepositorySnapshot } from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const BASELINE_REF_PREFIX = 'refs/claudian/review-baselines/';
const BASELINE_RESULT_REF = 'refs/heads/review-baseline';
const IDENTITY = { email: 'collab@claudian.local', name: 'Claudian Collab' };

export interface PersonalReviewBaselineControlPort {
  readSnapshot(projectId: string, options: { readonly signal?: AbortSignal }): Promise<{
    readonly currentMember: { readonly id: string; readonly personalRef: string };
    readonly openRequests: readonly { readonly memberId: string; readonly latestHeadOid: string }[];
    readonly project: { readonly id: string; readonly mainOid: string };
  }>;
}

function baselineError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function requireOid(value: string | null): string {
  if (!isCollabGitOid(value)) throw baselineError('review-baseline-oid-invalid');
  return value;
}

function baselineRef(sourceHeadOid: string, acceptedMainOid: string): string {
  return `${BASELINE_REF_PREFIX}${requireOid(sourceHeadOid)}-${requireOid(acceptedMainOid)}`;
}

function inGroup(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

export class PersonalChangesReviewBaseline {
  constructor(
    private readonly git: GitRepositoryService,
    private readonly runner: GitCommandRunner,
    private readonly control: PersonalReviewBaselineControlPort,
  ) {}

  async prepare(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<CollabPersonalReviewBaselineRecord> {
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const coordination = await this.control.readSnapshot(context.projectId, { signal });
    if (
      coordination.project.id !== context.projectId
      || coordination.project.mainOid !== snapshot.acceptedMainOid
      || coordination.currentMember.id !== context.memberId
      || coordination.currentMember.personalRef !== context.personalRef
    ) throw baselineError('review-baseline-authority-changed');
    const sourceHeadOid = requireOid(personalChangesReviewBaseOid({
      coordinationAuthoritative: true,
      headOid: snapshot.headOid,
      openRequestHeadOid: coordination.openRequests.find(request => request.memberId === context.memberId)?.latestHeadOid,
      personalRemoteOid: snapshot.personalRemoteOid,
    }));
    const acceptedMainOid = requireOid(snapshot.acceptedMainOid);
    const baselineOid = await this.#project(context, sourceHeadOid, acceptedMainOid, signal);
    return { acceptedMainOid, baselineOid, sourceHeadOid };
  }

  async releaseObsolete(
    context: PublishProjectContext,
    retained: CollabPersonalReviewBaselineRecord | undefined,
  ): Promise<void> {
    const listed = await this.runner.run({
      args: ['for-each-ref', '--format=%(refname) %(objectname)', BASELINE_REF_PREFIX],
      cwd: context.repositoryPath,
      maxStdoutBytes: 1024 * 1024,
    });
    const retainedRef = retained ? baselineRef(retained.sourceHeadOid, retained.acceptedMainOid) : null;
    for (const line of listed.stdout.toString('utf8').trim().split('\n').filter(Boolean)) {
      const [ref, oid, extra] = line.split(' ');
      if (extra !== undefined || !ref.startsWith(BASELINE_REF_PREFIX) || !isCollabGitOid(oid)) {
        throw baselineError('review-baseline-ref-invalid');
      }
      if (ref === retainedRef) {
        if (oid !== retained?.baselineOid) throw baselineError('review-baseline-ref-changed');
        continue;
      }
      const removed = await this.git.deleteRefIfMatches(context.repositoryPath, ref, oid);
      if (!removed.updated && removed.currentOid !== null) throw baselineError('review-baseline-cleanup-changed');
    }
  }

  async #project(
    context: PublishProjectContext,
    sourceHeadOid: string,
    acceptedMainOid: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const repositoryPath = context.repositoryPath;
    if (await this.git.isAncestor(repositoryPath, sourceHeadOid, acceptedMainOid)) return acceptedMainOid;
    if (await this.git.isAncestor(repositoryPath, acceptedMainOid, sourceHeadOid)) return sourceHeadOid;
    const retainedRef = baselineRef(sourceHeadOid, acceptedMainOid);
    const existing = await this.git.resolveRef(repositoryPath, retainedRef);
    if (existing) {
      const parents = await this.runner.run({
        args: ['show', '-s', '--format=%P', existing], cwd: repositoryPath, maxStdoutBytes: 256, signal,
      });
      if (parents.stdout.toString('utf8').trim() !== `${sourceHeadOid} ${acceptedMainOid}`) {
        throw baselineError('review-baseline-parents-changed');
      }
      return existing;
    }
    const temporaryRoot = await mkdtemp(path.join(repositoryPath, '.git', 'review-baseline-'));
    const scratchPath = path.join(temporaryRoot, 'repository');
    try {
      await this.runner.run({
        args: ['clone', '--quiet', '--no-checkout', '--no-hardlinks', path.relative(temporaryRoot, repositoryPath), 'repository'],
        cwd: temporaryRoot,
        signal,
        suppressHooks: true,
      });
      await this.runner.run({
        args: ['switch', '--quiet', '--detach', sourceHeadOid], cwd: scratchPath, signal, suppressHooks: true,
      });
      const merge = await this.runner.run({
        acceptedExitCodes: [0, 1],
        args: ['merge', '--no-commit', '--no-ff', '--no-edit', '--no-stat', '--no-verify', '-Xours', acceptedMainOid],
        cwd: scratchPath,
        identity: IDENTITY,
        signal,
        suppressHooks: true,
      });
      if (merge.exitCode === 1) await this.#retainPublishedShape(scratchPath, sourceHeadOid, acceptedMainOid, signal);
      const tree = await this.runner.run({ args: ['write-tree'], cwd: scratchPath, maxStdoutBytes: 128, signal });
      const baselineOid = await this.git.commitTree(scratchPath, {
        identity: IDENTITY,
        message: 'Prepare personal review baseline',
        parents: [sourceHeadOid, acceptedMainOid],
        treeOid: requireOid(tree.stdout.toString('utf8').trim()),
      });
      await this.git.createRef(scratchPath, BASELINE_RESULT_REF, baselineOid);
      await this.runner.run({
        args: ['fetch', '--quiet', '--no-tags', path.relative(repositoryPath, scratchPath), `${BASELINE_RESULT_REF}:${retainedRef}`],
        cwd: repositoryPath,
        signal,
        suppressHooks: true,
      });
      if (await this.git.resolveRef(repositoryPath, retainedRef) !== baselineOid) {
        throw baselineError('review-baseline-retention-failed');
      }
      return baselineOid;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async #retainPublishedShape(
    scratchPath: string,
    sourceHeadOid: string,
    acceptedMainOid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const [unmerged, index, personalTree, acceptedTree] = await Promise.all([
      this.runner.run({ args: ['ls-files', '--unmerged', '-z'], cwd: scratchPath, maxStdoutBytes: 16 * 1024 * 1024, signal }),
      this.runner.run({ args: ['ls-files', '-z'], cwd: scratchPath, maxStdoutBytes: 16 * 1024 * 1024, signal }),
      this.git.listTreeRecursive(scratchPath, sourceHeadOid),
      this.git.listTreeRecursive(scratchPath, acceptedMainOid),
    ]);
    const stages = parseGitConflictStages(parseGitNulFields(unmerged.stdout));
    if (stages.length === 0) throw baselineError('review-baseline-conflict-stages-missing');
    const canonical = canonicalConflictStagePaths(stages, personalTree, acceptedTree);
    const groups = [...new Set(stages.map(stage => canonical.get(stage.path) ?? stage.path))];
    const removals = [...new Set([
      ...stages.map(stage => stage.path),
      ...parseGitNulFields(index.stdout).filter(file => groups.some(group => inGroup(file, group))),
    ])];
    const restored = personalTree.filter(entry => groups.some(group => inGroup(entry.path, group)));
    if (restored.some(entry => entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755'))) {
      throw baselineError('review-baseline-entry-invalid');
    }
    await this.runner.run({
      args: ['update-index', '-z', '--index-info'],
      cwd: scratchPath,
      signal,
      stdin: removals.map(file => `0 ${'0'.repeat(sourceHeadOid.length)}\t${file}\0`).join('')
        + restored.map(entry => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join(''),
    });
  }
}
