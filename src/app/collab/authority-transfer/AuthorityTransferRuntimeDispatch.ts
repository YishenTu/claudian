import { type CollabProjectId } from '@claudian-collab/protocol';

import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
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
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferDirectionRuntime | null>;
}

function runtimeError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/** Dispatches recovery through the module that owns exact operation bindings. */
export class AuthorityTransferRuntimeDispatch {
  constructor(private readonly resolver: AuthorityTransferRuntimeResolver) {}

  async resume(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    const runtime = await this.requireRuntime(record, options);
    await runtime.resume(record.projectId, options);
  }

  async prepare(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    await this.requireRuntime(record, options);
  }

  private async requireRuntime(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferDirectionRuntime> {
    const runtime = await this.resolver.resolve(record, options);
    if (!runtime) throw runtimeError('authority-transfer-runtime-not-bound');
    return runtime;
  }
}
