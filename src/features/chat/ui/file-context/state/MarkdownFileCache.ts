import type { App } from 'obsidian';
import type { TFile } from 'obsidian';

export class MarkdownFileCache {
  private app: App;
  private cachedFiles: TFile[] = [];
  private dirty = true;
  private isInitialized = false;

  constructor(app: App) {
    this.app = app;
  }

  initializeInBackground(): void {
    if (this.isInitialized) return;

    setTimeout(() => {
      this.tryRefreshFiles();
    }, 0);
  }

  markDirty(): void {
    this.dirty = true;
  }

  getFiles(): TFile[] {
    if (this.dirty || !this.isInitialized) {
      this.tryRefreshFiles();
    }
    return this.cachedFiles;
  }

  private tryRefreshFiles(): void {
    try {
      this.cachedFiles = this.app.vault.getMarkdownFiles();
      this.dirty = false;
    } catch {
      // Keep stale cache on failure. If data exists, avoid retrying each call.
      if (this.cachedFiles.length > 0) {
        this.dirty = false;
      }
    } finally {
      this.isInitialized = true;
    }
  }
}
