import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { collabMemberRef, isCollabGitOid } from '@claudian-collab/protocol';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { parseConflictTextMerge } from '@/app/collab/conflicts/ConflictTextMerge';
import { COLLAB_ORIGIN_MAIN_REF } from '@/app/collab/git/collabGitRefs';
import {
  type GitCommandRunner,
  parseGitNulFields,
} from '@/app/collab/git/GitCommandRunner';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { publicationCandidateRef } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import { type CollabConflictDescriptor, type CollabConflictEntry, type CollabConflictTextSegment } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const STAGE_PATTERN = /^(100644|100755) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([123])\t(.+)$/;
const SCRATCH_BRANCH = 'refs/heads/resolution';
const RESULT_REF = 'refs/heads/resolved';
const RESOLUTION_IDENTITY = Object.freeze({
  email: 'collab@claudian.local',
  name: 'Claudian Collab',
});
const CONFLICT_MARKER_SIZE = 64;
const MERGE_FILE_EXIT_CODES = Object.freeze(Array.from({ length: 128 }, (_, index) => index));

export interface ConflictIndexStage {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly path: string;
  readonly stage: 1 | 2 | 3;
}

export interface ConflictScratchInspection {
  readonly acceptedMainOid: string;
  readonly personalOid: string;
  readonly stages: readonly ConflictIndexStage[];
}

function scratchError(
  code:
    | 'cancelled'
    | 'content-conflict'
    | 'quota-exceeded'
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
  if (signal?.aborted) throw scratchError('cancelled', 'conflict-operation-cancelled');
}

export class ConflictScratchGitRepository {
  private readonly pathPolicy: CollabPathPolicy;

  constructor(
    private readonly git: GitRepositoryService,
    private readonly runner: GitCommandRunner,
    pathPolicy = new CollabPathPolicy(),
  ) {
    this.pathPolicy = pathPolicy;
  }

