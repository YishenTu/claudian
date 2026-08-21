import {
  type CollabGitOid,
  type CollabMemberId,
  type CollabProjectId,
  decodeDevelopmentBootstrapManifest,
  type DevelopmentBootstrapClientReadiness,
  type DevelopmentBootstrapManifest,
} from '@claudian/collab-protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

export const CLOUD_BOOTSTRAP_READINESS_OPERATIONS = Object.freeze([
  'cleanup',
  'conflictRecovery',
  'hostTransfer',
  'join',
  'leave',
  'managerResponsibility',
  'projectSetup',
  'publish',
  'reconciliation',
  'reconnect',
  'retirement',
] as const);

export type CloudBootstrapReadinessOperation =
  typeof CLOUD_BOOTSTRAP_READINESS_OPERATIONS[number];

export interface CloudBootstrapReadinessObservation {
  readonly collabGitChildCount: number;
  readonly operations: Readonly<
    Record<CloudBootstrapReadinessOperation, 'active' | 'settled'>
  >;
  readonly preservedWork: {
    readonly hasLocalOnlyCommits: boolean;
    readonly hasPrivateDraft: boolean;
    readonly hasUnpublishedFiles: boolean;
  };
  readonly projectOperationQueue: {
    readonly activeCount: number;
    readonly queuedCount: number;
  };
  readonly projectWorkSession: 'closed' | 'open';
  readonly repository: {
    readonly mainOid: CollabGitOid;
    readonly memberId: CollabMemberId;
    readonly objectFormat: 'sha1' | 'sha256';
    readonly personalRef: string;
    readonly personalRefOid: CollabGitOid;
    readonly projectId: CollabProjectId;
  };
}

export interface CloudBootstrapReadinessInspector {
  inspect(
    projectId: CollabProjectId,
    memberId: CollabMemberId,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapReadinessObservation>;
}

export interface CollectCloudBootstrapReadinessInput {
  readonly manifest: DevelopmentBootstrapManifest;
  readonly memberId: CollabMemberId;
}

export interface CollectedCloudBootstrapReadiness {
  readonly clientReadiness: DevelopmentBootstrapClientReadiness;
  readonly observedPersonalRefOid: CollabGitOid;
}

function readinessError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class CloudBootstrapReadinessCollector {
  constructor(private readonly inspector: CloudBootstrapReadinessInspector) {}

  async collect(
    input: CollectCloudBootstrapReadinessInput,
    signal?: AbortSignal,
  ): Promise<CollectedCloudBootstrapReadiness> {
    throwIfCancelled(signal);
    const manifest = decodeDevelopmentBootstrapManifest(input.manifest);
    const member = manifest.comparison.members.find(candidate => (
      candidate.memberId === input.memberId
    ));
    if (!member) throw readinessError('cloud-bootstrap-member-not-in-manifest');
    const expectedPersonalRefOid = manifest.git.refs.find(candidate => (
      candidate.name === member.personalRef
    ))?.oid;
    if (!expectedPersonalRefOid) {
      throw readinessError('cloud-bootstrap-personal-ref-not-in-manifest');
    }

    const observation = await this.inspector.inspect(
      manifest.comparison.projectId,
      input.memberId,
      signal,
    );
    throwIfCancelled(signal);
    for (const operation of CLOUD_BOOTSTRAP_READINESS_OPERATIONS) {
      if (observation.operations[operation] !== 'settled') {
        throw readinessError(`cloud-bootstrap-${operation}-not-settled`);
      }
    }
    if (
      !nonNegativeInteger(observation.projectOperationQueue.activeCount)
      || !nonNegativeInteger(observation.projectOperationQueue.queuedCount)
      || observation.projectOperationQueue.activeCount !== 0
      || observation.projectOperationQueue.queuedCount !== 0
    ) {
      throw readinessError('cloud-bootstrap-project-operation-queue-not-drained');
    }
    if (observation.projectWorkSession !== 'closed') {
      throw readinessError('cloud-bootstrap-project-work-session-not-closed');
    }
    if (
      !nonNegativeInteger(observation.collabGitChildCount)
      || observation.collabGitChildCount !== 0
    ) {
      throw readinessError('cloud-bootstrap-git-children-not-drained');
    }
    if (Object.values(observation.preservedWork).some(value => typeof value !== 'boolean')) {
      throw readinessError('cloud-bootstrap-preserved-work-observation-invalid');
    }
    const repository = observation.repository;
    if (
      repository.projectId !== manifest.comparison.projectId
      || repository.memberId !== input.memberId
      || repository.personalRef !== member.personalRef
      || repository.personalRefOid !== expectedPersonalRefOid
      || repository.mainOid !== manifest.comparison.mainOid
      || repository.objectFormat !== manifest.git.objectFormat
    ) {
      throw readinessError('cloud-bootstrap-repository-identity-mismatch');
    }

    return Object.freeze({
      clientReadiness: Object.freeze({
        cleanupSettled: true,
        collabGitChildrenDrained: true,
        conflictRecoverySettled: true,
        hostTransferSettled: true,
        joinSettled: true,
        leaveSettled: true,
        managerResponsibilitySettled: true,
        projectOperationQueueDrained: true,
        projectSetupSettled: true,
        projectWorkSessionClosed: true,
        publishSettled: true,
        reconciliationSettled: true,
        reconnectSettled: true,
        repositoryIdentityExact: true,
        retirementSettled: true,
      }),
      observedPersonalRefOid: repository.personalRefOid,
    });
  }
}
