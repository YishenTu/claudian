import { type CollabProjectId } from '@claudian/collab-protocol';

import type {
  CollabHostTransferPort,
  CollabLifecycleRecoveryPort,
  CollabLocalExitPort,
  CollabRetirementPort,
} from '@/app/collab/CollabFeatureService';
import { type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabProjectLifecycleProjectionPort {
  closeProjectAdmission(projectId: CollabProjectId): void;
  refreshLifecycleProjection(): Promise<void>;
}

export interface CollabProjectLifecycleRecoveryStage {
  readonly name: string;
  run(options: CollabOperationOptions): Promise<void>;
}

export interface CollabProjectLifecycleSubsystemOptions {
  readonly closeRecovery: () => Promise<void> | void;
  readonly hostTransfer: CollabHostTransferPort;
  readonly localExit: CollabLocalExitPort;
  readonly recoveryStages: readonly CollabProjectLifecycleRecoveryStage[];
  readonly retirement: CollabRetirementPort;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({ code: 'cancelled' });
}

export class CollabProjectLifecycleSubsystem {
  readonly hostTransfer: CollabHostTransferPort;
  readonly lifecycleRecovery: CollabLifecycleRecoveryPort;
  readonly localExit: CollabLocalExitPort;
  readonly retirement: CollabRetirementPort;
  private projection: CollabProjectLifecycleProjectionPort | null = null;

  constructor(options: CollabProjectLifecycleSubsystemOptions) {
    this.hostTransfer = options.hostTransfer;
    this.localExit = options.localExit;
    this.retirement = options.retirement;
    this.lifecycleRecovery = {
      close: options.closeRecovery,
      resume: recoveryOptions => this.resume(options.recoveryStages, recoveryOptions),
    };
  }

  bindProjection(projection: CollabProjectLifecycleProjectionPort): void {
    if (this.projection) {
      throw new Error('Collab lifecycle projection is already bound');
    }
    this.projection = projection;
  }

  closeProjectAdmission(projectId: CollabProjectId): void {
    this.projection?.closeProjectAdmission(projectId);
  }

  refreshLifecycleProjection(): Promise<void> {
    return this.projection?.refreshLifecycleProjection() ?? Promise.resolve();
  }

  private async resume(
    stages: readonly CollabProjectLifecycleRecoveryStage[],
    options: CollabOperationOptions = {},
  ): Promise<void> {
    let firstError: unknown;
    for (const stage of stages) {
      throwIfCancelled(options.signal);
      await stage.run(options).catch(error => {
        firstError ??= error;
      });
    }
    throwIfCancelled(options.signal);
    if (firstError instanceof Error) throw firstError;
    if (firstError !== undefined) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'collab-lifecycle-recovery-incomplete' },
      });
    }
  }
}
