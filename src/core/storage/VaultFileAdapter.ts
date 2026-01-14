/**
 * VaultFileAdapter - Wrapper around Obsidian Vault API for file operations.
 *
 * Provides a consistent interface for file operations using Obsidian's
 * vault adapter instead of Node's fs module.
 */

import type { App } from 'obsidian';

export class VaultFileAdapter {
  constructor(private app: App) {}

  /** Check if a file or folder exists. */
  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  /** Read file contents as string. */
  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  /** Write content to a file, creating parent directories if needed. */
  async write(path: string, content: string): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf('/'));
    if (folder && !(await this.exists(folder))) {
      await this.ensureFolder(folder);
    }
    await this.app.vault.adapter.write(path, content);
  }

  /** Append content to a file. Creates the file if it doesn't exist. */
  async append(path: string, content: string): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf('/'));
    if (folder && !(await this.exists(folder))) {
      await this.ensureFolder(folder);
    }
    if (await this.exists(path)) {
      const existing = await this.read(path);
      await this.app.vault.adapter.write(path, existing + content);
    } else {
      await this.app.vault.adapter.write(path, content);
    }
  }

  /** Delete a file if it exists. */
  async delete(path: string): Promise<void> {
    if (await this.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  /** List files in a folder. Returns relative paths from the folder. */
  async listFiles(folder: string): Promise<string[]> {
    if (!(await this.exists(folder))) {
      return [];
    }
    const listing = await this.app.vault.adapter.list(folder);
    return listing.files;
  }

  /** List subfolders in a folder. Returns relative paths from the folder. */
  async listFolders(folder: string): Promise<string[]> {
    if (!(await this.exists(folder))) {
      return [];
    }
    const listing = await this.app.vault.adapter.list(folder);
    return listing.folders;
  }

  /** Recursively list all files in a folder and subfolders. */
  async listFilesRecursive(folder: string): Promise<string[]> {
    const allFiles: string[] = [];

    const processFolder = async (currentFolder: string) => {
      if (!(await this.exists(currentFolder))) return;

      const listing = await this.app.vault.adapter.list(currentFolder);
      allFiles.push(...listing.files);

      for (const subfolder of listing.folders) {
        await processFolder(subfolder);
      }
    };

    await processFolder(folder);
    return allFiles;
  }

  /** Ensure a folder exists, creating it and parent folders if needed. */
  async ensureFolder(path: string): Promise<void> {
    if (await this.exists(path)) return;

    // Create parent folders recursively
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  /** Rename/move a file. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.app.vault.adapter.rename(oldPath, newPath);
  }

  /** Get file stats (mtime, size). Returns null if file doesn't exist or on error. */
  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat) return null;
      return { mtime: stat.mtime, size: stat.size };
    } catch {
      return null;
    }
  }
}
