/**
 * Tracks edited files within the current session.
 */

import { createHash } from 'crypto';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import { isEditTool } from '../../../../core/tools/toolNames';

interface FileHashState {
  originalHash: string | null;
  postEditHash: string;
}

export interface EditedFilesTrackerCallbacks {
  onEditedFilesChanged: () => void;
  getActiveFile: () => TFile | null;
}

export class EditedFilesTracker {
  private app: App;
  private callbacks: EditedFilesTrackerCallbacks;
  private normalizePathForVault: (path: string | undefined | null) => string | null;
  private editedFilesThisSession: Set<string> = new Set();
  private editedFileHashes: Map<string, FileHashState> = new Map();
  private filesBeingEdited: Set<string> = new Set();
  private planModeActive = false;

  constructor(
    app: App,
    normalizePathForVault: (path: string | undefined | null) => string | null,
    callbacks: EditedFilesTrackerCallbacks
  ) {
    this.app = app;
    this.normalizePathForVault = normalizePathForVault;
    this.callbacks = callbacks;
  }

  setPlanModeActive(active: boolean): void {
    this.planModeActive = active;
  }

  clear(): void {
    this.editedFilesThisSession.clear();
    this.editedFileHashes.clear();
    this.filesBeingEdited.clear();
    this.callbacks.onEditedFilesChanged();
  }

  getEditedFiles(): string[] {
    return [...this.editedFilesThisSession];
  }

  isFileEdited(path: string): boolean {
    const normalized = this.normalizePathForVault(path);
    if (!normalized) return false;
    return this.editedFilesThisSession.has(normalized);
  }

  dismissEditedFile(path: string): void {
    const normalized = this.normalizePathForVault(path);
    if (!normalized) return;

    if (this.filesBeingEdited.has(normalized)) return;

    if (this.editedFilesThisSession.has(normalized)) {
      this.editedFilesThisSession.delete(normalized);
      this.editedFileHashes.delete(normalized);
      this.callbacks.onEditedFilesChanged();
    }
  }

  async markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
    if (this.planModeActive) return;
    if (!isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    const wasBeingEdited = this.filesBeingEdited.has(path);
    this.filesBeingEdited.add(path);

    if (!wasBeingEdited) {
      const originalHash = await this.computeFileHash(path);
      this.editedFileHashes.set(path, { originalHash, postEditHash: '' });
    }
  }

  async trackEditedFile(
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    isError: boolean
  ): Promise<void> {
    if (this.planModeActive) return;
    if (!toolName || !isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const filePath = this.normalizePathForVault(rawPath);
    if (!filePath) return;

    if (isError) {
      this.filesBeingEdited.delete(filePath);
      if (!this.editedFilesThisSession.has(filePath)) {
        this.editedFileHashes.delete(filePath);
      }
      return;
    }

    const postEditHash = await this.computeFileHash(filePath);
    const existing = this.editedFileHashes.get(filePath);

    this.filesBeingEdited.delete(filePath);

    if (postEditHash) {
      if (existing?.originalHash && postEditHash === existing.originalHash) {
        this.editedFilesThisSession.delete(filePath);
        this.editedFileHashes.delete(filePath);
        this.callbacks.onEditedFilesChanged();
        return;
      }

      this.editedFileHashes.set(filePath, {
        originalHash: existing?.originalHash ?? null,
        postEditHash,
      });
    }

    this.editedFilesThisSession.add(filePath);

    const activeFile = this.callbacks.getActiveFile();
    if (activeFile) {
      const activePath = this.normalizePathForVault(activeFile.path);
      if (activePath === filePath) {
        this.dismissEditedFile(filePath);
        return;
      }
    }

    this.callbacks.onEditedFilesChanged();
  }

  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>): void {
    if (!isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    this.filesBeingEdited.delete(path);

    if (!this.editedFilesThisSession.has(path)) {
      this.editedFileHashes.delete(path);
    }
  }

  handleFileDeleted(path: string): void {
    const normalized = this.normalizePathForVault(path);
    if (normalized && this.editedFilesThisSession.has(normalized)) {
      this.editedFilesThisSession.delete(normalized);
      this.editedFileHashes.delete(normalized);
      this.filesBeingEdited.delete(normalized);
      this.callbacks.onEditedFilesChanged();
    }
  }

  handleFileRenamed(oldPath: string, newPath: string): void {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    if (this.editedFilesThisSession.has(normalizedOld)) {
      this.editedFilesThisSession.delete(normalizedOld);
      const hashState = this.editedFileHashes.get(normalizedOld);
      this.editedFileHashes.delete(normalizedOld);

      if (normalizedNew) {
        this.editedFilesThisSession.add(normalizedNew);
        if (hashState) this.editedFileHashes.set(normalizedNew, hashState);
      }
      needsUpdate = true;
    }

    if (this.filesBeingEdited.has(normalizedOld)) {
      this.filesBeingEdited.delete(normalizedOld);
      if (normalizedNew) {
        this.filesBeingEdited.add(normalizedNew);
      }
    }

    if (needsUpdate) {
      this.callbacks.onEditedFilesChanged();
    }
  }

  async handleFileModified(file: TFile): Promise<void> {
    const normalized = this.normalizePathForVault(file.path);
    if (!normalized) return;

    if (this.filesBeingEdited.has(normalized)) return;

    if (!this.editedFilesThisSession.has(normalized)) return;

    const hashState = this.editedFileHashes.get(normalized);
    if (!hashState) return;

    const currentHash = await this.computeFileHash(normalized);
    if (!currentHash) return;

    if (hashState.originalHash && currentHash === hashState.originalHash) {
      this.editedFilesThisSession.delete(normalized);
      this.editedFileHashes.delete(normalized);
      this.callbacks.onEditedFilesChanged();
    }
  }

  private async computeFileHash(path: string): Promise<string | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      const content = await this.app.vault.read(file);
      return await this.computeContentHash(content);
    } catch (error) {
      console.warn(`Failed to compute file hash for "${path}":`, error);
      return null;
    }
  }

  private async computeContentHash(content: string): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    return createHash('sha256').update(content, 'utf8').digest('hex');
  }
}
