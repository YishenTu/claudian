/**
 * Cached markdown files for mention search.
 */

import type { App } from 'obsidian';
import type { TFile } from 'obsidian';

export class MarkdownFileCache {
  private app: App;
  private cachedFiles: TFile[] = [];
  private dirty = true;

  constructor(app: App) {
    this.app = app;
  }

  markDirty(): void {
    this.dirty = true;
  }

  getFiles(): TFile[] {
    if (this.dirty || this.cachedFiles.length === 0) {
      this.cachedFiles = this.app.vault.getMarkdownFiles();
      this.dirty = false;
    }
    return [...this.cachedFiles];
  }
}
