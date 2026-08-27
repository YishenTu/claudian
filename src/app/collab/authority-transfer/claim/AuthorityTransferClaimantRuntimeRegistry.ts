import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferClaimantRuntime {
  resume(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<void>;
}

export interface AuthorityTransferClaimantRuntimeResolution {
  dispose(): Promise<void> | void;
  readonly runtime: AuthorityTransferClaimantRuntime;
}

export interface AuthorityTransferClaimantRuntimeResolver {
  resolve(
    record: AuthorityTransferClaimantRecord,
  ): Promise<AuthorityTransferClaimantRuntimeResolution | null>;
}

function runtimeError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/** Resolves restart-safe claimant transports from the durable local record. */
export class AuthorityTransferClaimantRuntimeRegistry {
  private readonly runtimes = new Map<CollabProjectId, AuthorityTransferClaimantRuntime>();

  constructor(private readonly resolver: AuthorityTransferClaimantRuntimeResolver) {}

  register(projectId: CollabProjectId, runtime: AuthorityTransferClaimantRuntime): () => void {
    const existing = this.runtimes.get(projectId);
    if (existing && existing !== runtime) {
      throw runtimeError('authority-transfer-claimant-runtime-conflict');
    }
    this.runtimes.set(projectId, runtime);
    return () => {
      if (this.runtimes.get(projectId) === runtime) this.runtimes.delete(projectId);
    };
  }

  async resume(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    const runtime = this.runtimes.get(record.projectId);
    if (runtime) {
      await runtime.resume(record.projectId, options);
      return;
    }
    const resolved = await this.resolver.resolve(record);
    if (!resolved) throw runtimeError('authority-transfer-claimant-runtime-not-bound');
    try {
      await resolved.runtime.resume(record.projectId, options);
    } finally {
      await resolved.dispose();
    }
  }
}
