import type { ProviderSessionArchive, ProviderSessionArchiveChange } from '../../../core/providers/types';
import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import type { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import { CodexRPCResponseError } from '../runtime/CodexRPCTransport';
import { getCodexState } from '../types';

// The app-server reports a thread already in the requested state as a missing rollout.
const ALREADY_IN_STATE_MESSAGE = /^no (archived )?rollout found for thread id /;

/** Moves Codex rollouts between active and archived roots through the shared runtime. */
export class CodexThreadArchiveService implements ProviderSessionArchive {
  private readonly active = new Set<Promise<void>>();
  private readonly transitionGate = new CodexMetadataTransitionGate();

  constructor(private readonly runtime: CodexAppServerRuntime) {}

  async setSessionsArchived(changes: readonly ProviderSessionArchiveChange[]): Promise<void> {
    const requests = changes.flatMap(({ conversation, isArchived }) => {
      // A pending fork has no thread of its own; never target its source thread.
      const threadId = getCodexState(conversation.providerState).threadId ?? conversation.sessionId;
      return threadId ? [{ threadId, isArchived }] : [];
    });
    if (requests.length === 0) return;
    // Register in the same tick as the availability check so drains cannot miss admitted work.
    while (this.transitionGate.isUnavailable()) {
      if (!await this.transitionGate.waitUntilAvailable()) return;
    }

    const operation = this.#apply(requests);
    this.active.add(operation);
    try {
      await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  beginEnvironmentTransition(): void {
    this.transitionGate.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionGate.endTransition();
  }

  /** Lets admitted user operations finish against the environment they started in. */
  async quiesceForEnvironmentChange(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  async dispose(): Promise<void> {
    this.transitionGate.dispose();
    await this.quiesceForEnvironmentChange();
  }

  async #apply(requests: ReadonlyArray<{ threadId: string; isArchived: boolean }>): Promise<void> {
    const lease = await this.runtime.acquire({ readiness: 'initialized' });
    const { transport } = lease.connection;
    try {
      let firstFailure: Error | undefined;
      for (const { threadId, isArchived } of requests) {
        try {
          await transport.request(isArchived ? 'thread/archive' : 'thread/unarchive', { threadId });
        } catch (error) {
          if (error instanceof CodexRPCResponseError && ALREADY_IN_STATE_MESSAGE.test(error.message)) continue;
          firstFailure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstFailure) throw firstFailure;
    } finally {
      await lease.release();
    }
  }
}
