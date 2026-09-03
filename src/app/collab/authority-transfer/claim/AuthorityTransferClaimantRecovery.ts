import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  AuthorityTransferClaimantRecord,
  AuthorityTransferClaimantStore,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type {
  CollabProjectLifecycleDurableOwner,
  CollabProjectLifecycleRecoveryStage,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferClaimantRecoveryHandler {
  beforeProject(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<'skip' | void>;
  complete(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
  isLocalOwner?(
    record: AuthorityTransferClaimantRecord,
  ): Promise<boolean>;
  resume(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

function assertNotCancelled(options: CollabOperationOptions): void {
  if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

export function authorityTransferClaimantRequiresSource(
  record: AuthorityTransferClaimantRecord,
  now: Date,
): boolean {
  if (record.variant === 'manager-reissued') return false;
  if (
    record.phase === 'prepared'
    || record.phase === 'claim-retained'
    || record.phase === 'credential-persisted'
  ) return true;
  return record.phase === 'target-claimed'
    && now.getTime() < Date.parse(record.status.expiresAt);
}

export function authorityTransferClaimantRequiresNoRuntime(
  record: AuthorityTransferClaimantRecord,
  now: Date,
): boolean {
  if (record.phase === 'completed' || record.phase === 'membership-converged') return true;
  if (record.variant === 'manager-reissued') return false;
  if (now.getTime() < Date.parse(record.status.expiresAt)) return false;
  return record.phase === 'prepared'
    || record.phase === 'claim-retained'
    || record.phase === 'credential-persisted';
}

export class AuthorityTransferClaimantRecovery
implements CollabProjectLifecycleRecoveryStage {
  readonly durableOwner: CollabProjectLifecycleDurableOwner;
  readonly name = 'authority-transfer-claimants';
  private lifecycle: CollabProjectLifecycleSubsystem | null = null;

  constructor(
    private readonly store: AuthorityTransferClaimantStore,
    private readonly handler: AuthorityTransferClaimantRecoveryHandler,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.durableOwner = Object.freeze({
      inspect: (projectId: CollabProjectId) => this.inspect(projectId),
      name: 'authority-transfer-claimant',
    });
  }

  register(lifecycle: CollabProjectLifecycleSubsystem): void {
    if (this.lifecycle) throw new Error('Claimant recovery is already registered');
    lifecycle.registerDurableOwner(this.durableOwner);
    lifecycle.registerRecoveryStage(this);
    this.lifecycle = lifecycle;
  }

  async run(options: CollabOperationOptions = {}): Promise<void> {
    if (!this.lifecycle) throw new Error('Claimant recovery is not registered');
    let firstError: unknown;
    for (const projectId of await this.store.listProjectIds()) {
      assertNotCancelled(options);
      await this.lifecycle.runExclusive(
        projectId,
        this.durableOwner.name,
        'recovery',
        async () => {
          const record = await this.store.load(projectId);
          if (!record) return;
          if (await this.handler.beforeProject(record, options) === 'skip') return;
          if (authorityTransferClaimantRequiresNoRuntime(record, this.now())) {
            await this.handler.complete(record, options);
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
        safeContext: { reason: 'authority-transfer-claimant-recovery-incomplete' },
      });
    }
  }

  private async inspect(
    projectId: CollabProjectId,
  ): Promise<'absent' | 'nonterminal' | 'terminal'> {
    const record = await this.store.load(projectId);
    if (!record) return 'absent';
    if (record.phase === 'completed' || record.phase === 'membership-converged') {
      return 'terminal';
    }
    return await this.handler.isLocalOwner?.(record) === false
      ? 'terminal'
      : 'nonterminal';
  }
}
