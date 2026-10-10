import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderSessionArchive, ProviderSessionArchiveChange } from '@/core/providers/types';

import { DeepSeekRemoteError } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { decodeDeepSeekState } from '../types';

/** Mirrors Claudian archive state onto the native registry-global archive set through the shared Host. */
export class DeepSeekSessionArchiveService implements ProviderSessionArchive {
  private readonly active = new Set<Promise<void>>();
  private readonly fence = new ProviderTransitionFence();

  constructor(private readonly deepseek: DeepSeekHost) {}

  async setSessionsArchived(changes: readonly ProviderSessionArchiveChange[]): Promise<void> {
    // A pending fork has no native session of its own; never target its source.
    const requests = changes.flatMap(({ conversation, isArchived }) => conversation.sessionId ? [{ sessionId: conversation.sessionId, isArchived, home: decodeDeepSeekState(conversation.providerState)?.home }] : []);
    if (requests.length === 0 || !await this.fence.waitUntilAvailable()) return;
    // Registered in the same tick as the availability check so transitions cannot miss admitted work.
    const operation = this.apply(requests);
    this.active.add(operation);
    try { await operation; } finally { this.active.delete(operation); }
  }

  /** Lets admitted operations finish against the process they started on before it stops. */
  async beginTransition(): Promise<void> {
    this.fence.beginTransition();
    await Promise.allSettled([...this.active]);
  }

  endTransition(): void { this.fence.endTransition(); }

  async dispose(): Promise<void> {
    this.fence.dispose();
    await Promise.allSettled([...this.active]);
  }

  private async apply(requests: ReadonlyArray<{ sessionId: string; isArchived: boolean; home?: string }>): Promise<void> {
    const lease = await this.deepseek.attach();
    try {
      let firstFailure: Error | undefined;
      for (const { sessionId, isArchived, home } of requests) {
        // Another store's session id cannot name a session in this Host's store.
        if (home && home !== lease.home) continue;
        try {
          // Claudian archives only closed sessions, so leftover native work is stopped rather than refusing the archive.
          if (isArchived) await lease.client.call('workspace/archiveSession', { request: { sessionId, stopActivity: true } });
          else await lease.client.call('workspace/unarchiveSession', { request: { sessionId } });
        } catch (error) {
          // Unarchive is idempotent natively; archive reports a session the store no longer holds.
          if (error instanceof DeepSeekRemoteError && error.code === 'session/not-found') continue;
          firstFailure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstFailure) throw firstFailure;
    } finally {
      lease.release();
    }
  }
}
