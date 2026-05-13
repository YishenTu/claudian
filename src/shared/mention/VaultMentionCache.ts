import type { App, TFile } from 'obsidian';
import { TFolder } from 'obsidian';

import { setNativeTimeout } from '../../utils/nativeTimers';

export interface VaultFileCacheOptions {
  onLoadError?: (error: unknown) => void;
}

export class VaultFileCache {
  private cachedFiles: TFile[] = [];
  private dirty = true;
  private isInitialized = false;

  constructor(
    private app: App,
    private options: VaultFileCacheOptions = {}
  ) {}

  initializeInBackground(): void {
    if (this.isInitialized) return;

    setNativeTimeout(() => {
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
      this.cachedFiles = this.app.vault.getFiles();
      this.dirty = false;
    } catch (error) {
      this.options.onLoadError?.(error);
      // Keep stale cache on failure. If data exists, avoid retrying each call.
      if (this.cachedFiles.length > 0) {
        this.dirty = false;
      }
    } finally {
      this.isInitialized = true;
    }
  }
}

function isVisibleFolder(folder: TFolder): boolean {
  const normalizedPath = folder.path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalizedPath) return false;
  return !normalizedPath.split('/').some(segment => segment.startsWith('.'));
}

export class VaultFolderCache {
  private cachedFolders: TFolder[] = [];
  private dirty = true;
  private isInitialized = false;

  constructor(private app: App) {}

  initializeInBackground(): void {
    if (this.isInitialized) return;

    setNativeTimeout(() => {
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
      // Keep stale cache on failure. If data exists, avoid retrying each call.
      if (this.cachedFolders.length > 0) {
        this.dirty = false;
      }
    } finally {
      this.isInitialized = true;
    }
  }

  private loadFolders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && isVisibleFolder(file));
  }
}
