import type { App, TFile, Vault } from 'obsidian';

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

  /** Subscribes once for a shared view cache and releases all listeners on view close. */
  register(vault: Pick<Vault, 'on' | 'offref'>): () => void {
    this.markFilesDirty();
    this.markFoldersDirty();
    const structuralChange = (): void => {
      this.markFilesDirty();
      this.markFoldersDirty();
    };
    const refs = [
      vault.on('create', structuralChange),
      vault.on('delete', structuralChange),
      vault.on('rename', structuralChange),
      vault.on('modify', () => this.markFilesDirty()),
    ];
    return () => {
      for (const ref of refs.splice(0)) vault.offref(ref);
    };
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
