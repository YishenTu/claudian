import { type CollabProjectId } from '@claudian-collab/protocol';

import {
  type AuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type {
  CloudToLanTargetEntryRecord,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import {
  type AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  type CollabProjectLifecycleDurableOwner,
  type CollabProjectLifecycleRecoveryStage,
  type CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferRecoveryHandler {
  managerHandoffEstablished?(
    projectId: CollabProjectId,
  ): Promise<boolean>;
  prepare?(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
  resume(record: AuthorityTransferRecord, options: CollabOperationOptions): Promise<void>;
  resumeManager(projectId: CollabProjectId, options: CollabOperationOptions): Promise<void>;
  resumeTargetPreparation(
    entry: CloudToLanTargetEntryRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({ code: 'cancelled' });
}

export class AuthorityTransferRecovery implements CollabProjectLifecycleRecoveryStage {
  readonly name = 'authority-transfers';
  readonly durableOwner: CollabProjectLifecycleDurableOwner;
  private lifecycle: CollabProjectLifecycleSubsystem | null = null;

  constructor(
    private readonly persistence: AuthorityTransferPersistence,
    private readonly handler: AuthorityTransferRecoveryHandler,
    private readonly assertRecoveryOwner: (
      ownerInstallationKey: string,
      projectId: CollabProjectId,
    ) => Promise<void> | void,
  ) {
    this.durableOwner = Object.freeze({
      name: 'authority-transfer',
      inspect: (projectId: CollabProjectId) => this.inspect(projectId),
    });
  }

  register(lifecycle: CollabProjectLifecycleSubsystem): void {
    if (this.lifecycle) throw new Error('Authority transfer recovery is already registered');
    lifecycle.registerDurableOwner(this.durableOwner);
    lifecycle.registerRecoveryStage(this);
    this.lifecycle = lifecycle;
  }

  async run(options: CollabOperationOptions = {}): Promise<void> {
    if (!this.lifecycle) throw new Error('Authority transfer recovery is not registered');
    const catalog = await this.persistence.scanProjectCatalog();
    let firstError: unknown = catalog.invalidEntryCount > 0
      ? new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['open-diagnostics'],
        safeContext: { reason: 'authority-transfer-catalog-invalid' },
      })
      : undefined;
    for (const projectId of catalog.projectIds) {
      throwIfCancelled(options.signal);
      await this.lifecycle.runAuthorityTransferRecovery(
        projectId,
        async () => {
          await this.handler.resumeManager(projectId, options);
          let ownerState = await this.persistence.inspectLifecycleOwner(projectId);
          if (ownerState === 'absent' || ownerState === 'terminal') return;
          const ownerRecord = await this.persistence.loadRecoveryOwnerRecord(projectId);
          if (!ownerRecord) {
            const targetEntry = await this.persistence.loadCloudToLanTargetEntry(projectId);
            if (
              !targetEntry
              || (targetEntry.phase !== 'preparing' && targetEntry.phase !== 'published')
            ) return;
            await this.assertRecoveryOwner(targetEntry.ownerInstallationKey, projectId);
            await this.handler.resumeTargetPreparation(targetEntry, options);
            return;
          }
          await this.assertRecoveryOwner(ownerRecord.ownerInstallationKey, projectId);
          await this.persistence.recoverInterruptedClaimCommitment(projectId);
          ownerState = await this.persistence.inspectLifecycleOwner(projectId);
          if (ownerState === 'absent' || ownerState === 'terminal') {
            return;
          }
          const record = await this.persistence.load(projectId);
          if (!record) return;
          if (ownerState === 'proposal') {
            await this.handler.prepare?.(record, options);
            return;
          }
          await this.handler.resume(record, options);
        },
      ).catch(error => {
        firstError ??= error;
      });
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError !== undefined) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'authority-transfer-recovery-incomplete' },
      });
    }
  }

  private async inspect(
    projectId: CollabProjectId,
  ): Promise<'absent' | 'nonterminal' | 'proposal' | 'terminal'> {
    const state = await this.persistence.inspectLifecycleOwner(projectId);
    if (
      state === 'nonterminal'
      && await this.handler.managerHandoffEstablished?.(projectId)
    ) return 'terminal';
    return state;
  }
}
