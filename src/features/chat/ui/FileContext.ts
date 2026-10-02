import type { App, TFile } from 'obsidian';

import type { ConversationMeta } from '@/core/types';

import { MentionSource } from '../../../shared/composer-dropdown/MentionSource';
import type { FolderMentionItem } from '../../../shared/mention/types';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import { formatComposerSessionMention } from '../composer/composerSessionMentions';
import { formatComposerWikilink } from '../composer/composerWikilinks';

/**
 * Owns Vault mention caches and composer mention selection.
 * Linked content state and presentation belong to LinkedContentController.
 */
export class FileContextManager {
  private readonly mentionDataProvider: VaultMentionDataProvider;
  private readonly mentionSource: MentionSource;

  constructor(private readonly app: App, sessions?: {
    getConversationList(): readonly ConversationMeta[];
    getCurrentConversationId(): string | null | undefined;
  }) {
    this.mentionDataProvider = new VaultMentionDataProvider(this.app);
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

    this.mentionDataProvider.initializeInBackground();
  }

  getCachedVaultFiles(): readonly TFile[] {
    return this.mentionDataProvider.getCachedVaultFiles();
  }

  getCachedVaultFolders(): readonly FolderMentionItem[] {
    return this.mentionDataProvider.getCachedVaultFolders();
  }

  markFileCacheDirty(): void {
    this.mentionDataProvider.markFilesDirty();
  }

  markFolderCacheDirty(): void {
    this.mentionDataProvider.markFoldersDirty();
  }

  getMentionSource(): MentionSource {
    return this.mentionSource;
  }

  destroy(): void {
    this.mentionSource.destroy();
  }
}