  async prepare(
    context: PublishProjectContext,
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<ConflictScratchInspection> {
    throwIfCancelled(signal);
    await this.assertSource(context, descriptor);
    const scratchParent = path.dirname(scratchPath);
    const scratchName = path.basename(scratchPath);
    const relativeSource = path.relative(scratchParent, context.repositoryPath);
    if (
      !relativeSource
      || relativeSource.includes('\u0000')
      || scratchName.length === 0
      || scratchName.startsWith('-')
    ) {
      throw scratchError('repository-invalid', 'conflict-scratch-source-invalid');
    }
    await this.runner.run({
      args: [
        'clone',
        '--quiet',
        '--no-checkout',
        '--no-hardlinks',
        relativeSource,
        scratchName,
      ],
      cwd: scratchParent,
      signal,
    });
    throwIfCancelled(signal);
    await this.runner.run({
      args: [
        'switch',
        '--quiet',
        '--create',
        SCRATCH_BRANCH.slice('refs/heads/'.length),
        descriptor.startingPersonalOid,
      ],
      cwd: scratchPath,
      signal,
    });
    const mergeBase = await this.git.findMergeBase(
      scratchPath,
      descriptor.startingPersonalOid,
      descriptor.startingMainOid,
    );
    if (mergeBase !== descriptor.mergeBaseOid) {
      throw scratchError('repository-invalid', 'conflict-merge-base-changed');
    }
    const merge = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: [
        'merge',
        '--no-commit',
        '--no-ff',
        '--no-edit',
        '--no-stat',
        '--no-verify',
        descriptor.startingMainOid,
      ],
      cwd: scratchPath,
      identity: RESOLUTION_IDENTITY,
      signal,
      suppressHooks: true,
    });
    if (merge.exitCode !== 1) {
      throw scratchError('repository-invalid', 'conflict-scratch-merge-not-conflicting');
    }
    return this.inspect(scratchPath, descriptor);
  }

  async inspect(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths: readonly string[] = [],
  ): Promise<ConflictScratchInspection> {
    const [personalOid, acceptedMainOid, stages] = await Promise.all([
      this.git.resolveRef(scratchPath, SCRATCH_BRANCH),
      this.readMergeHead(scratchPath),
      this.listStages(scratchPath),
    ]);
    if (
      personalOid !== descriptor.startingPersonalOid
      || acceptedMainOid !== descriptor.startingMainOid
      || (
        stages.length === 0
        && resolvedPaths.length !== descriptor.conflicts.length
      )
    ) {
      throw scratchError('repository-invalid', 'conflict-scratch-state-invalid');
    }
    const mergeBase = await this.git.findMergeBase(
      scratchPath,
      personalOid,
      acceptedMainOid,
    );
    if (mergeBase !== descriptor.mergeBaseOid) {
      throw scratchError('repository-invalid', 'conflict-scratch-merge-base-invalid');
    }
    const stagePaths = new Set(stages.map(stage => stage.path));
    const resolved = new Set(resolvedPaths);
    const representedPaths = new Set<string>();
    for (const conflict of descriptor.conflicts) {
      const paths = this.conflictPaths(conflict);
      paths.forEach(conflictPath => representedPaths.add(conflictPath));
      const hasStage = paths.some(conflictPath => stagePaths.has(conflictPath));
      if (resolved.has(conflict.path) ? hasStage : !hasStage) {
        throw scratchError('repository-invalid', 'conflict-scratch-path-mismatch');
      }
    }
    if (stages.some(stage => !representedPaths.has(stage.path))) {
      throw scratchError('repository-invalid', 'conflict-scratch-path-mismatch');
    }
    return { acceptedMainOid, personalOid, stages };
  }

  async isPrepared(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths: readonly string[] = [],
  ): Promise<boolean> {
    try {
      await this.inspect(scratchPath, descriptor, resolvedPaths);
      return true;
    } catch {
      return false;
    }
  }

  async readStage(
    scratchPath: string,
    inspection: ConflictScratchInspection,
    repositoryPath: string,
    stage: 1 | 2 | 3,
  ): Promise<Buffer | null> {
    const validation = this.pathPolicy.validateRepositoryPath(repositoryPath);
    if (!validation.ok) throw validation.error;
    const entry = inspection.stages.find(candidate => (
      candidate.path === repositoryPath && candidate.stage === stage
    ));
    if (!entry) return null;
    const result = await this.runner.run({
      args: ['cat-file', 'blob', entry.oid],
      cwd: scratchPath,
      maxStdoutBytes: CLAUDIAN_COLLAB_LIMITS.maxBlobBytes + 1,
    });
    if (result.stdout.byteLength > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
      throw scratchError('quota-exceeded', 'conflict-stage-blob-too-large');
    }
    return result.stdout;
  }

  readBlobAtPath(
    scratchPath: string,
    commitOid: string,
    repositoryPath: string,
  ): Promise<Buffer | null> {
    return this.git.readBlobAtPath(scratchPath, commitOid, repositoryPath);
  }

  async readTextMergeSegments(
    scratchPath: string,
    personal: Buffer | null,
    base: Buffer | null,
    accepted: Buffer | null,
    signal?: AbortSignal,
  ): Promise<readonly CollabConflictTextSegment[]> {
    throwIfCancelled(signal);
    const versions = [personal, base, accepted];
    if (versions.some(version => (version?.byteLength ?? 0) > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes)) {
      throw scratchError('quota-exceeded', 'conflict-stage-blob-too-large');
    }
    const token = randomUUID().replaceAll('-', '');
    const markers = {
      acceptedLabel: `CLAUDIAN_ACCEPTED_${token}`,
      baseLabel: `CLAUDIAN_BASE_${token}`,
      markerSize: CONFLICT_MARKER_SIZE,
      personalLabel: `CLAUDIAN_PERSONAL_${token}`,
    };
    const temporaryPath = await mkdtemp(path.join(path.dirname(scratchPath), '.merge-file-'));
    const personalPath = path.join(temporaryPath, 'personal');
    const basePath = path.join(temporaryPath, 'base');
    const acceptedPath = path.join(temporaryPath, 'accepted');
    try {
      await Promise.all([
        writeFile(personalPath, personal ?? Buffer.alloc(0)),
        writeFile(basePath, base ?? Buffer.alloc(0)),
        writeFile(acceptedPath, accepted ?? Buffer.alloc(0)),
      ]);
      throwIfCancelled(signal);
      const result = await this.runner.run({
        acceptedExitCodes: MERGE_FILE_EXIT_CODES,
        args: [
          'merge-file',
          '--stdout',
          '--diff3',
          `--marker-size=${CONFLICT_MARKER_SIZE}`,
          '-L',
          markers.personalLabel,
          '-L',
          markers.baseLabel,
          '-L',
          markers.acceptedLabel,
          personalPath,
          basePath,
          acceptedPath,
        ],
        cwd: temporaryPath,
        maxStdoutBytes: (CLAUDIAN_COLLAB_LIMITS.maxBlobBytes * 3) + (1024 * 1024),
        signal,
      });
      throwIfCancelled(signal);
      let mergedText: string;
      try {
        mergedText = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      } catch {
        throw scratchError('content-conflict', 'conflict-stage-not-text');
      }
      try {
        return parseConflictTextMerge(mergedText, markers);
      } catch {
        throw scratchError('repository-invalid', 'conflict-merge-markers-invalid');
      }
    } finally {
      await rm(temporaryPath, { force: true, recursive: true });
    }
  }

  async resolveWithPersonalVersions(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
  ): Promise<ConflictScratchInspection> {
    const resolvedPaths: string[] = [];
    for (const conflict of descriptor.conflicts) {
      if (conflict.kind === 'directory-file' || conflict.kind === 'portability') {
        throw scratchError('content-conflict', 'conflict-working-tree-resolution-blocked');
      }
      const inspection = await this.inspect(scratchPath, descriptor, resolvedPaths);
      const paths = this.conflictPaths(conflict);
      const selectedPath = conflict.personalPath ?? conflict.path;
      let contents: Buffer | null;
      let mode: ConflictIndexStage['mode'] = '100644';
      const entry = inspection.stages.find(stage => (
        stage.stage === 2
        && (stage.path === selectedPath || stage.path === conflict.path)
      ));
      if (!entry) {
        if (conflict.kind !== 'delete-modify' && conflict.kind !== 'rename-delete') {
          throw scratchError('repository-invalid', 'conflict-selected-stage-missing');
        }
        contents = null;
      } else {
        mode = entry.mode;
        contents = await this.readStage(
          scratchPath,
          inspection,
          entry.path,
          2,
        );
      }

      for (const conflictPath of paths) {
        await this.removeScratchFile(scratchPath, conflictPath);
      }
      if (contents !== null) {
        await this.writeScratchFile(scratchPath, selectedPath, contents, mode);
      }
      const stageTargets = [...new Set([
        ...inspection.stages
          .filter(stage => paths.includes(stage.path))
          .map(stage => stage.path),
        ...(contents === null ? [] : [selectedPath]),
      ])].sort();
      if (stageTargets.length === 0) {
        throw scratchError('repository-invalid', 'conflict-stage-target-missing');
      }
      await this.runner.run({
        args: ['add', '-A', '--', ...stageTargets],
        cwd: scratchPath,
      });
      resolvedPaths.push(conflict.path);
    }
    return this.inspect(scratchPath, descriptor, resolvedPaths);
  }

  async createResolutionCommit(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths: readonly string[],
  ): Promise<string> {
    if (
      new Set(resolvedPaths).size !== descriptor.conflicts.length
      || descriptor.conflicts.some(conflict => !resolvedPaths.includes(conflict.path))
    ) {
      throw scratchError('content-conflict', 'conflict-resolution-incomplete');
    }
    const inspection = await this.inspect(scratchPath, descriptor, resolvedPaths);
    if (inspection.stages.length !== 0) {
      throw scratchError('content-conflict', 'conflict-index-unresolved');
    }
    const treeResult = await this.runner.run({
      args: ['write-tree'],
      cwd: scratchPath,
      maxStdoutBytes: 128,
    });
    const treeOid = treeResult.stdout.toString('utf8').trim();
    if (!isCollabGitOid(treeOid)) {
      throw scratchError('repository-invalid', 'conflict-result-tree-invalid');
    }
    const existing = await this.git.resolveRef(scratchPath, RESULT_REF);
    if (existing !== null) {
      await this.assertResultParents(scratchPath, descriptor, existing);
      const existingTree = await this.readCommitTree(scratchPath, existing);
      if (existingTree !== treeOid) {
        throw scratchError('repository-invalid', 'conflict-result-tree-changed');
      }
      return existing;
    }
    const resultOid = await this.git.commitTree(scratchPath, {
      identity: RESOLUTION_IDENTITY,
      message: 'Resolve accepted changes',
      parents: [descriptor.startingPersonalOid, descriptor.startingMainOid],
      treeOid,
    });
    await this.git.createRef(scratchPath, RESULT_REF, resultOid);
    return resultOid;
  }

  async retainResultForPublication(
    context: PublishProjectContext,
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resultOid: string,
    signal?: AbortSignal,
    beforeMutation?: () => Promise<void>,
  ): Promise<void> {
    throwIfCancelled(signal);
    if (!isCollabGitOid(resultOid)) {
      throw scratchError('repository-invalid', 'conflict-result-oid-invalid');
    }
    const scratchResult = await this.git.resolveRef(scratchPath, RESULT_REF);
    if (scratchResult !== resultOid) {
      throw scratchError('repository-invalid', 'conflict-result-ref-invalid');
    }
    await this.assertResultParents(scratchPath, descriptor, resultOid);
    const transferRef = publicationCandidateRef(descriptor.operationId);
    const current = await this.inspectRealProject(context, descriptor, resultOid);
    if (current === 'applied') {
      throw scratchError('working-tree-busy', 'conflict-result-already-visible');
    }

    const existing = await this.git.resolveRef(context.repositoryPath, transferRef);
    if (existing !== null) {
      if (existing !== resultOid) {
        throw scratchError('repository-invalid', 'conflict-transfer-ref-changed');
      }
      await this.assertResultParents(context.repositoryPath, descriptor, resultOid);
      return;
    }

    const relativeScratch = path.relative(context.repositoryPath, scratchPath);
    if (!relativeScratch || relativeScratch.includes('\u0000')) {
      throw scratchError('repository-invalid', 'conflict-result-source-invalid');
    }
    await this.runner.run({
      args: [
        'fetch',
        '--quiet',
        '--no-tags',
        relativeScratch,
        `+${RESULT_REF}:${transferRef}`,
      ],
      cwd: context.repositoryPath,
      signal,
      suppressHooks: true,
    });
    const transferred = await this.git.resolveRef(context.repositoryPath, transferRef);
    if (transferred !== resultOid) {
      throw scratchError('repository-invalid', 'conflict-result-transfer-invalid');
    }
    await this.assertResultParents(context.repositoryPath, descriptor, resultOid);
    throwIfCancelled(signal);
    await beforeMutation?.();
    throwIfCancelled(signal);
    if (await this.inspectRealProject(context, descriptor, resultOid) !== 'starting') {
      throw scratchError('working-tree-busy', 'conflict-project-state-changed');
    }
  }

  private async assertSource(
    context: PublishProjectContext,
    descriptor: CollabConflictDescriptor,
  ): Promise<void> {
    if (
      descriptor.projectId !== context.projectId
      || context.personalRef !== collabMemberRef(context.memberId)
    ) {
      throw scratchError('repository-invalid', 'conflict-source-identity-mismatch');
    }
    const [personalOid, symbolicHead, status, mergeBase] = await Promise.all([
      this.git.resolveRef(context.repositoryPath, context.personalRef),
      this.runner.run({
        acceptedExitCodes: [0, 1],
        args: ['symbolic-ref', '--quiet', 'HEAD'],
        cwd: context.repositoryPath,
        maxStdoutBytes: 512,
      }),
      this.git.getWorkingTreeStatus(context.repositoryPath),
      this.git.findMergeBase(
        context.repositoryPath,
        descriptor.startingPersonalOid,
        descriptor.startingMainOid,
      ),
    ]);
    const symbolicRef = symbolicHead.exitCode === 0
      ? symbolicHead.stdout.toString('utf8').trim()
      : null;
    if (
      personalOid !== descriptor.startingPersonalOid
      || symbolicRef !== context.personalRef
      || status.length !== 0
      || mergeBase !== descriptor.mergeBaseOid
    ) {
      throw scratchError('working-tree-busy', 'conflict-source-state-changed');
    }
  }

  private async readMergeHead(scratchPath: string): Promise<string> {
    const result = await this.runner.run({
      args: ['rev-parse', '--verify', '--end-of-options', 'MERGE_HEAD^{commit}'],
      cwd: scratchPath,
      maxStdoutBytes: 128,
    });
    const oid = result.stdout.toString('utf8').trim();
    if (!isCollabGitOid(oid)) {
      throw scratchError('repository-invalid', 'conflict-merge-head-invalid');
    }
    return oid;
  }

  private async listStages(scratchPath: string): Promise<readonly ConflictIndexStage[]> {
    const result = await this.runner.run({
      args: ['ls-files', '--unmerged', '-z'],
      cwd: scratchPath,
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    const records = parseGitNulFields(result.stdout);
    if (records.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths * 3) {
      throw scratchError('quota-exceeded', 'conflict-index-stage-limit');
    }
    const stages = records.map(record => {
      const match = STAGE_PATTERN.exec(record);
      if (!match) {
        throw scratchError('repository-invalid', 'conflict-index-stage-invalid');
      }
      const repositoryPath = match[4];
      const validation = this.pathPolicy.validateRepositoryPath(repositoryPath);
      if (!validation.ok) throw validation.error;
      return {
        mode: match[1] as ConflictIndexStage['mode'],
        oid: match[2],
        path: repositoryPath,
        stage: Number(match[3]) as ConflictIndexStage['stage'],
      };
    });
    stages.sort((left, right) => (
      left.path < right.path
        ? -1
        : left.path > right.path
          ? 1
          : left.stage - right.stage
    ));
    return stages;
  }

  private async inspectRealProject(
    context: PublishProjectContext,
    descriptor: CollabConflictDescriptor,
    resultOid: string,
  ): Promise<'applied' | 'starting'> {
    if (
      descriptor.projectId !== context.projectId
      || context.personalRef !== collabMemberRef(context.memberId)
    ) {
      throw scratchError('repository-invalid', 'conflict-project-identity-mismatch');
    }
    const [headOid, mainOid, symbolicHead, status] = await Promise.all([
      this.git.resolveRef(context.repositoryPath, context.personalRef),
      this.git.resolveRef(context.repositoryPath, COLLAB_ORIGIN_MAIN_REF),
      this.runner.run({
        acceptedExitCodes: [0, 1],
        args: ['symbolic-ref', '--quiet', 'HEAD'],
        cwd: context.repositoryPath,
        maxStdoutBytes: 512,
      }),
      this.git.getWorkingTreeStatus(context.repositoryPath),
    ]);
    const symbolicRef = symbolicHead.exitCode === 0
      ? symbolicHead.stdout.toString('utf8').trim()
      : null;
    if (
      symbolicRef !== context.personalRef
      || mainOid !== descriptor.startingMainOid
      || status.length !== 0
    ) {
      throw scratchError('working-tree-busy', 'conflict-project-state-changed');
    }
    if (headOid === resultOid) return 'applied';
    if (headOid !== descriptor.startingPersonalOid) {
      throw scratchError('working-tree-busy', 'conflict-project-state-changed');
    }
    return 'starting';
  }

  private async assertResultParents(
    repositoryPath: string,
    descriptor: CollabConflictDescriptor,
    resultOid: string,
  ): Promise<void> {
    const result = await this.runner.run({
      args: ['rev-list', '--parents', '--max-count=1', resultOid],
      cwd: repositoryPath,
      maxStdoutBytes: 512,
    });
    const fields = result.stdout.toString('utf8').trim().split(/\s+/);
    if (
      fields.length !== 3
      || fields[0] !== resultOid
      || fields[1] !== descriptor.startingPersonalOid
      || fields[2] !== descriptor.startingMainOid
    ) {
      throw scratchError('repository-invalid', 'conflict-result-parents-invalid');
    }
  }

  private async readCommitTree(repositoryPath: string, commitOid: string): Promise<string> {
    const result = await this.runner.run({
      args: ['rev-parse', '--verify', '--end-of-options', `${commitOid}^{tree}`],
      cwd: repositoryPath,
      maxStdoutBytes: 128,
    });
    const treeOid = result.stdout.toString('utf8').trim();
    if (!isCollabGitOid(treeOid)) {
      throw scratchError('repository-invalid', 'conflict-result-tree-invalid');
    }
    return treeOid;
  }

  private conflictPaths(conflict: CollabConflictEntry): readonly string[] {
    return [...new Set([
      conflict.path,
      ...(conflict.personalPath ? [conflict.personalPath] : []),
      ...(conflict.acceptedPath ? [conflict.acceptedPath] : []),
    ])].sort();
  }

  private async removeScratchFile(
    scratchPath: string,
    repositoryPath: string,
  ): Promise<void> {
    const validation = this.pathPolicy.validateRepositoryPath(repositoryPath);
    if (!validation.ok) throw validation.error;
    const absolutePath = path.join(scratchPath, ...repositoryPath.split('/'));
    const existing = await lstat(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw scratchError('repository-invalid', 'conflict-result-path-inspection-failed');
    });
    if (!existing) return;
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw scratchError('repository-invalid', 'conflict-result-path-not-file');
    }
    await rm(absolutePath);
  }

  private async writeScratchFile(
    scratchPath: string,
    repositoryPath: string,
    contents: Uint8Array,
    mode: ConflictIndexStage['mode'],
  ): Promise<void> {
    const validation = this.pathPolicy.validateRepositoryPath(repositoryPath);
    if (!validation.ok) throw validation.error;
    const absolutePath = path.join(scratchPath, ...repositoryPath.split('/'));
    await mkdir(path.dirname(absolutePath), { mode: 0o700, recursive: true });
    await writeFile(absolutePath, contents, { mode: mode === '100755' ? 0o700 : 0o600 });
    if (process.platform !== 'win32') {
      await chmod(absolutePath, mode === '100755' ? 0o700 : 0o600);
    }
  }
}
