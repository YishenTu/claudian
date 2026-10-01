import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderHistoryInput, ProviderSessionArchive } from '../../../core/providers/types';
import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import { CodexAppServerProcess } from '../runtime/CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from '../runtime/codexAppServerSupport';
import { CodexRPCResponseError, CodexRPCTransport } from '../runtime/CodexRPCTransport';
import { getCodexState } from '../types';

// The app-server reports a thread already in the requested state as a missing rollout.
const ALREADY_IN_STATE_MESSAGE = /^no (archived )?rollout found for thread id /;

/** Moves Codex rollouts between active and archived roots through a short-lived app-server. */
export class CodexThreadArchiveService implements ProviderSessionArchive {
  private readonly active = new Set<Promise<void>>();
  private readonly transitionGate = new CodexMetadataTransitionGate();

  constructor(private readonly plugin: ProviderHost) {}

  async setSessionArchived(conversation: ProviderHistoryInput, isArchived: boolean): Promise<void> {
    // A pending fork has no thread of its own; never target its source thread.
    const threadId = getCodexState(conversation.providerState).threadId ?? conversation.sessionId;
    if (!threadId) return;
    // Register in the same tick as the availability check so drains cannot miss admitted work.
    while (this.transitionGate.isUnavailable()) {
      if (!await this.transitionGate.waitUntilAvailable()) return;
    }

    const operation = this.#request(isArchived ? 'thread/archive' : 'thread/unarchive', threadId);
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

  async #request(method: 'thread/archive' | 'thread/unarchive', threadId: string): Promise<void> {
    const launchSpec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
    const process = new CodexAppServerProcess(launchSpec);
    process.start();
    const transport = new CodexRPCTransport(process);
    transport.start();
    try {
      await initializeCodexAppServerTransport(transport);
      await transport.request(method, { threadId });
    } catch (error) {
      if (!(error instanceof CodexRPCResponseError && ALREADY_IN_STATE_MESSAGE.test(error.message))) {
        throw error;
      }
    } finally {
      transport.dispose();
      await process.shutdown();
    }
  }
}
