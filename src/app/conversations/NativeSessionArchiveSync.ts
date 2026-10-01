import type {
  ProviderId,
  ProviderSessionArchive,
  ProviderSessionArchiveChange,
} from '../../core/providers/types';
import type { Conversation } from '../../core/types';

export interface NativeSessionArchiveSyncDeps {
  getConversation(id: string): Conversation | null;
  /** Null when the provider has no native archive; may initialize provider services. */
  getSessionArchive(providerId: ProviderId): Promise<ProviderSessionArchive | null>;
  onFailure(providerId: ProviderId, error: unknown): void;
}

/**
 * Mirrors committed application archive state onto provider-native sessions.
 * Batches run one at a time and read the latest committed state, so native results cannot
 * finish out of commit order. Failures are reported without rolling back application state.
 */
export class NativeSessionArchiveSync {
  private readonly pending = new Set<string>();
  private draining: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: NativeSessionArchiveSyncDeps) {}

  /** Resolves once these sessions, and any queued alongside them, have been mirrored. */
  sync(ids: Iterable<string>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    for (const id of ids) this.pending.add(id);
    if (this.pending.size > 0) this.draining ??= this.#drain();
    return this.draining ?? Promise.resolve();
  }

  /** Stops admission and finishes already admitted work before provider services shut down. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.draining;
  }

  async #drain(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const ids = [...this.pending];
        this.pending.clear();
        const changesByProvider = new Map<ProviderId, ProviderSessionArchiveChange[]>();
        for (const id of ids) {
          const conversation = this.deps.getConversation(id);
          if (!conversation) continue;
          const changes = changesByProvider.get(conversation.providerId) ?? [];
          changes.push({ conversation, isArchived: conversation.isArchived === true });
          changesByProvider.set(conversation.providerId, changes);
        }
        await Promise.all([...changesByProvider].map(
          ([providerId, changes]) => this.#apply(providerId, changes),
        ));
      }
    } finally {
      // Cleared in the same tick as the empty check so a later sync() starts a new drain.
      this.draining = null;
    }
  }

  async #apply(providerId: ProviderId, changes: ProviderSessionArchiveChange[]): Promise<void> {
    try {
      const archive = await this.deps.getSessionArchive(providerId);
      await archive?.setSessionsArchived(changes);
    } catch (error) {
      this.deps.onFailure(providerId, error);
    }
  }
}
