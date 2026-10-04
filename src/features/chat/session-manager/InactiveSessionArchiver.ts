import { Notice } from 'obsidian';

import type { ConversationMeta, SessionAutoArchiveAfter } from '../../../core/types';
import type { ChatFeatureHost } from '../ChatFeatureHost';

const DAY_MS = 86_400_000;
const AUTO_ARCHIVE_AFTER_DAYS: Record<SessionAutoArchiveAfter, number | null> = {
  off: null,
  '7d': 7,
  '14d': 14,
  '30d': 30,
};

type InactiveSessionArchiverHost = Pick<
  ChatFeatureHost,
  'settings' | 'getConversationList' | 'getWorkspaceConversationIds'
> & {
  readonly conversationLifecycle: Pick<ChatFeatureHost['conversationLifecycle'], 'archiveIf'>;
};

/** Archives unpinned sessions that have been inactive past the configured threshold. */
export class InactiveSessionArchiver {
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly host: InactiveSessionArchiverHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts a run from a trigger that cannot await it; failures surface as a notice. */
  request(): void {
    if (this.disposed) return;
    void this.run().catch(() => {
      new Notice('Failed to auto-archive inactive sessions');
    });
  }

  /** Stops accepting triggers; a run already admitted finishes on its own. */
  dispose(): void {
    this.disposed = true;
  }

  /** Serialized so overlapping triggers never archive from a stale list. */
  run(): Promise<void> {
    const next = this.tail.then(() => this.archiveInactive());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async archiveInactive(): Promise<void> {
    const after = this.host.settings.sessionAutoArchiveAfter ?? 'off';
    const days = AUTO_ARCHIVE_AFTER_DAYS[after] ?? null;
    if (days === null) return;

    const cutoff = this.now().getTime() - days * DAY_MS;
    const isEligible = (
      conversation: Readonly<Pick<ConversationMeta, 'id' | 'isPinned' | 'lastActivityAt'>>,
      openIds: ReadonlySet<string>,
    ): boolean => (
      !conversation.isPinned
      && conversation.lastActivityAt < cutoff
      && !openIds.has(conversation.id)
    );
    const openIds = this.host.getWorkspaceConversationIds();
    const candidateIds = this.host.getConversationList()
      .filter(conversation => !conversation.isArchived && isEligible(conversation, openIds))
      .map(conversation => conversation.id);
    if (candidateIds.length === 0) return;

    // Eligibility is rechecked at each write so pending pins or newly opened tabs win.
    const archivedCount = await this.host.conversationLifecycle.archiveIf(
      candidateIds,
      conversation => isEligible(conversation, this.host.getWorkspaceConversationIds()),
    );
    if (archivedCount === 0) return;
    new Notice(`Auto-archived ${archivedCount} inactive ${archivedCount === 1 ? 'session' : 'sessions'}`);
  }
}
