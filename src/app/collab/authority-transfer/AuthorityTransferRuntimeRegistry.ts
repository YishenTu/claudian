import { type CollabProjectId } from '@claudian-collab/protocol';

import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type { AuthorityTransferRecoveryHandler } from '@/app/collab/authority-transfer/recovery/AuthorityTransferRecovery';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferDirectionRuntime {
  resume(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<unknown>;
}

export interface AuthorityTransferRuntimeResolver {
  resolve(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferDirectionRuntime | null>;
}

interface RegisteredRuntime {
  readonly localRole: AuthorityTransferRecord['localRole'];
  readonly runtime: AuthorityTransferDirectionRuntime;
}

function runtimeError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/**
 * Holds only live operation adapters. Durable ownership remains in the
 * Project-local transfer record and the existing lifecycle recovery catalog.
 */
export class AuthorityTransferRuntimeRegistry implements AuthorityTransferRecoveryHandler {
  private readonly runtimes = new Map<CollabProjectId, RegisteredRuntime>();

  constructor(private readonly resolver?: AuthorityTransferRuntimeResolver) {}

  register(
    projectId: CollabProjectId,
    localRole: AuthorityTransferRecord['localRole'],
    runtime: AuthorityTransferDirectionRuntime,
  ): () => void {
    const existing = this.runtimes.get(projectId);
    if (existing && (existing.localRole !== localRole || existing.runtime !== runtime)) {
      throw runtimeError('authority-transfer-runtime-conflict');
    }
    const registered = existing ?? { localRole, runtime };
    this.runtimes.set(projectId, registered);
    return () => {
      if (this.runtimes.get(projectId) === registered) this.runtimes.delete(projectId);
    };
  }

  async resume(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.prepare(record);
    const registered = this.runtimes.get(record.projectId);
    if (!registered || registered.localRole !== record.localRole) {
      throw runtimeError('authority-transfer-runtime-not-bound');
    }
    await registered.runtime.resume(record.projectId, options);
  }

  async prepare(record: AuthorityTransferRecord): Promise<void> {
    const existing = this.runtimes.get(record.projectId);
    if (existing) {
      if (existing.localRole !== record.localRole) {
        throw runtimeError('authority-transfer-runtime-conflict');
      }
      return;
    }
    const runtime = await this.resolver?.resolve(record);
    if (!runtime) throw runtimeError('authority-transfer-runtime-not-bound');
    const registered = this.runtimes.get(record.projectId);
    if (registered) {
      if (registered.localRole !== record.localRole || registered.runtime !== runtime) {
        throw runtimeError('authority-transfer-runtime-conflict');
      }
      return;
    }
    this.runtimes.set(record.projectId, { localRole: record.localRole, runtime });
  }
}
