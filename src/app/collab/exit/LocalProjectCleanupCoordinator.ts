import { randomBytes } from 'node:crypto';

import { type CollabIsoTimestamp, type CollabMemberId, collabMemberRef, type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { DetachedProjectMarker } from '@/app/collab/exit/DetachedProjectMarker';
import {
  decodeLocalCleanupRecord,
  type LocalCleanupPhase,
  type LocalCleanupPurpose,
  type LocalCleanupRecord,
} from '@/app/collab/exit/LocalCleanupRecord';
import type { GitLocalRepositoryIdentity } from '@/app/collab/git/GitRepositoryService';
import { type CollabLocalCleanupChoice } from '@/core/collab';

export interface LocalCleanupRecordPort {
  load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
  save(record: LocalCleanupRecord): Promise<void>;
  remove(projectId: CollabProjectId): Promise<boolean>;
}

export interface LocalCleanupGitIdentityPort {
  assertLocalRepositoryIdentity(
    repositoryPath: string,
    expected: GitLocalRepositoryIdentity,
  ): Promise<void>;
}

export interface LocalProjectCleanupIntent {
  readonly choice: CollabLocalCleanupChoice;
  readonly markerNonce?: string;
  readonly memberId: CollabMemberId;
  readonly operationId: CollabOperationId;
  readonly personalRef: string;
  readonly projectId: CollabProjectId;
  readonly purpose: LocalCleanupPurpose;
  readonly workspacePath: string;
}

export interface RetiredCleanupChoiceIntent {
  readonly choice: CollabLocalCleanupChoice;
  readonly projectId: CollabProjectId;
}

export interface LocalCleanupProgress {
  readonly phase: LocalCleanupPhase;
  readonly projectId: CollabProjectId;
}

export type LocalCleanupResult =
  | { readonly status: 'cancelled'; readonly phase: LocalCleanupPhase }
  | {
    readonly status: 'complete';
    readonly filesPreserved: boolean;
    readonly gitDataRemoved: true;
    readonly markerRetained: boolean;
  };

export interface LocalProjectCleanupPort {
  cleanup(
    intent: LocalProjectCleanupIntent,
    options?: LocalCleanupRunOptions,
  ): Promise<LocalCleanupResult>;
  resume(projectId: CollabProjectId, options?: LocalCleanupRunOptions): Promise<LocalCleanupResult>;
  finalizeRetiredChoice(
    intent: RetiredCleanupChoiceIntent,
    options?: LocalCleanupRunOptions,
  ): Promise<LocalCleanupResult>;
  completeRetiredFinalization(projectId: CollabProjectId): Promise<void>;
}

export interface LocalCleanupRunOptions {
  readonly onProgress?: (progress: LocalCleanupProgress) => void;
  readonly signal?: AbortSignal;
}

export interface LocalProjectCleanupCoordinatorOptions {
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

export class LocalProjectCleanupCoordinator implements LocalProjectCleanupPort {
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(
    private readonly workspace: CollabWorkspaceService,
    private readonly git: LocalCleanupGitIdentityPort,
    private readonly records: LocalCleanupRecordPort,
    options: LocalProjectCleanupCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(32).toString('base64url'));
  }

  async cleanup(
    intent: LocalProjectCleanupIntent,
    options: LocalCleanupRunOptions = {},
  ): Promise<LocalCleanupResult> {
    if (intent.personalRef !== collabMemberRef(intent.memberId)) {
      throw new TypeError('Local cleanup personal ref does not match the Member');
    }
    if (intent.purpose === 'retire' && intent.choice !== 'keep-files') {
      throw new TypeError('Automatic Retire cleanup must preserve visible files');
    }
    const existing = await this.records.load(intent.projectId);
    if (existing) {
      this.assertSameIntent(existing, intent);
      return this.run(existing, options);
    }
    const timestamp = this.timestamp();
    const record = decodeLocalCleanupRecord({
      choice: intent.choice,
      createdAt: timestamp,
      kind: 'local-cleanup',
      markerNonce: intent.markerNonce ?? this.nonce(),
      memberId: intent.memberId,
      operationId: intent.operationId,
      phase: 'planned',
      projectId: intent.projectId,
      purpose: intent.purpose,
      schemaVersion: 1,
      updatedAt: timestamp,
      workspacePath: intent.workspacePath,
    });
    await this.records.save(record);
    return this.run(record, options);
  }

  async resume(
    projectId: CollabProjectId,
    options: LocalCleanupRunOptions = {},
  ): Promise<LocalCleanupResult> {
    const record = await this.records.load(projectId);
    if (!record) throw new TypeError('No local cleanup record');
    return this.run(record, options);
  }

  async finalizeRetiredChoice(
    intent: RetiredCleanupChoiceIntent,
    options: LocalCleanupRunOptions = {},
  ): Promise<LocalCleanupResult> {
    let record = await this.records.load(intent.projectId);
    if (
      !record
      || record.purpose !== 'retire'
      || (
        record.phase !== 'complete'
        && record.phase !== 'marker-removing'
        && record.phase !== 'choice-applied'
      )
    ) {
      throw new TypeError('Retired cleanup is not ready for a local choice');
    }
    if (record.phase === 'choice-applied') {
      if (intent.choice !== record.choice) {
        throw new TypeError('Retired cleanup choice does not match durable state');
      }
      return this.completeResult(record);
    }
    if (record.phase === 'marker-removing') {
      if (intent.choice !== 'keep-files' || record.choice !== 'keep-files') {
        throw new TypeError('Retired cleanup choice does not match durable state');
      }
      return this.run(record, options);
    }
    if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
    const marker = this.marker(record);
    await this.workspace.assertDetachedProjectMarker(
      record.workspacePath,
      record.operationId,
      marker,
    );
    if (intent.choice === 'keep-files') {
      record = await this.transition(record, 'marker-removing', options);
      return this.run(record, options);
    }
    record = await this.transition(
      decodeLocalCleanupRecord({ ...record, choice: 'delete-files' }),
      'deleting',
      options,
    );
    if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
    await this.workspace.detachProjectRoot(record.workspacePath, record.operationId);
    await this.workspace.removeDetachedProjectRoot(
      record.workspacePath,
      record.operationId,
      this.marker(record),
    );
    await this.transition(record, 'choice-applied', options);
    return { filesPreserved: false, gitDataRemoved: true, markerRetained: false, status: 'complete' };
  }

  async completeRetiredFinalization(projectId: CollabProjectId): Promise<void> {
    const record = await this.records.load(projectId);
    if (!record || record.purpose !== 'retire' || record.phase !== 'choice-applied') {
      throw new TypeError('Retired cleanup finalization is not complete');
    }
    await this.records.remove(projectId);
  }

  private async run(
    initial: LocalCleanupRecord,
    options: LocalCleanupRunOptions,
  ): Promise<LocalCleanupResult> {
    let record = initial;
    if (record.phase === 'complete') return this.completeResult(record);
    if (record.phase === 'failed') throw new TypeError('Local cleanup requires explicit recovery');
    if (record.phase === 'planned') {
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      const projectPath = await this.workspace.resolveManagedProjectPath(record.workspacePath);
      await this.git.assertLocalRepositoryIdentity(projectPath, {
        memberId: record.memberId,
        personalRef: collabMemberRef(record.memberId),
        projectId: record.projectId,
      });
      await this.workspace.createDetachedProjectMarker(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      record = await this.transition(record, 'marked', options);
    }
    if (record.phase === 'marked') {
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      const projectPath = await this.workspace.resolveManagedProjectPath(record.workspacePath);
      await this.git.assertLocalRepositoryIdentity(projectPath, {
        memberId: record.memberId,
        personalRef: collabMemberRef(record.memberId),
        projectId: record.projectId,
      });
      if (record.choice === 'delete-files' && record.purpose === 'leave') {
        record = await this.transition(record, 'deleting', options);
        await this.workspace.detachProjectRoot(record.workspacePath, record.operationId);
      } else {
        record = await this.transition(record, 'git-detaching', options);
      }
    }
    if (record.phase === 'git-detaching') {
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      await this.workspace.assertDetachedProjectMarker(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      if (!await this.workspace.isProjectGitDetached(record.workspacePath, record.operationId)) {
        const projectPath = await this.workspace.resolveManagedProjectPath(record.workspacePath);
        await this.git.assertLocalRepositoryIdentity(projectPath, {
          memberId: record.memberId,
          personalRef: collabMemberRef(record.memberId),
          projectId: record.projectId,
        });
      }
      await this.workspace.detachProjectGit(record.workspacePath, record.operationId);
      record = await this.transition(record, 'detached', options);
    }
    if (record.phase === 'detached') {
      await this.workspace.assertDetachedProjectMarker(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      await this.workspace.removeDetachedProjectGit(record.workspacePath, record.operationId);
      if (record.purpose === 'leave') {
        record = await this.transition(record, 'marker-removing', options);
      } else {
        record = await this.transition(record, 'complete', options);
      }
    }
    if (record.phase === 'marker-removing') {
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      await this.workspace.removeDetachedProjectMarker(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      if (record.purpose === 'retire') {
        await this.transition(record, 'choice-applied', options);
        options.onProgress?.({ phase: 'complete', projectId: record.projectId });
        return {
          filesPreserved: true,
          gitDataRemoved: true,
          markerRetained: false,
          status: 'complete',
        };
      }
      record = await this.transition(record, 'complete', options);
    }
    if (record.phase === 'deleting') {
      if (this.cancelled(options, record.phase)) return { status: 'cancelled', phase: record.phase };
      if (await this.workspace.isProjectRootRemoved(
        record.workspacePath,
        record.operationId,
      )) {
        if (record.purpose === 'retire') {
          await this.transition(record, 'choice-applied', options);
          options.onProgress?.({ phase: 'complete', projectId: record.projectId });
          return this.completeResult(record);
        }
        record = await this.transition(record, 'complete', options);
        return this.completeResult(record);
      }
      await this.workspace.assertDetachedProjectMarker(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      await this.workspace.detachProjectRoot(record.workspacePath, record.operationId);
      await this.workspace.removeDetachedProjectRoot(
        record.workspacePath,
        record.operationId,
        this.marker(record),
      );
      if (record.purpose === 'retire') {
        await this.transition(record, 'choice-applied', options);
        options.onProgress?.({ phase: 'complete', projectId: record.projectId });
        return this.completeResult(record);
      }
      record = await this.transition(record, 'complete', options);
    }
    return this.completeResult(record);
  }

  private marker(record: LocalCleanupRecord): DetachedProjectMarker {
    return {
      cleanupOperationId: record.operationId,
      createdAt: record.createdAt,
      memberId: record.memberId,
      nonce: record.markerNonce,
      projectId: record.projectId,
      purpose: record.purpose,
      schemaVersion: 1,
    };
  }

  private async transition(
    record: LocalCleanupRecord,
    phase: LocalCleanupPhase,
    options: LocalCleanupRunOptions,
  ): Promise<LocalCleanupRecord> {
    const updated = decodeLocalCleanupRecord({ ...record, phase, updatedAt: this.timestamp() });
    await this.records.save(updated);
    options.onProgress?.({ phase, projectId: record.projectId });
    return updated;
  }

  private cancelled(options: LocalCleanupRunOptions, phase: LocalCleanupPhase): boolean {
    return options.signal?.aborted === true;
  }

  private completeResult(record: LocalCleanupRecord): LocalCleanupResult {
    const filesPreserved = record.choice === 'keep-files';
    return {
      filesPreserved,
      gitDataRemoved: true,
      markerRetained: record.purpose === 'retire' && filesPreserved,
      status: 'complete',
    };
  }

  private timestamp(): CollabIsoTimestamp {
    return this.now().toISOString();
  }

  private assertSameIntent(record: LocalCleanupRecord, intent: LocalProjectCleanupIntent): void {
    if (
      record.choice !== intent.choice
      || record.memberId !== intent.memberId
      || record.operationId !== intent.operationId
      || record.projectId !== intent.projectId
      || record.purpose !== intent.purpose
      || record.workspacePath !== intent.workspacePath
      || intent.personalRef !== collabMemberRef(intent.memberId)
    ) throw new TypeError('Local cleanup intent does not match durable state');
  }
}
