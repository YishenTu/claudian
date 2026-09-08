import type { App, TFile } from 'obsidian';

import type { AgentMentionProvider } from '../../../core/providers/types';
import { MentionSource } from '../../../shared/composer-dropdown/MentionSource';
import type { FolderMentionItem } from '../../../shared/mention/types';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import {
  getVaultPath,
  normalizePathForVault as normalizePathForVaultUtil,
} from '../../../utils/path';
import { formatComposerWikilink } from '../composer/composerWikilinks';

export interface FileContextCallbacks {
  onAgentMentionSelect?: (agentId: string) => void;
}

/**
 * Owns Vault mention caches and composer mention selection.
 * Linked content state and presentation belong to LinkedContentController.
 */
export class FileContextManager {
  private readonly mentionDataProvider: VaultMentionDataProvider;
  private readonly mentionSource: MentionSource;

  constructor(
    private readonly app: App,
    private readonly callbacks: FileContextCallbacks,
  ) {
    this.mentionDataProvider = new VaultMentionDataProvider(this.app);
    this.mentionSource = new MentionSource({
      onAgentMentionSelect: agentId => this.callbacks.onAgentMentionSelect?.(agentId),
      getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
      getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
      normalizePathForVault: rawPath => this.normalizePathForVault(rawPath),
    }, {
      formatVaultFileMention: formatComposerWikilink,
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

  setAgentService(agentService: AgentMentionProvider | null): void {
    this.mentionSource.setAgentService(agentService);
  }

  destroy(): void {
    this.mentionSource.destroy();
  }

  private normalizePathForVault(rawPath: string | undefined | null): string | null {
    return normalizePathForVaultUtil(rawPath, getVaultPath(this.app));
  }
}
