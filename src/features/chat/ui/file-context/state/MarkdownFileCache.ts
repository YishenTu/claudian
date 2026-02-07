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
      try {
        this.cachedFiles = this.app.vault.getMarkdownFiles();
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

  getFiles(): TFile[] {
    if (this.dirty || this.cachedFiles.length === 0) {
      this.cachedFiles = this.app.vault.getMarkdownFiles();
      this.dirty = false;
      this.isInitialized = true;
    }
    return this.cachedFiles;
  }
}
