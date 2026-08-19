import { TextDecoder } from 'node:util';

import { type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import type {
  ConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';
import {
  COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  decodeConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';
import type {
  ConflictScratchInspection,
} from '@/app/collab/conflicts/ConflictScratchGitRepository';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabConflictDecision, type CollabConflictDescriptor, type CollabConflictEntry, type CollabConflictFileContent, type CollabConflictFileRequest, type CollabConflictSession, type CollabConflictTextSegment, type CollabOperationOptions, type CollabPublicationReview, type CollabResolveConflictRequest, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ConflictResolutionProjectPort {
  load(projectId: CollabProjectId): Promise<PublishProjectContext>;
  revalidate(context: PublishProjectContext): Promise<void>;
}

export interface ConflictScratchStorePort {
  list(): Promise<readonly ConflictResolutionRecord[]>;
  load(operationId: CollabOperationId): Promise<ConflictResolutionRecord | null>;
  recreateRepository(operationId: CollabOperationId): Promise<string>;
  remove(operationId: CollabOperationId): Promise<boolean>;
  repositoryPath(operationId: CollabOperationId): Promise<string>;
  save(record: ConflictResolutionRecord): Promise<void>;
}

export interface ConflictScratchGitPort {
  applyDecision(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    decision: CollabConflictDecision,
    resolvedPaths?: readonly string[],
  ): Promise<ConflictScratchInspection>;
  retainResultForPublication(
    context: PublishProjectContext,
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resultOid: string,
    signal?: AbortSignal,
    beforeMutation?: () => Promise<void>,
  ): Promise<void>;
  createResolutionCommit(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths: readonly string[],
  ): Promise<string>;
  inspect(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths?: readonly string[],
  ): Promise<ConflictScratchInspection>;
  isPrepared(
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    resolvedPaths?: readonly string[],
  ): Promise<boolean>;
  prepare(
    context: PublishProjectContext,
    scratchPath: string,
    descriptor: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<ConflictScratchInspection>;
  readBlobAtPath(
    scratchPath: string,
    commitOid: string,
    repositoryPath: string,
  ): Promise<Buffer | null>;
  readStage(
    scratchPath: string,
    inspection: ConflictScratchInspection,
    repositoryPath: string,
    stage: 1 | 2 | 3,
  ): Promise<Buffer | null>;
  readTextMergeSegments(
    scratchPath: string,
    personal: Buffer | null,
    base: Buffer | null,
    accepted: Buffer | null,
    signal?: AbortSignal,
  ): Promise<readonly CollabConflictTextSegment[]>;
}

export interface ConflictPublicationPort {
  prepareResolvedReview(
    context: PublishProjectContext,
    input: {
      readonly candidateOid: string;
      readonly contributionHeadOid: string;
      readonly currentMainOid: string;
      readonly operationId: CollabOperationId;
    },
    signal?: AbortSignal,
  ): Promise<CollabPublicationReview>;
}

export interface ConflictResolutionSafetyPort {
  assertSafe(context: PublishProjectContext): Promise<void>;
}

export interface ConflictResolutionCoordinatorOptions {
  readonly now?: () => Date;
}

function conflictError(
  code:
    | 'cancelled'
    | 'content-conflict'
    | 'idempotency-conflict'
    | 'operation-failed'
    | 'project-not-found'
    | 'repository-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'content-conflict'
      ? ['review-conflicts']
      : code === 'project-not-found'
        ? []
        : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw conflictError('cancelled', 'conflict-operation-cancelled');
}

function exactDescriptor(
  left: CollabConflictDescriptor,
  right: CollabConflictDescriptor,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeText(contents: Buffer | null): string | null {
  if (contents === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    throw conflictError('content-conflict', 'conflict-stage-not-text');
  }
}

export class ConflictResolutionCoordinator {
  private readonly now: () => Date;
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly projects: ConflictResolutionProjectPort,
    private readonly store: ConflictScratchStorePort,
    private readonly git: ConflictScratchGitPort,
    private readonly safety: ConflictResolutionSafetyPort,
    private readonly publication: ConflictPublicationPort,
    options: ConflictResolutionCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start(
    descriptor: CollabConflictDescriptor,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    return this.operationQueue.run(() => this.startExclusive(descriptor, options.signal));
  }

  read(
    operationId: CollabOperationId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    return this.operationQueue.run(() => this.readExclusive(operationId, options.signal));
  }

  readFile(
    request: CollabConflictFileRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictFileContent>> {
    return this.operationQueue.run(() => this.readFileExclusive(request, options.signal));
  }

  findProject(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession | null>> {
    return this.operationQueue.run(() => this.findProjectExclusive(projectId, options.signal));
  }

  resolve(
    request: CollabResolveConflictRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    return this.operationQueue.run(() => this.resolveExclusive(request, options.signal));
  }

  prepareWorkingTreeResolution(
    descriptor: CollabConflictDescriptor,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabConflictSession>> {
    return this.operationQueue.run(() => this.prepareWorkingTreeResolutionExclusive(
      descriptor,
      options.signal,
    ));
  }

  discard(
    operationId: CollabOperationId,
  ): Promise<boolean> {
    return this.operationQueue.run(() => this.store.remove(operationId));
  }

  private async startExclusive(
    descriptor: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictSession>> {
    let record: ConflictResolutionRecord | null = null;
    let durableProgress = false;
    try {
      throwIfCancelled(signal);
      const existing = await this.store.load(descriptor.operationId);
      if (existing) {
        if (!exactDescriptor(existing.descriptor, descriptor)) {
          throw conflictError('idempotency-conflict', 'conflict-operation-mismatch');
        }
        record = existing;
      } else {
        const timestamp = this.now().toISOString();
        record = decodeConflictResolutionRecord({
          createdAt: timestamp,
          decisions: [],
          descriptor,
          operationId: descriptor.operationId,
          phase: 'planned',
          projectId: descriptor.projectId,
          resultCommitOid: null,
          schemaVersion: COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
          updatedAt: timestamp,
        });
        await this.store.save(record);
        durableProgress = true;
      }
      const context = await this.loadContext(record, signal);
      record = await this.ensureReady(record, context, signal);
      return { status: 'success', value: this.session(record) };
    } catch (error) {
      return this.failure(error, record, durableProgress);
    }
  }

  private async readExclusive(
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictSession>> {
    let record: ConflictResolutionRecord | null = null;
    try {
      throwIfCancelled(signal);
      record = await this.requireRecord(operationId);
      const context = await this.loadContext(record, signal);
      record = await this.ensureReady(record, context, signal);
      return { status: 'success', value: this.session(record) };
    } catch (error) {
      return this.failure(error, record, false);
    }
  }

  private async readFileExclusive(
    request: CollabConflictFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictFileContent>> {
    let record: ConflictResolutionRecord | null = null;
    try {
      throwIfCancelled(signal);
      record = await this.requireRecord(request.operationId);
      const context = await this.loadContext(record, signal);
      record = await this.ensureReady(record, context, signal);
      const conflict = record.descriptor.conflicts.find(entry => entry.path === request.path);
      if (!conflict) {
        throw conflictError('content-conflict', 'conflict-file-path-invalid');
      }
      if (conflict.kind === 'directory-file' || conflict.kind === 'portability') {
        return {
          status: 'success',
          value: { kind: conflict.kind, path: conflict.path },
        };
      }
      const scratchPath = await this.store.repositoryPath(record.operationId);
      const paths = this.conflictVersionPaths(conflict);
      const [base, personal, accepted] = await Promise.all([
        this.git.readBlobAtPath(scratchPath, record.descriptor.mergeBaseOid, paths.base),
        this.git.readBlobAtPath(
          scratchPath,
          record.descriptor.startingPersonalOid,
          paths.personal,
        ),
        this.git.readBlobAtPath(
          scratchPath,
          record.descriptor.startingMainOid,
          paths.accepted,
        ),
      ]);
      throwIfCancelled(signal);
      if (conflict.kind === 'text') {
        const segments = await this.git.readTextMergeSegments(
          scratchPath,
          personal,
          base,
          accepted,
          signal,
        );
        throwIfCancelled(signal);
        return {
          status: 'success',
          value: {
            accepted: { path: paths.accepted, text: decodeText(accepted) },
            base: { path: paths.base, text: decodeText(base) },
            kind: conflict.kind,
            path: conflict.path,
            personal: { path: paths.personal, text: decodeText(personal) },
            segments,
          },
        };
      }
      return {
        status: 'success',
        value: {
          accepted: this.opaqueVersion(paths.accepted, accepted),
          base: this.opaqueVersion(paths.base, base),
          kind: conflict.kind,
          path: conflict.path,
          personal: this.opaqueVersion(paths.personal, personal),
        },
      };
    } catch (error) {
      return this.failure(error, record, false);
    }
  }

  private async findProjectExclusive(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictSession | null>> {
    let record: ConflictResolutionRecord | null = null;
    try {
      throwIfCancelled(signal);
      const matches = (await this.store.list()).filter(candidate => (
        candidate.projectId === projectId
      ));
      if (matches.length === 0) return { status: 'success', value: null };
      if (matches.length !== 1) {
        throw conflictError('repository-invalid', 'conflict-project-operation-ambiguous');
      }
      record = matches[0];
      const context = await this.loadContext(record, signal);
      record = await this.ensureReady(record, context, signal);
      return { status: 'success', value: this.session(record) };
    } catch (error) {
      return this.failure(error, record, false);
    }
  }

  private async resolveExclusive(
    request: CollabResolveConflictRequest,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictSession>> {
    let record: ConflictResolutionRecord | null = null;
    let durableProgress = false;
    try {
      throwIfCancelled(signal);
      record = await this.requireRecord(request.operationId);
      const context = await this.loadContext(record, signal);
      if (record.phase === 'planned' || record.phase === 'ready') {
        record = this.withDecisions(record, request.decisions);
        await this.store.save(record);
        durableProgress = request.decisions.length > 0;
        record = await this.rebuild(record, context, signal);
      } else if (request.decisions.length > 0) {
        throw conflictError('idempotency-conflict', 'conflict-result-already-committed');
      }
      if (!request.finalize) {
        return { status: 'success', value: this.session(record) };
      }
      if (record.decisions.length !== record.descriptor.conflicts.length) {
        throw conflictError('content-conflict', 'conflict-decisions-incomplete');
      }
      const scratchPath = await this.store.repositoryPath(record.operationId);
      if (record.phase === 'ready' || record.phase === 'planned') {
        await this.projects.revalidate(context);
        await this.safety.assertSafe(context);
        throwIfCancelled(signal);
        const resultCommitOid = await this.git.createResolutionCommit(
          scratchPath,
          record.descriptor,
          this.resolvedPaths(record),
        );
        record = await this.saveRecord(record, {
          phase: 'committed',
          resultCommitOid,
        });
        durableProgress = true;
      }
      if (!record.resultCommitOid) {
        throw conflictError('repository-invalid', 'conflict-result-commit-missing');
      }
      await this.projects.revalidate(context);
      await this.safety.assertSafe(context);
      throwIfCancelled(signal);
      await this.git.retainResultForPublication(
        context,
        scratchPath,
        record.descriptor,
        record.resultCommitOid,
        signal,
        async () => {
          await this.projects.revalidate(context);
          await this.safety.assertSafe(context);
        },
      );
      const publicationReview = await this.publication.prepareResolvedReview(context, {
        candidateOid: record.resultCommitOid,
        contributionHeadOid: record.descriptor.startingPersonalOid,
        currentMainOid: record.descriptor.startingMainOid,
        operationId: record.operationId,
      }, signal);
      durableProgress = true;
      const completedSession = { ...this.session(record), publicationReview };
      await this.store.remove(record.operationId);
      return { status: 'success', value: completedSession };
    } catch (error) {
      return this.failure(error, record, durableProgress);
    }
  }

  private async prepareWorkingTreeResolutionExclusive(
    descriptor: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabConflictSession>> {
    let record: ConflictResolutionRecord | null = null;
    let durableProgress = false;
    try {
      throwIfCancelled(signal);
      record = await this.requireRecord(descriptor.operationId);
      if (record.projectId !== descriptor.projectId) {
        throw conflictError('idempotency-conflict', 'conflict-project-mismatch');
      }
      if (record.phase === 'committed') {
        if (!exactDescriptor(record.descriptor, descriptor)) {
          throw conflictError('idempotency-conflict', 'conflict-operation-mismatch');
        }
        return this.resolveExclusive({
          decisions: [],
          finalize: true,
          operationId: descriptor.operationId,
        }, signal);
      }

      const context = await this.loadContext(record, signal);
      const decisions: readonly CollabConflictDecision[] = descriptor.conflicts
        .filter(conflict => (
          conflict.kind !== 'directory-file' && conflict.kind !== 'portability'
        ))
        .map(conflict => ({ choice: 'keep-personal' as const, path: conflict.path }));
      record = decodeConflictResolutionRecord({
        ...record,
        decisions,
        descriptor,
        phase: 'planned',
        resultCommitOid: null,
        updatedAt: this.now().toISOString(),
      });
      await this.store.save(record);
      durableProgress = true;

      if (decisions.length !== descriptor.conflicts.length) {
        record = await this.rebuild(record, context, signal);
        return { status: 'success', value: this.session(record) };
      }
      return this.resolveExclusive({
        decisions: [],
        finalize: true,
        operationId: descriptor.operationId,
      }, signal);
    } catch (error) {
      return this.failure(error, record, durableProgress);
    }
  }

  private async ensureReady(
    record: ConflictResolutionRecord,
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<ConflictResolutionRecord> {
    if (record.phase === 'committed') return record;
    if (record.phase === 'ready') {
      try {
        const scratchPath = await this.store.repositoryPath(record.operationId);
        if (await this.git.isPrepared(
          scratchPath,
          record.descriptor,
          this.resolvedPaths(record),
        )) {
          return record;
        }
      } catch {
        // Recreate only the derived disposable repository below.
      }
    }
    return this.rebuild(record, context, signal);
  }

  private async rebuild(
    record: ConflictResolutionRecord,
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<ConflictResolutionRecord> {
    throwIfCancelled(signal);
    const scratchPath = await this.store.recreateRepository(record.operationId);
    await this.git.prepare(context, scratchPath, record.descriptor, signal);
    const resolvedPaths: string[] = [];
    for (const decision of record.decisions) {
      throwIfCancelled(signal);
      await this.git.applyDecision(
        scratchPath,
        record.descriptor,
        decision,
        resolvedPaths.slice(),
      );
      resolvedPaths.push(decision.path);
    }
    return this.saveRecord(record, { phase: 'ready' });
  }

  private withDecisions(
    record: ConflictResolutionRecord,
    incoming: readonly CollabConflictDecision[],
  ): ConflictResolutionRecord {
    const conflictPaths = new Set(
      record.descriptor.conflicts.map(conflict => conflict.path),
    );
    const incomingPaths = new Set(incoming.map(decision => decision.path));
    if (
      incomingPaths.size !== incoming.length
      || incoming.some(decision => !conflictPaths.has(decision.path))
    ) {
      throw conflictError('content-conflict', 'conflict-decision-path-invalid');
    }
    const byPath = new Map(record.decisions.map(decision => [decision.path, decision]));
    for (const decision of incoming) byPath.set(decision.path, decision);
    const decisions = record.descriptor.conflicts
      .map(conflict => byPath.get(conflict.path))
      .filter((decision): decision is CollabConflictDecision => decision !== undefined);
    return decodeConflictResolutionRecord({
      ...record,
      decisions,
      phase: 'ready',
      resultCommitOid: null,
      updatedAt: this.now().toISOString(),
    });
  }

  private saveRecord(
    record: ConflictResolutionRecord,
    changes: Partial<Pick<ConflictResolutionRecord, 'phase' | 'resultCommitOid'>>,
  ): Promise<ConflictResolutionRecord> {
    const updated = decodeConflictResolutionRecord({
      ...record,
      ...changes,
      updatedAt: this.now().toISOString(),
    });
    return this.store.save(updated).then(() => updated);
  }

  private async loadContext(
    record: ConflictResolutionRecord,
    signal?: AbortSignal,
  ): Promise<PublishProjectContext> {
    throwIfCancelled(signal);
    const context = await this.projects.load(record.projectId);
    await this.projects.revalidate(context);
    if (context.projectId !== record.projectId) {
      throw conflictError('repository-invalid', 'conflict-project-context-mismatch');
    }
    return context;
  }

  private async requireRecord(
    operationId: CollabOperationId,
  ): Promise<ConflictResolutionRecord> {
    const record = await this.store.load(operationId);
    if (!record) throw conflictError('project-not-found', 'conflict-operation-not-found');
    return record;
  }

  private resolvedPaths(record: ConflictResolutionRecord): readonly string[] {
    const decided = new Set(record.decisions.map(decision => decision.path));
    return record.descriptor.conflicts
      .filter(conflict => decided.has(conflict.path))
      .map(conflict => conflict.path);
  }

  private session(record: ConflictResolutionRecord): CollabConflictSession {
    const resolvedPaths = this.resolvedPaths(record);
    const resolved = new Set(resolvedPaths);
    return {
      decisions: record.decisions,
      descriptor: record.descriptor,
      pending: record.descriptor.conflicts.filter(conflict => !resolved.has(conflict.path)),
      resolvedPaths,
    };
  }

  private conflictVersionPaths(conflict: CollabConflictEntry): {
    accepted: string;
    base: string;
    personal: string;
  } {
    return {
      accepted: conflict.acceptedPath ?? conflict.path,
      base: conflict.path,
      personal: conflict.personalPath ?? conflict.path,
    };
  }

  private opaqueVersion(path: string, contents: Buffer | null): {
    bytes: number;
    exists: boolean;
    path: string;
  } {
    return {
      bytes: contents?.byteLength ?? 0,
      exists: contents !== null,
      path,
    };
  }

  private failure<T>(
    error: unknown,
    record: ConflictResolutionRecord | null,
    durableProgress: boolean,
  ): CollabResult<T> {
    const collabError = error instanceof CollabError
      ? error
      : conflictError('operation-failed', 'conflict-operation-failed');
    if (collabError.code === 'working-tree-busy') {
      return { error: collabError, staleKind: 'working-copy', status: 'stale' };
    }
    if (collabError.code === 'stale-project-selection') {
      return { error: collabError, staleKind: 'project-selection', status: 'stale' };
    }
    if (collabError.code === 'cancelled') {
      if (!durableProgress || !record) {
        return { durableProgress: false, status: 'cancelled' };
      }
      return {
        durablePhase: record.phase === 'committed' ? 'committed' : 'prepared',
        durableProgress: true,
        error: collabError,
        operationId: record.operationId,
        status: 'recovery-required',
      };
    }
    if (record?.phase === 'committed') {
      return {
        durablePhase: 'committed',
        durableProgress: true,
        error: collabError,
        operationId: record.operationId,
        status: 'recovery-required',
      };
    }
    return { error: collabError, status: 'failure' };
  }

}
