import { createHash, randomUUID } from 'node:crypto';

import { type CollabChangeRequest, type CollabFileChangeKind, type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import {
  type CollabPublicationOperationRecord,
  type CollabPublicationStateRecord,
  decodeCollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabConfirmPublishRequest, type CollabConflictDescriptor, type CollabOperationPhase, type CollabPublicationReview, type CollabPublishOutcome, type CollabPublishRequest, type CollabResult } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError, type CollabRecoveryAction } from '@/core/collab/ClaudianCollabError';

const PUBLISH_COMMIT_MESSAGE = 'Update project files';

export interface PublishProjectContext {
  readonly memberId: string;
  readonly personalRef: string;
  readonly projectId: CollabProjectId;
  readonly remoteUrl: string | null;
  readonly repositoryPath: string;
}

export interface PublishChangedFile {
  readonly mode?: number;
  readonly modifiedAtMs?: number;
  readonly path: string;
  readonly previousPath?: string;
  readonly size?: number;
  readonly status: CollabFileChangeKind;
}

export interface PublishRepositorySnapshot {
  readonly acceptedMainOid: string | null;
  readonly changedFiles: readonly PublishChangedFile[];
  readonly headOid: string | null;
  readonly includesAcceptedMain: boolean | null;
  readonly personalAheadBy: number;
  readonly personalBehindBy: number;
  readonly personalRemoteOid: string | null;
  readonly workingTreeClean: boolean;
}

export type PublishAcceptedState =
  | { readonly kind: 'current' }
  | { readonly kind: 'advanced' }
  | {
    readonly kind: 'conflicting';
    readonly conflict: CollabConflictDescriptor;
  };

export type PublishMutationBoundary =
  | 'stage'
  | 'commit'
  | 'fetch'
  | 'integrate'
  | 'push';

export interface PublishProjectPort {
  load(projectId: CollabProjectId): Promise<PublishProjectContext>;
  revalidate(expected: PublishProjectContext): Promise<void>;
}

export interface PublishMutationSafetyPort {
  assertSafe(
    context: PublishProjectContext,
    boundary: PublishMutationBoundary,
  ): Promise<void>;
}

