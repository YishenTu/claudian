import type { CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

import {
  type PreparedProjectRetirement,
  ProjectRetirementRepository,
} from '@/app/collab/authority/ProjectRetirementRepository';
import type { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import type { RetirementTombstoneRecord } from '@/app/collab/retirement/RetirementTombstoneRecord';
import type { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';
import type { CollabRetirementResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ProjectRetirementAuthorityRequest {
  readonly expectedHostMemberId: CollabMemberId;
  readonly idempotencyKey: string;
  readonly managerActorMemberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly requestFingerprint: string;
}

export interface ProjectRetirementAuthorityServiceOptions {
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly onAuthorityCommitted?: () => void;
  readonly onTombstoneCommitted?: () => void;
}

function retirementError(reason: string, cause?: unknown): CollabError {
  return new CollabError({
    cause,
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export class ProjectRetirementAuthorityService {
  private readonly now: () => Date;
  private readonly onAuthorityCommitted?: () => void;
  private readonly onTombstoneCommitted?: () => void;
  private readonly repository = new ProjectRetirementRepository();

  constructor(
    private readonly database: SqlJsProjectDatabase,
    private readonly tombstones: RetirementTombstoneRepository,
    private readonly options: ProjectRetirementAuthorityServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.onAuthorityCommitted = options.onAuthorityCommitted;
    this.onTombstoneCommitted = options.onTombstoneCommitted;
  }

  async retire(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<CollabRetirementResult> {
    const prepared = (await this.database.mutate(connection => this.repository.prepare(
      connection,
      {
        ...request,
        actorMemberId,
        updatedAt: this.now().toISOString(),
      },
    ))).value;
    if (prepared.phase === 'tombstone-committed') {
      if (prepared.retiredAt === null) throw retirementError('retirement-result-missing');
      return { projectId: prepared.projectId, retiredAt: prepared.retiredAt };
    }

    const existingTombstone = await this.tombstones.load(prepared.projectId);
    const retiredAt = existingTombstone?.retiredAt ?? this.now().toISOString();
    const tombstone = existingTombstone ?? this.createTombstone(prepared, retiredAt);
    try {
      await this.tombstones.savePrepared(tombstone);
      this.onTombstoneCommitted?.();
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw retirementError('retirement-tombstone-write-failed', error);
    }

    const committed = (await this.database.mutate(connection => this.repository.commit(
      connection,
      prepared.operationId,
      retiredAt,
    ))).value;
    this.onAuthorityCommitted?.();
    if (committed.retiredAt === null) throw retirementError('retirement-result-missing');
    return { projectId: committed.projectId, retiredAt: committed.retiredAt };
  }

  async inspectDurableResult(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<{
    readonly matchesRequest: boolean;
    readonly result: CollabRetirementResult;
  } | null> {
    const tombstone = await this.tombstones.load(request.projectId);
    if (!tombstone) return null;
    return {
      matchesRequest: tombstone.replay.actorMemberId === actorMemberId
        && tombstone.replay.idempotencyKey === request.idempotencyKey
        && tombstone.replay.requestFingerprint === request.requestFingerprint,
      result: tombstone.result,
    };
  }

  private createTombstone(
    prepared: PreparedProjectRetirement,
    retiredAt: string,
  ): RetirementTombstoneRecord {
    const expiresAt = new Date(Date.parse(retiredAt) + RETENTION_MS).toISOString();
    return {
      expiresAt,
      formerMembers: prepared.formerMembers.map(member => ({
        acknowledgedAt: null,
        ...member,
      })),
      hostTransitionProofs: prepared.hostTransitionProofs,
      kind: 'retirement-tombstone',
      ownerInstallationKey: this.options.installationKey,
      projectId: prepared.projectId,
      replay: {
        actorMemberId: prepared.actorMemberId,
        idempotencyKey: prepared.idempotencyKey,
        requestFingerprint: prepared.requestFingerprint,
      },
      result: { projectId: prepared.projectId, retiredAt },
      retiredAt,
      schemaVersion: 2,
    };
  }
}
