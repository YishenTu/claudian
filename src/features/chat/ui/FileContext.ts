import type { App, EventRef, TFile } from 'obsidian';
import { TFolder } from 'obsidian';

import type { AgentMentionProvider } from '../../../core/providers/types';
import { MentionSource } from '../../../shared/composer-dropdown/MentionSource';
import type { FolderMentionItem } from '../../../shared/mention/types';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import {
  getVaultPath,
  normalizePathForVault as normalizePathForVaultUtil,
  rewriteVaultPathAfterRename,
} from '../../../utils/path';
import { formatComposerWikilink } from '../composer/composerWikilinks';

export interface FileContextCallbacks {
  onAgentMentionSelect?: (agentId: string) => void;
}

/**
 * Owns composer file attachments and Vault mention caches.
 * Linked content state and presentation belong to LinkedContentController.
 */
export class FileContextManager {
  private readonly attachedFiles = new Set<string>();
  private readonly mentionDataProvider: VaultMentionDataProvider;
  private readonly mentionSource: MentionSource;
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly callbacks: FileContextCallbacks,
  ) {
    this.mentionDataProvider = new VaultMentionDataProvider(this.app);
    this.mentionSource = new MentionSource({
      onAttachFile: filePath => this.attachedFiles.add(filePath),
      onAgentMentionSelect: agentId => this.callbacks.onAgentMentionSelect?.(agentId),
      getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
      getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
      normalizePathForVault: rawPath => this.normalizePathForVault(rawPath),
    }, {
      formatVaultFileMention: formatComposerWikilink,
    });

    try {
      this.deleteEventRef = this.app.vault.on('delete', file => {
        if (file instanceof TFolder) {
          this.handleDeletedPath(file.path, true);
        } else {
          this.handleDeletedPath(file.path, false);
        }
      });
      this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
        this.handleRenamedPath(oldPath, file.path, file instanceof TFolder);
      });
      this.mentionDataProvider.initializeInBackground();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  getAttachedFiles(): Set<string> {
    return new Set(this.attachedFiles);
  }

  clearAttachments(): void {
    this.attachedFiles.clear();
  }

  getCachedVaultFiles(): readonly TFile[] {
    return this.mentionDataProvider.getCachedVaultFiles();
  }

  getCachedVaultFolders(): readonly Pick<FolderMentionItem, 'name' | 'path'>[] {
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
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.deleteEventRef) {
      this.app.vault.offref(this.deleteEventRef);
      this.deleteEventRef = null;
    }
    if (this.renameEventRef) {
      this.app.vault.offref(this.renameEventRef);
      this.renameEventRef = null;
    }
    this.mentionSource.destroy();
  }

  private normalizePathForVault(rawPath: string | undefined | null): string | null {
    return normalizePathForVaultUtil(rawPath, getVaultPath(this.app));
  }

  private handleRenamedPath(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): void {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld || !normalizedNew) return;
    for (const attachedPath of [...this.attachedFiles]) {
      const renamedPath = rewriteVaultPathAfterRename(
        attachedPath,
        normalizedOld,
        normalizedNew,
        includeDescendants,
      );
      if (!renamedPath) continue;
      this.attachedFiles.delete(attachedPath);
      this.attachedFiles.add(renamedPath);
    }
  }

  private handleDeletedPath(path: string, includeDescendants: boolean): void {
    const normalizedPath = this.normalizePathForVault(path);
    if (!normalizedPath) return;
    for (const attachedPath of [...this.attachedFiles]) {
      if (
        attachedPath === normalizedPath
        || (includeDescendants && attachedPath.startsWith(`${normalizedPath}/`))
      ) {
        this.attachedFiles.delete(attachedPath);
      }
    }
  }
}