export interface PublishRepositoryPort {
  inspect(
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<PublishRepositorySnapshot>;
  validateChangedFiles(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  stageAll(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  commitStaged(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    message: string,
    signal?: AbortSignal,
  ): Promise<string>;
  fetch(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  classifyAcceptedState(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<PublishAcceptedState>;
  isAncestor(
    context: PublishProjectContext,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean>;
  pushPersonal(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PublishRequestEnsureInput {
  readonly description: string;
  readonly expectedMainOid: string;
  readonly headOid: string;
  readonly idempotencyKey: string;
  readonly projectId: CollabProjectId;
  readonly signal?: AbortSignal;
}

export interface PublishRequestEnsurePort {
  ensure(input: PublishRequestEnsureInput): Promise<CollabChangeRequest>;
}

export interface PublishPublicationStatePort {
  load(projectId: CollabProjectId): Promise<CollabPublicationStateRecord>;
  save(record: CollabPublicationStateRecord): Promise<void>;
}

export interface PublishCandidatePort {
  apply(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    input: {
      readonly candidateOid: string;
      readonly contributionHeadOid: string;
      readonly currentMainOid: string;
      readonly operationId: CollabOperationId;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  assertRetained(
    context: PublishProjectContext,
    input: {
      readonly candidateOid: string;
      readonly contributionHeadOid: string;
      readonly currentMainOid: string;
      readonly operationId: CollabOperationId;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  cleanup(
    context: PublishProjectContext,
    operationId: CollabOperationId,
    candidateOid: string,
  ): Promise<void>;
  prepare(
    context: PublishProjectContext,
    input: {
      readonly contributionHeadOid: string;
      readonly currentMainOid: string;
      readonly operationId: CollabOperationId;
    },
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface PublishComparisonPort {
  compare(
    repositoryPath: string,
    comparisonBaseOid: string,
    comparisonTargetOid: string,
    signal?: AbortSignal,
  ): Promise<CollabPublicationReview['files']>;
}

export interface PublishCoordinatorOptions {
  readonly createOperationId?: () => CollabOperationId;
  readonly now?: () => Date;
  readonly onPhase?: (phase: CollabOperationPhase) => void | Promise<void>;
}

interface PublishProgress {
  durablePhase: CollabOperationPhase | null;
  headOid: string | null;
  remoteHeadOid: string | null;
}

function publishError(
  code:
    | 'cancelled'
    | 'content-conflict'
    | 'durable-progress-recovery-required'
    | 'operation-failed'
    | 'personal-ref-diverged'
    | 'repository-invalid'
    | 'stale-main'
    | 'stale-request-head'
    | 'working-tree-busy',
  reason: string,
  recoveryActions: readonly CollabRecoveryAction[] = [],
): CollabError {
  return new CollabError({ code, recoveryActions, safeContext: { reason } });
}

function asCollabError(error: unknown): CollabError {
  return error instanceof CollabError
    ? error
    : publishError('operation-failed', 'publish-failed', ['retry', 'open-diagnostics']);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw publishError('cancelled', 'publish-cancelled', ['retry']);
  }
}

function isConnectivityFailure(error: CollabError): boolean {
  return error.group === 'connectivity';
}

export function publishSnapshotFingerprint(snapshot: PublishRepositorySnapshot): string {
  return JSON.stringify({
    acceptedMainOid: snapshot.acceptedMainOid,
    changedFiles: snapshot.changedFiles.map(file => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      mode: file.mode ?? null,
      modifiedAtMs: file.modifiedAtMs ?? null,
      size: file.size ?? null,
      status: file.status,
    })),
    headOid: snapshot.headOid,
    includesAcceptedMain: snapshot.includesAcceptedMain,
    personalAheadBy: snapshot.personalAheadBy,
    personalBehindBy: snapshot.personalBehindBy,
    personalRemoteOid: snapshot.personalRemoteOid,
    workingTreeClean: snapshot.workingTreeClean,
  });
}

function assertSameSnapshot(
  actual: PublishRepositorySnapshot,
  expected: PublishRepositorySnapshot,
): void {
  if (publishSnapshotFingerprint(actual) !== publishSnapshotFingerprint(expected)) {
    throw publishError('working-tree-busy', 'publish-repository-state-changed', ['retry']);
  }
}

function requireHead(snapshot: PublishRepositorySnapshot): string {
  if (!snapshot.headOid) {
    throw publishError('repository-invalid', 'publish-head-missing', ['open-diagnostics']);
  }
  return snapshot.headOid;
}

function requireAcceptedMain(snapshot: PublishRepositorySnapshot): string {
  if (!snapshot.acceptedMainOid) {
    throw publishError('repository-invalid', 'publish-accepted-main-missing', [
      'open-diagnostics',
    ]);
  }
  return snapshot.acceptedMainOid;
}

function requestIntentKey(
  context: PublishProjectContext,
  headOid: string,
  expectedMainOid: string,
  description: string,
): string {
  const digest = createHash('sha256')
    .update(context.projectId)
    .update('\0')
    .update(context.memberId)
    .update('\0')
    .update(headOid)
    .update('\0')
    .update(expectedMainOid)
    .update('\0')
    .update(description)
    .digest('hex');
  return `publish-${digest}`;
}

export function normalizeCollabPublishDescription(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  while (lines[0]?.trim().length === 0) lines.shift();
  while (lines.at(-1)?.trim().length === 0) lines.pop();
  const description = lines.join('\n');
  if (description.trim().length === 0) {
    throw new CollabError({ code: 'description-required' });
  }
  if (new TextEncoder().encode(description).byteLength
    > CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes) {
    throw new CollabError({ code: 'quota-exceeded' });
  }
  return description;
}

function conflictDescriptorFingerprint(descriptor: CollabConflictDescriptor): string {
  return JSON.stringify({
    conflicts: descriptor.conflicts.map(conflict => ({
      acceptedOid: conflict.acceptedOid ?? null,
      acceptedPath: conflict.acceptedPath ?? null,
      baseOid: conflict.baseOid ?? null,
      kind: conflict.kind,
      path: conflict.path,
      personalOid: conflict.personalOid ?? null,
      personalPath: conflict.personalPath ?? null,
    })),
    mergeBaseOid: descriptor.mergeBaseOid,
    operationId: descriptor.operationId,
    projectId: descriptor.projectId,
    startingMainOid: descriptor.startingMainOid,
    startingPersonalOid: descriptor.startingPersonalOid,
  });
}

export class PublishCoordinator {
   readonly #createOperationId: () => CollabOperationId;
  private readonly now: () => Date;
   readonly #operationQueue = new SerialTaskQueue();

  constructor(
    private readonly projects: PublishProjectPort,
    private readonly repository: PublishRepositoryPort,
    private readonly requests: PublishRequestEnsurePort,
    private readonly mutationSafety: PublishMutationSafetyPort,
    private readonly publicationState: PublishPublicationStatePort,
    private readonly candidates: PublishCandidatePort,
    private readonly comparisons: PublishComparisonPort,
    private readonly options: PublishCoordinatorOptions = {},
  ) {
    this.#createOperationId = options.createOperationId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  publish(
    request: CollabPublishRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    return this.#operationQueue.run(() => this.#publishExclusive(
      request.projectId,
      normalizeCollabPublishDescription(request.description),
      options.signal,
    ));
  }

  publishConflictResolution(
    request: CollabPublishRequest,
    conflict: CollabConflictDescriptor,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    return this.#operationQueue.run(() => this.#publishConflictResolutionExclusive(
      request,
      conflict,
      options.signal,
    ));
  }

  confirm(
    request: CollabConfirmPublishRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabResult<CollabPublishOutcome>> {
    return this.#operationQueue.run(() => this.#confirmExclusive(request, options.signal));
  }

  captureConflict(
    descriptor: CollabConflictDescriptor,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.#operationQueue.run(() => this.#captureConflictExclusive(descriptor, options.signal));
  }

  prepareReview(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CollabPublicationReview> {
    return this.#operationQueue.run(() => this.#prepareReviewExclusive(
      projectId,
      operationId,
      options.signal,
    ));
  }

   async #prepareReviewExclusive(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<CollabPublicationReview> {
    throwIfCancelled(signal);
    const context = await this.projects.load(projectId);
    await this.projects.revalidate(context);
    const state = await this.#loadState(projectId);
    const operation = this.#requirePhase(state, 'review-ready');
    if (operation.operationId !== operationId) {
      throw publishError('stale-request-head', 'publication-review-operation-changed', [
        'retry',
      ]);
    }
    const current = await this.repository.inspect(context, signal);
    this.#assertCapturedSnapshot(current, operation);
    await this.candidates.assertRetained(context, this.#candidateInput(operation), signal);
    await this.#assertStateExact(state);
    return this.#buildReview(state, context, operation, signal);
  }

   async #captureConflictExclusive(
    descriptor: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    const context = await this.projects.load(descriptor.projectId);
    await this.projects.revalidate(context);
    const state = await this.#loadState(descriptor.projectId);
    const current = await this.repository.inspect(context, signal);
    if (
      current.headOid !== descriptor.startingPersonalOid
      || current.acceptedMainOid !== descriptor.startingMainOid
      || current.personalRemoteOid !== descriptor.startingPersonalOid
      || current.personalAheadBy !== 0
      || current.personalBehindBy !== 0
      || !current.workingTreeClean
      || current.changedFiles.length !== 0
    ) {
      throw publishError('working-tree-busy', 'publication-conflict-state-changed', ['retry']);
    }
    const acceptedState = await this.repository.classifyAcceptedState(
      context,
      current,
      descriptor.operationId,
      signal,
    );
    if (
      acceptedState.kind !== 'conflicting'
      || conflictDescriptorFingerprint(acceptedState.conflict)
        !== conflictDescriptorFingerprint(descriptor)
    ) {
      throw publishError('working-tree-busy', 'publication-conflict-analysis-changed', ['retry']);
    }
    if (state.operation) {
      if (
        state.operation.phase === 'captured'
        && state.operation.operationId === descriptor.operationId
        && state.operation.contributionHeadOid === descriptor.startingPersonalOid
      ) return;
      throw publishError('working-tree-busy', 'publication-operation-already-active', ['retry']);
    }
    await this.#assertStateExact(state);
    const timestamp = this.now().toISOString();
    await this.publicationState.save({
      ...state,
      operation: {
        candidateOid: null,
        contributionHeadOid: descriptor.startingPersonalOid,
        createdAt: timestamp,
        currentMainOid: null,
        operationId: descriptor.operationId,
        phase: 'captured',
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    });
  }

   async #publishExclusive(
    projectId: CollabProjectId,
    description: string,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const nextOperationId = this.#createOperationId();
    let operationId = nextOperationId;
    const progress: PublishProgress = {
      durablePhase: null,
      headOid: null,
      remoteHeadOid: null,
    };
    try {
      throwIfCancelled(signal);
      const context = await this.projects.load(projectId);
      await this.projects.revalidate(context);
      let state = await this.#loadState(projectId);
      if (state.operation) {
        const activeOperation = state.operation;
        operationId = activeOperation.operationId;
        progress.headOid = activeOperation.contributionHeadOid;
        progress.durablePhase = this.#durablePhase(activeOperation.phase);
        if (activeOperation.phase === 'review-ready') {
          const current = await this.repository.inspect(context, signal);
          if (
            current.headOid === activeOperation.contributionHeadOid
            && current.workingTreeClean
            && current.changedFiles.length === 0
          ) {
            return await this.#resumeReview(state, context, progress, description, signal);
          }
          const candidateOid = this.#requireOperationOid(
            activeOperation.candidateOid,
            'publication-review-candidate-missing',
          );
          await this.candidates.cleanup(
            context,
            activeOperation.operationId,
            candidateOid,
          );
          const updatedAt = this.now().toISOString();
          state = { ...state, operation: null, updatedAt };
          await this.publicationState.save(state);
          operationId = nextOperationId;
          progress.durablePhase = null;
          progress.headOid = null;
        }
        if (state.operation?.phase !== undefined && state.operation.phase !== 'captured') {
          return await this.finalize(state, context, progress, description, signal);
        }
        if (state.operation?.phase === 'captured') {
          return await this.#prepareCaptured(
            state,
            context,
            progress,
            description,
            false,
            signal,
          );
        }
      }

      let current = await this.repository.inspect(context, signal);
      progress.headOid = requireHead(current);
      await this.#reportPhase('validating');

      if (!current.workingTreeClean) {
        await this.repository.validateChangedFiles(context, current, signal);
        await this.beforeWrite(context, 'stage', current, signal);
        await this.repository.stageAll(context, current, signal);
        await this.#reportPhase('staging');
        current = await this.repository.inspect(context, signal);

        if (!current.workingTreeClean) {
          await this.beforeWrite(context, 'commit', current, signal);
          const expectedHead = requireHead(current);
          const committedHead = await this.repository.commitStaged(
            context,
            current,
            PUBLISH_COMMIT_MESSAGE,
            signal,
          );
          progress.headOid = committedHead;
          progress.durablePhase = 'committed';
          await this.#reportPhase('committed');
          current = await this.repository.inspect(context, signal);
          if (current.headOid !== committedHead || !current.workingTreeClean) {
            throw publishError('working-tree-busy', 'publish-post-commit-state-changed', ['retry']);
          }
          if (expectedHead === committedHead) {
            throw publishError('repository-invalid', 'publish-commit-did-not-advance', [
              'open-diagnostics',
            ]);
          }
        }
      }

      const contributionHeadOid = requireHead(current);
      progress.headOid = contributionHeadOid;
      const timestamp = this.now().toISOString();
      state = {
        ...state,
        operation: {
          candidateOid: null,
          contributionHeadOid,
          createdAt: timestamp,
          currentMainOid: null,
          operationId,
          phase: 'captured',
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
      };
      await this.publicationState.save(state);
      progress.durablePhase = 'committed';
      return await this.#prepareCaptured(
        state,
        context,
        progress,
        description,
        false,
        signal,
      );
    } catch (error) {
      return this.#failureResult(projectId, operationId, progress, asCollabError(error));
    }
  }

   async #publishConflictResolutionExclusive(
    request: CollabPublishRequest,
    conflict: CollabConflictDescriptor,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const progress: PublishProgress = {
      durablePhase: 'committed',
      headOid: conflict.startingPersonalOid,
      remoteHeadOid: null,
    };
    try {
      throwIfCancelled(signal);
      const description = normalizeCollabPublishDescription(request.description);
      const context = await this.projects.load(request.projectId);
      await this.projects.revalidate(context);
      let state = await this.#loadState(request.projectId);
      const operation = this.#requirePhase(state, 'captured');
      if (
        conflict.projectId !== request.projectId
        || conflict.operationId !== operation.operationId
        || conflict.startingPersonalOid !== operation.contributionHeadOid
      ) {
        throw publishError('stale-request-head', 'publication-conflict-operation-changed', [
          'retry',
        ]);
      }

      let current = await this.repository.inspect(context, signal);
      const currentHead = requireHead(current);
      if (
        currentHead !== operation.contributionHeadOid
        && !await this.repository.isAncestor(
          context,
          operation.contributionHeadOid,
          currentHead,
        )
      ) {
        throw publishError('working-tree-busy', 'publication-conflict-head-diverged', [
          'retry',
        ]);
      }

      if (!current.workingTreeClean) {
        await this.repository.validateChangedFiles(context, current, signal);
        await this.beforeWrite(context, 'stage', current, signal);
        await this.repository.stageAll(context, current, signal);
        await this.#reportPhase('staging');
        current = await this.repository.inspect(context, signal);
        if (!current.workingTreeClean) {
          await this.beforeWrite(context, 'commit', current, signal);
          const expectedHead = requireHead(current);
          const committedHead = await this.repository.commitStaged(
            context,
            current,
            PUBLISH_COMMIT_MESSAGE,
            signal,
          );
          progress.headOid = committedHead;
          await this.#reportPhase('committed');
          current = await this.repository.inspect(context, signal);
          if (
            current.headOid !== committedHead
            || !current.workingTreeClean
            || expectedHead === committedHead
          ) {
            throw publishError('working-tree-busy', 'publication-conflict-commit-changed', [
              'retry',
            ]);
          }
        }
      }

      const contributionHeadOid = requireHead(current);
      progress.headOid = contributionHeadOid;
      if (contributionHeadOid === conflict.startingPersonalOid) {
        return {
          conflict,
          error: publishError(
            'content-conflict',
            'publication-conflict-resolution-not-edited',
            ['retry'],
          ),
          status: 'conflict',
        };
      }
      if (contributionHeadOid !== operation.contributionHeadOid) {
        if (!await this.repository.isAncestor(
          context,
          operation.contributionHeadOid,
          contributionHeadOid,
        )) {
          throw publishError('working-tree-busy', 'publication-conflict-head-diverged', [
            'retry',
          ]);
        }
        state = this.transition(state, operation, {
          candidateOid: null,
          contributionHeadOid,
          currentMainOid: null,
          phase: 'captured',
        });
        await this.publicationState.save(state);
      }
      return await this.#prepareCaptured(
        state,
        context,
        progress,
        description,
        true,
        signal,
      );
    } catch (error) {
      return this.#failureResult(
        request.projectId,
        conflict.operationId,
        progress,
        asCollabError(error),
      );
    }
  }

   async #confirmExclusive(
    request: CollabConfirmPublishRequest,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const progress: PublishProgress = {
      durablePhase: 'prepared',
      headOid: null,
      remoteHeadOid: null,
    };
    try {
      throwIfCancelled(signal);
      const description = normalizeCollabPublishDescription(request.description);
      const context = await this.projects.load(request.projectId);
      await this.projects.revalidate(context);
      const state = await this.#loadState(request.projectId);
      const operation = state.operation;
      if (!operation || operation.phase !== 'review-ready') {
        throw publishError('stale-request-head', 'publication-review-not-current', ['retry']);
      }
      const candidateOid = this.#requireOperationOid(
        operation.candidateOid,
        'publication-review-candidate-missing',
      );
      const currentMainOid = this.#requireOperationOid(
        operation.currentMainOid,
        'publication-review-main-missing',
      );
      if (
        operation.operationId !== request.operationId
        || candidateOid !== request.expectedCandidateOid
      ) {
        throw publishError('stale-request-head', 'publication-review-candidate-changed', [
          'retry',
        ]);
      }
      if (currentMainOid !== request.expectedMainOid) {
        throw publishError('stale-main', 'publication-review-main-changed', ['retry']);
      }
      progress.headOid = operation.contributionHeadOid;
      const current = await this.repository.inspect(context, signal);
      this.#assertCapturedSnapshot(current, operation);
      await this.candidates.assertRetained(context, this.#candidateInput(operation), signal);
      await this.#assertStateExact(state);
      const confirmed = this.transition(state, operation, {
        phase: 'confirmed',
      });
      await this.publicationState.save(confirmed);
      progress.durablePhase = 'prepared';
      return await this.finalize(confirmed, context, progress, description, signal);
    } catch (error) {
      return this.#failureResult(
        request.projectId,
        request.operationId,
        progress,
        asCollabError(error),
      );
    }
  }

   async #prepareCaptured(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    progress: PublishProgress,
    description: string,
    requiresReview: boolean,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const operation = this.#requirePhase(state, 'captured');
    let current = await this.repository.inspect(context, signal);
    this.#assertCapturedSnapshot(current, operation);
    await this.beforeWrite(context, 'fetch', current, signal);
    await this.repository.fetch(context, current, signal);
    progress.durablePhase = 'fetching';
    await this.#reportPhase('fetching');
    current = await this.repository.inspect(context, signal);
    this.#assertCapturedSnapshot(current, operation);
    const personalProblem = this.#personalRefProblem(current);
    if (personalProblem) throw personalProblem;
    const currentMainOid = requireAcceptedMain(current);
    const acceptedState = await this.repository.classifyAcceptedState(
      context,
      current,
      operation.operationId,
      signal,
    );
    if (acceptedState.kind === 'conflicting') {
      return this.#conflict(acceptedState.conflict);
    }
    await this.#assertStateExact(state);

    if (state.baseMainOid === currentMainOid) {
      if (acceptedState.kind !== 'current') {
        throw publishError('repository-invalid', 'publication-base-main-not-reachable', [
          'open-diagnostics',
        ]);
      }
      if (requiresReview) {
        const reviewReady = this.transition(state, operation, {
          candidateOid: operation.contributionHeadOid,
          currentMainOid,
          phase: 'review-ready',
        });
        await this.publicationState.save(reviewReady);
        progress.durablePhase = 'prepared';
        return this.#reviewRequired(
          reviewReady,
          context,
          this.#requirePhase(reviewReady, 'review-ready'),
          signal,
        );
      }
      const confirmed = this.transition(state, operation, {
        candidateOid: operation.contributionHeadOid,
        currentMainOid,
        phase: 'confirmed',
      });
      await this.publicationState.save(confirmed);
      progress.durablePhase = 'prepared';
      return this.finalize(confirmed, context, progress, description, signal);
    }

    const candidateOid = await this.candidates.prepare(context, {
      contributionHeadOid: operation.contributionHeadOid,
      currentMainOid,
      operationId: operation.operationId,
    }, signal);
    const reviewReady = this.transition(state, operation, {
      candidateOid,
      currentMainOid,
      phase: 'review-ready',
    });
    await this.publicationState.save(reviewReady);
    progress.durablePhase = 'prepared';
    return this.#reviewRequired(
      reviewReady,
      context,
      this.#requirePhase(reviewReady, 'review-ready'),
      signal,
    );
  }

   async #resumeReview(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    progress: PublishProgress,
    description: string,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const operation = this.#requirePhase(state, 'review-ready');
    let current = await this.repository.inspect(context, signal);
    this.#assertCapturedSnapshot(current, operation);
    await this.beforeWrite(context, 'fetch', current, signal);
    await this.repository.fetch(context, current, signal);
    current = await this.repository.inspect(context, signal);
    this.#assertCapturedSnapshot(current, operation);
    const currentMainOid = requireAcceptedMain(current);
    if (operation.currentMainOid !== currentMainOid) {
      return this.#reprepare(state, context, current, progress, description, signal);
    }
    await this.candidates.assertRetained(context, this.#candidateInput(operation), signal);
    return this.#reviewRequired(state, context, operation, signal);
  }

  private async finalize(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    progress: PublishProgress,
    description: string,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    let operation = state.operation;
    if (!operation || operation.phase === 'captured' || operation.phase === 'review-ready') {
      throw publishError('repository-invalid', 'publication-finalize-phase-invalid', [
        'open-diagnostics',
      ]);
    }
    let current = await this.repository.inspect(context, signal);
    await this.beforeWrite(context, 'fetch', current, signal);
    await this.repository.fetch(context, current, signal);
    current = await this.repository.inspect(context, signal);
    const currentMainOid = requireAcceptedMain(current);
    const preparedMainOid = this.#requireOperationOid(
      operation.currentMainOid,
      'publication-current-main-missing',
    );
    if (currentMainOid !== preparedMainOid) {
      return this.#reprepare(state, context, current, progress, description, signal);
    }
    const candidateOid = this.#requireOperationOid(
      operation.candidateOid,
      'publication-candidate-missing',
    );
    if (operation.phase === 'confirmed') {
      if (candidateOid !== operation.contributionHeadOid) {
        await this.beforeWrite(context, 'integrate', current, signal);
        await this.candidates.apply(context, current, this.#candidateInput(operation), signal);
        current = await this.repository.inspect(context, signal);
      } else if (
        current.headOid !== operation.contributionHeadOid
        || !current.workingTreeClean
      ) {
        throw publishError('working-tree-busy', 'publication-direct-head-changed', ['retry']);
      }
      state = this.transition(
        { ...state, baseMainOid: preparedMainOid },
        operation,
        { phase: 'applied' },
      );
      await this.publicationState.save(state);
      operation = this.#requirePhase(state, 'applied');
      progress.headOid = candidateOid;
      progress.durablePhase = 'ref-updated';
      await this.#reportPhase('ref-updated');
    }

    if (operation.phase === 'applied') {
      if (current.headOid !== candidateOid) {
        current = await this.repository.inspect(context, signal);
      }
      if (current.headOid !== candidateOid || !current.workingTreeClean) {
        throw publishError('working-tree-busy', 'publication-applied-head-changed', ['retry']);
      }
      if (current.personalAheadBy > 0) {
        await this.beforeWrite(context, 'push', current, signal);
        await this.repository.pushPersonal(context, current, signal);
        current = await this.repository.inspect(context, signal);
      }
      if (
        current.headOid !== candidateOid
        || current.personalRemoteOid !== candidateOid
        || current.personalAheadBy !== 0
        || current.personalBehindBy !== 0
      ) {
        throw publishError('repository-invalid', 'publish-push-head-not-exact', [
          'retry',
          'open-diagnostics',
        ]);
      }
      state = this.transition(state, operation, { phase: 'pushed' });
      await this.publicationState.save(state);
      operation = this.#requirePhase(state, 'pushed');
      progress.headOid = candidateOid;
      progress.remoteHeadOid = candidateOid;
      progress.durablePhase = 'pushed';
      await this.#reportPhase('pushed');
    }

    current = await this.repository.inspect(context, signal);
    if (
      current.headOid !== candidateOid
      || current.personalRemoteOid !== candidateOid
      || requireAcceptedMain(current) !== preparedMainOid
    ) {
      throw publishError('working-tree-busy', 'publish-request-head-changed', ['retry']);
    }
    throwIfCancelled(signal);
    let request: CollabChangeRequest;
    try {
      request = await this.requests.ensure({
        description,
        expectedMainOid: preparedMainOid,
        headOid: candidateOid,
        idempotencyKey: requestIntentKey(
          context,
          candidateOid,
          preparedMainOid,
          description,
        ),
        projectId: context.projectId,
        signal,
      });
    } catch (error) {
      const collabError = asCollabError(error);
      if (collabError.code !== 'stale-main') throw collabError;
      current = await this.repository.inspect(context, signal);
      await this.beforeWrite(context, 'fetch', current, signal);
      await this.repository.fetch(context, current, signal);
      current = await this.repository.inspect(context, signal);
      if (requireAcceptedMain(current) === preparedMainOid) throw collabError;
      return this.#reprepare(state, context, current, progress, description, signal);
    }
    if (
      request.memberId !== context.memberId
      || request.latestHeadOid !== candidateOid
      || request.status !== 'open'
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        recoveryActions: ['open-diagnostics'],
        safeContext: { reason: 'publish-request-response-mismatch' },
      });
    }
    if (candidateOid !== operation.contributionHeadOid) {
      await this.candidates.cleanup(context, operation.operationId, candidateOid);
    }
    const completedAt = this.now().toISOString();
    await this.publicationState.save({
      ...state,
      baseMainOid: preparedMainOid,
      operation: null,
      updatedAt: completedAt,
    });
    progress.durablePhase = 'request-synchronized';
    await this.#reportPhase('request-synchronized');
    return {
      status: 'success',
      value: {
        localHeadOid: candidateOid,
        projectId: context.projectId,
        remoteHeadOid: candidateOid,
        request,
        state: 'request-synchronized',
      },
    };
  }

   async #reprepare(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    current: PublishRepositorySnapshot,
    progress: PublishProgress,
    description: string,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const previous = state.operation;
    if (!previous) {
      throw publishError('repository-invalid', 'publication-operation-missing', [
        'open-diagnostics',
      ]);
    }
    const headOid = requireHead(current);
    if (!current.workingTreeClean) {
      throw publishError('working-tree-busy', 'publication-reprepare-tree-dirty', ['retry']);
    }
    if (previous.candidateOid && previous.candidateOid !== previous.contributionHeadOid) {
      await this.candidates.cleanup(context, previous.operationId, previous.candidateOid);
    }
    const timestamp = this.now().toISOString();
    const next: CollabPublicationStateRecord = {
      ...state,
      baseMainOid: previous.currentMainOid ?? state.baseMainOid,
      operation: {
        candidateOid: null,
        contributionHeadOid: headOid,
        createdAt: timestamp,
        currentMainOid: null,
        operationId: this.#createOperationId(),
        phase: 'captured',
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    await this.publicationState.save(next);
    progress.headOid = headOid;
    progress.durablePhase = 'committed';
    return this.#prepareCaptured(next, context, progress, description, true, signal);
  }

   async #reviewRequired(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    operation: CollabPublicationOperationRecord,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabPublishOutcome>> {
    const review = await this.#buildReview(state, context, operation, signal);
    return {
      status: 'success',
      value: {
        localHeadOid: operation.contributionHeadOid,
        projectId: context.projectId,
        review,
        state: 'review-required',
      },
    };
  }

   async #buildReview(
    state: CollabPublicationStateRecord,
    context: PublishProjectContext,
    operation: CollabPublicationOperationRecord,
    signal?: AbortSignal,
  ): Promise<CollabPublicationReview> {
    const candidateOid = this.#requireOperationOid(
      operation.candidateOid,
      'publication-review-candidate-missing',
    );
    const currentMainOid = this.#requireOperationOid(
      operation.currentMainOid,
      'publication-review-main-missing',
    );
    const files = await this.comparisons.compare(
      context.repositoryPath,
      currentMainOid,
      candidateOid,
      signal,
    );
    return {
      baseMainOid: state.baseMainOid,
      candidateOid,
      canConfirm: true,
      comparisonBaseOid: currentMainOid,
      comparisonTargetOid: candidateOid,
      contributionHeadOid: operation.contributionHeadOid,
      currentMainOid,
      files,
      kind: 'publication',
      operationId: operation.operationId,
      projectId: context.projectId,
    };
  }

   #conflict(
    descriptor: CollabConflictDescriptor,
  ): CollabResult<CollabPublishOutcome> {
    return {
      conflict: descriptor,
      error: publishError('content-conflict', 'publish-accepted-main-conflict', [
        'review-conflicts',
      ]),
      status: 'conflict',
    };
  }

   #assertCapturedSnapshot(
    snapshot: PublishRepositorySnapshot,
    operation: CollabPublicationOperationRecord,
  ): void {
    if (
      snapshot.headOid !== operation.contributionHeadOid
      || !snapshot.workingTreeClean
      || snapshot.changedFiles.length !== 0
    ) {
      throw publishError('working-tree-busy', 'publication-contribution-head-changed', [
        'retry',
      ]);
    }
  }

   async #assertStateExact(expected: CollabPublicationStateRecord): Promise<void> {
    const actual = await this.publicationState.load(expected.projectId);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw publishError('working-tree-busy', 'publication-state-changed', ['retry']);
    }
  }

   #candidateInput(operation: CollabPublicationOperationRecord): {
    readonly candidateOid: string;
    readonly contributionHeadOid: string;
    readonly currentMainOid: string;
    readonly operationId: CollabOperationId;
  } {
    return {
      candidateOid: this.#requireOperationOid(
        operation.candidateOid,
        'publication-candidate-missing',
      ),
      contributionHeadOid: operation.contributionHeadOid,
      currentMainOid: this.#requireOperationOid(
        operation.currentMainOid,
        'publication-current-main-missing',
      ),
      operationId: operation.operationId,
    };
  }

   #durablePhase(
    phase: CollabPublicationOperationRecord['phase'],
  ): CollabOperationPhase {
    if (phase === 'captured') return 'committed';
    if (phase === 'review-ready' || phase === 'confirmed') return 'prepared';
    if (phase === 'applied') return 'ref-updated';
    return 'pushed';
  }

   async #loadState(projectId: CollabProjectId): Promise<CollabPublicationStateRecord> {
    const state = await this.publicationState.load(projectId);
    if (state.projectId !== projectId) {
      throw publishError('repository-invalid', 'publication-state-project-mismatch', [
        'open-diagnostics',
      ]);
    }
    return state;
  }

   #requireOperationOid(value: string | null, reason: string): string {
    if (!value) throw publishError('repository-invalid', reason, ['open-diagnostics']);
    return value;
  }

   #requirePhase(
    state: CollabPublicationStateRecord,
    phase: CollabPublicationOperationRecord['phase'],
  ): CollabPublicationOperationRecord {
    if (!state.operation || state.operation.phase !== phase) {
      throw publishError('repository-invalid', 'publication-operation-phase-mismatch', [
        'open-diagnostics',
      ]);
    }
    return state.operation;
  }

  private transition(
    state: CollabPublicationStateRecord,
    operation: CollabPublicationOperationRecord,
    update: Partial<CollabPublicationOperationRecord>,
  ): CollabPublicationStateRecord {
    const updatedAt = this.now().toISOString();
    return decodeCollabPublicationStateRecord({
      ...state,
      operation: { ...operation, ...update, updatedAt },
      updatedAt,
    });
  }

   #personalRefProblem(snapshot: PublishRepositorySnapshot): CollabError | null {
    if (!snapshot.personalRemoteOid) {
      return publishError('repository-invalid', 'publish-personal-remote-missing', [
        'retry',
        'open-diagnostics',
      ]);
    }
    if (snapshot.personalBehindBy > 0) {
      return publishError('personal-ref-diverged', 'publish-personal-ref-not-fast-forward', [
        'reclone',
        'open-diagnostics',
      ]);
    }
    return null;
  }

  private async beforeWrite(
    context: PublishProjectContext,
    boundary: PublishMutationBoundary,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    await this.projects.revalidate(context);
    await this.mutationSafety.assertSafe(context, boundary);
    const actual = await this.repository.inspect(context, signal);
    assertSameSnapshot(actual, expected);
    throwIfCancelled(signal);
  }

   #failureResult(
    projectId: CollabProjectId,
    operationId: CollabOperationId,
    progress: PublishProgress,
    error: CollabError,
  ): CollabResult<CollabPublishOutcome> {
    if (isConnectivityFailure(error) && progress.headOid) {
      if (progress.remoteHeadOid === progress.headOid) {
        return {
          status: 'success',
          value: {
            localHeadOid: progress.headOid,
            projectId,
            remoteHeadOid: progress.headOid,
            state: 'pushed',
          },
        };
      }
      return {
        status: 'success',
        value: {
          localHeadOid: progress.headOid,
          projectId,
          state: 'committed-locally',
        },
      };
    }
    if (error.code === 'stale-project-selection') {
      return { error, staleKind: 'project-selection', status: 'stale' };
    }
    if (error.code === 'stale-main') {
      return { error, staleKind: 'main', status: 'stale' };
    }
    if (error.code === 'stale-request-head') {
      return { error, staleKind: 'operation', status: 'stale' };
    }
    if (error.code === 'working-tree-busy') {
      return { error, staleKind: 'working-copy', status: 'stale' };
    }
    if (error.code === 'personal-ref-diverged') {
      return { error, status: 'failure' };
    }
    if (progress.durablePhase) {
      return {
        durablePhase: progress.durablePhase,
        durableProgress: true,
        error: error.code === 'cancelled'
          ? publishError('durable-progress-recovery-required', 'publish-cancelled-after-progress', [
            'resume',
          ])
          : error,
        operationId,
        status: 'recovery-required',
      };
    }
    if (error.code === 'cancelled') {
      return { durableProgress: false, operationId, status: 'cancelled' };
    }
    return { error, status: 'failure' };
  }

   async #reportPhase(phase: CollabOperationPhase): Promise<void> {
    await this.options.onPhase?.(phase);
  }

}
