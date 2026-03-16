import type { App, TFile } from 'obsidian';

import { VaultFileCache, VaultFolderCache } from './VaultMentionCache';

export interface VaultMentionDataProviderOptions {
  onFileLoadError?: () => void;
}

export class VaultMentionDataProvider {
  private fileCache: VaultFileCache;
  private folderCache: VaultFolderCache;
  private hasReportedFileLoadError = false;

  constructor(
    app: App,
    options: VaultMentionDataProviderOptions = {}
  ) {
    this.fileCache = new VaultFileCache(app, {
      onLoadError: () => {
        if (this.hasReportedFileLoadError) return;
        this.hasReportedFileLoadError = true;
        options.onFileLoadError?.();
      },
    });
    this.folderCache = new VaultFolderCache(app);
  }

  initializeInBackground(): void {
    this.fileCache.initializeInBackground();
    this.folderCache.initializeInBackground();
  }

  markFilesDirty(): void {
    this.fileCache.markDirty();
  }

  markFoldersDirty(): void {
    this.folderCache.markDirty();
  }

  getCachedVaultFiles(): TFile[] {
    return this.fileCache.getFiles();
  }

  getCachedVaultFolders(): Array<{ name: string; path: string }> {
    return this.folderCache.getFolders().map(folder => ({
      name: folder.name,
      path: folder.path,
    }));
  }
}
