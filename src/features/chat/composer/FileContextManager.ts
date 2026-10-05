import type { TFile } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { formatComposerSessionMention } from '@/features/chat/composer/composerSessionMentions';
import { formatComposerWikilink } from '@/features/chat/composer/composerWikilinks';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';
import type { FolderMentionItem } from '@/shared/mention/types';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

/**
 * Owns composer mention selection over the shared view cache.
 * Linked content state and presentation belong to LinkedContentController.
 */
export class FileContextManager {
  private readonly mentionSource: MentionSource;

  /** The view-owned provider is required: the view registers and releases its vault listeners. */
  constructor(private readonly mentionDataProvider: VaultMentionDataProvider, sessions?: {
    getConversationList(): readonly ConversationMeta[];
    getCurrentConversationId(): string | null | undefined;
  }) {
    this.mentionSource = new MentionSource({
      getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
      getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
    }, {
      formatVaultFileMention: formatComposerWikilink,
      getSessionItems: sessions ? () => sessions.getConversationList()
        .filter(row => !row.isArchived && !row.isLegacySession && row.hasSessionReference !== false
          && row.id !== sessions.getCurrentConversationId())
        .map(row => ({
          id: `session:${row.id}`, kind: 'value' as const, label: row.title, icon: 'message-circle-more',
          replacement: formatComposerSessionMention(row.title, row.id),
          mtime: row.lastActivityAt,
        })) : undefined,
    });
  }

  getCachedVaultFiles(): readonly TFile[] {
    return this.mentionDataProvider.getCachedVaultFiles();
  }

  getCachedVaultFolders(): readonly FolderMentionItem[] {
    return this.mentionDataProvider.getCachedVaultFolders();
  }

  getMentionSource(): MentionSource {
    return this.mentionSource;
  }

  destroy(): void {
    this.mentionSource.destroy();
  }
}
