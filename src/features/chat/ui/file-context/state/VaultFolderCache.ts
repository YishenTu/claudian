import type { App } from 'obsidian';
import { TFolder } from 'obsidian';

function isVisibleFolder(folder: TFolder): boolean {
  if (!folder.path) return false;
  return !folder.path.split('/').some(segment => segment.startsWith('.'));
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
      try {
        this.cachedFolders = this.loadFolders();
        this.dirty = false;
        this.isInitialized = true;
      } catch {
        // Initialization is best-effort
      }
    }, 0);
  }

  markDirty(): void {
    this.dirty = true;
  }

  getFolders(): TFolder[] {
    if (this.dirty || this.cachedFolders.length === 0) {
      this.cachedFolders = this.loadFolders();
      this.dirty = false;
      this.isInitialized = true;
    }
    return this.cachedFolders;
  }

  private loadFolders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter(folder => isVisibleFolder(folder));
  }
}
