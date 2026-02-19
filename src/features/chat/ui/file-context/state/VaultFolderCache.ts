import type { App } from 'obsidian';
import { TFolder } from 'obsidian';

function isVisibleFolder(folder: TFolder): boolean {
  const normalizedPath = folder.path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalizedPath) return false;
  return !normalizedPath.split('/').some(segment => segment.startsWith('.'));
}

export class VaultFolderCache {
  private app: App;
  private cachedFolders: TFolder[] = [];
  private dirty = true;
  private isInitialized = false;

  constructor(app: App) {
    this.app = app;
  }

  initializeInBackground(): void {
    if (this.isInitialized) return;

    setTimeout(() => {
      this.tryRefreshFolders();
    }, 0);
  }

  markDirty(): void {
    this.dirty = true;
  }

  getFolders(): TFolder[] {
    if (this.dirty || !this.isInitialized) {
      this.tryRefreshFolders();
    }
    return this.cachedFolders;
  }

  private tryRefreshFolders(): void {
    try {
      this.cachedFolders = this.loadFolders();
      this.dirty = false;
    } catch {
      // Keep stale cache on failure. If we already have data, avoid retrying on every call.
      if (this.cachedFolders.length > 0) {
        this.dirty = false;
      }
    } finally {
      // Mark attempted even if it fails so initializeInBackground runs at most once.
      this.isInitialized = true;
    }
  }

  private loadFolders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter(folder => isVisibleFolder(folder));
  }
}
