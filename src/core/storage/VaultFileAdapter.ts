/**
 * VaultFileAdapter - Wrapper around Obsidian Vault API for file operations.
 *
 * Provides a consistent interface for file operations using Obsidian's
 * vault adapter instead of Node's fs module.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { App, DataAdapter } from 'obsidian';

export type ManagedResourceType = 'file' | 'folder';

export interface ManagedPathVerificationOptions {
  expectedType: ManagedResourceType;
  allowMissing?: boolean;
}

export class ManagedResourcePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedResourcePathError';
  }
}

export class ManagedResourceCollisionError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Managed resource already exists: ${path}`, options);
    this.name = 'ManagedResourceCollisionError';
  }
}

export class ManagedResourceRelocationError extends Error {
  readonly rollbackErrors: readonly Error[];

  constructor(source: string, target: string, cause: unknown, rollbackErrors: Error[]) {
    super(`Failed to relocate managed package from ${source} to ${target}`, { cause });
    this.name = 'ManagedResourceRelocationError';
    this.rollbackErrors = rollbackErrors;
  }
}

interface DesktopDataAdapter extends DataAdapter {
  getBasePath(): string;
}

function normalizeManagedPath(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new ManagedResourcePathError('Managed path must be a normalized vault-relative path');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new ManagedResourcePathError('Managed path must be a normalized vault-relative path');
  }
  return parts.join('/');
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT';
}

function isCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['EEXIST', 'EISDIR', 'ENOTEMPTY', 'ERR_FS_CP_EEXIST'].includes(
    String(error.code),
  );
}

function findFullyRolledBackCollision(error: unknown): ManagedResourceCollisionError | null {
  if (error instanceof ManagedResourceCollisionError) return error;
  if (
    error instanceof ManagedResourceRelocationError
    && error.rollbackErrors.length === 0
  ) {
    return findFullyRolledBackCollision(error.cause);
  }
  return null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class VaultFileAdapter {
  private writeQueue: Promise<void> = Promise.resolve();
  private folderCreationPromises = new Map<string, Promise<void>>();

  constructor(private app: App) {}

  private get adapter(): DataAdapter {
    return this.app.vault.adapter;
  }

  private getDesktopAdapter(): DesktopDataAdapter | null {
    const candidate = this.adapter as Partial<DesktopDataAdapter>;
    return typeof candidate.getBasePath === 'function' ? candidate as DesktopDataAdapter : null;
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureParentFolder(path);
    await this.app.vault.adapter.write(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    await this.ensureParentFolder(path);
    this.writeQueue = this.writeQueue.then(async () => {
      if (await this.exists(path)) {
        const existing = await this.read(path);
        await this.app.vault.adapter.write(path, existing + content);
      } else {
        await this.app.vault.adapter.write(path, content);
      }
    }).catch(() => {
      // prevent queue from getting stuck
    });
    await this.writeQueue;
  }

  async delete(path: string): Promise<void> {
    if (await this.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  /** Fails silently if non-empty or missing. */
  async deleteFolder(path: string): Promise<void> {
    try {
      if (await this.exists(path)) {
        await this.app.vault.adapter.rmdir(path, false);
      }
    } catch {
      // Non-critical: directory may not be empty
    }
  }

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

  private async ensureParentFolder(filePath: string): Promise<void> {
    const folder = filePath.substring(0, filePath.lastIndexOf('/'));
    if (folder && !(await this.exists(folder))) {
      await this.ensureFolder(folder);
    }
  }

  /** Ensure a folder exists, creating it and parent folders if needed. */
  async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureSingleFolder(current);
    }
  }

  private async ensureSingleFolder(path: string): Promise<void> {
    const existing = this.folderCreationPromises.get(path);
    if (existing) {
      await existing;
      return;
    }
    if (await this.exists(path)) return;

    const pendingAfterCheck = this.folderCreationPromises.get(path);
    if (pendingAfterCheck) {
      await pendingAfterCheck;
      return;
    }

    const creation = (async () => {
      try {
        await this.app.vault.adapter.mkdir(path);
      } catch (error) {
        if (!(await this.exists(path))) {
          throw error;
        }
      }
    })();
    this.folderCreationPromises.set(path, creation);
    try {
      await creation;
    } finally {
      if (this.folderCreationPromises.get(path) === creation) {
        this.folderCreationPromises.delete(path);
      }
    }
  }

  /** Rename/move a file. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.app.vault.adapter.rename(oldPath, newPath);
  }

  async verifyManagedPath(
    resourcePath: string,
    options: ManagedPathVerificationOptions,
  ): Promise<boolean> {
    const normalized = normalizeManagedPath(resourcePath);
    const desktopAdapter = this.getDesktopAdapter();
    if (desktopAdapter) {
      return this.verifyDesktopManagedPath(desktopAdapter, normalized, options);
    }
    return this.verifyAdapterManagedPath(normalized, options);
  }

  private async verifyDesktopManagedPath(
    adapter: DesktopDataAdapter,
    normalized: string,
    options: ManagedPathVerificationOptions,
  ): Promise<boolean> {
    const basePath = path.resolve(adapter.getBasePath());
    let realBasePath: string;
    try {
      realBasePath = await fs.realpath(basePath);
    } catch (error) {
      throw new ManagedResourcePathError('Could not resolve the vault root', { cause: error });
    }
    const candidatePath = path.resolve(basePath, ...normalized.split('/'));
    const relativeCandidate = path.relative(basePath, candidatePath);
    if (
      relativeCandidate === '..'
      || relativeCandidate.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeCandidate)
    ) {
      throw new ManagedResourcePathError('Managed path escapes the vault root');
    }

    let current = basePath;
    const segments = normalized.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (isNotFound(error)) {
          if (options.allowMissing) return false;
          throw new ManagedResourcePathError(`Managed resource does not exist: ${normalized}`, {
            cause: error,
          });
        }
        throw new ManagedResourcePathError(`Could not inspect managed resource: ${normalized}`, {
          cause: error,
        });
      }
      if (stat.isSymbolicLink()) {
        throw new ManagedResourcePathError(`Managed resource must not be a symlink: ${normalized}`);
      }
      let realCurrent: string;
      try {
        realCurrent = await fs.realpath(current);
      } catch (error) {
        throw new ManagedResourcePathError(`Could not resolve managed resource: ${normalized}`, {
          cause: error,
        });
      }
      const relative = path.relative(realBasePath, realCurrent);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ManagedResourcePathError(`Managed resource escapes the vault root: ${normalized}`);
      }
      const expectedType = index === segments.length - 1 ? options.expectedType : 'folder';
      const matches = expectedType === 'folder' ? stat.isDirectory() : stat.isFile();
      if (!matches) {
        throw new ManagedResourcePathError(
          `Managed resource must be a regular ${expectedType}: ${normalized}`,
        );
      }
    }
    return true;
  }

  private async verifyAdapterManagedPath(
    normalized: string,
    options: ManagedPathVerificationOptions,
  ): Promise<boolean> {
    const segments = normalized.split('/');
    let current = '';
    for (let index = 0; index < segments.length; index += 1) {
      current = current ? `${current}/${segments[index]}` : segments[index];
      let stat;
      try {
        stat = await this.adapter.stat(current);
      } catch (error) {
        throw new ManagedResourcePathError(`Could not inspect managed resource: ${normalized}`, {
          cause: error,
        });
      }
      if (!stat) {
        if (options.allowMissing) return false;
        throw new ManagedResourcePathError(`Managed resource does not exist: ${normalized}`);
      }
      const expectedType = index === segments.length - 1 ? options.expectedType : 'folder';
      if (stat.type !== expectedType) {
        throw new ManagedResourcePathError(
          `Managed resource must be a regular ${expectedType}: ${normalized}`,
        );
      }
    }
    return true;
  }

  async ensureManagedFolder(folderPath: string): Promise<void> {
    const normalized = normalizeManagedPath(folderPath);
    const segments = normalized.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (await this.verifyManagedPath(current, { expectedType: 'folder', allowMissing: true })) {
        continue;
      }
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        const wonByAnotherWriter = await this.verifyManagedPath(current, {
          expectedType: 'folder',
          allowMissing: true,
        });
        if (!wonByAnotherWriter) {
          throw new ManagedResourcePathError(`Could not create managed folder: ${current}`, {
            cause: error,
          });
        }
      }
      await this.verifyManagedPath(current, { expectedType: 'folder' });
    }
  }

  async createManagedFolderExclusive(folderPath: string): Promise<void> {
    const normalized = normalizeManagedPath(folderPath);
    const parent = normalized.slice(0, normalized.lastIndexOf('/'));
    if (parent) {
      await this.verifyManagedPath(parent, { expectedType: 'folder' });
    }
    if (await this.verifyManagedCollisionTarget(normalized)) {
      throw new ManagedResourceCollisionError(normalized);
    }
    try {
      await this.adapter.mkdir(normalized);
    } catch (error) {
      if (await this.verifyManagedCollisionTarget(normalized)) {
        throw new ManagedResourceCollisionError(normalized, { cause: error });
      }
      throw new ManagedResourcePathError(
        `Could not exclusively create managed folder: ${normalized}`,
        { cause: error },
      );
    }
    await this.verifyManagedPath(normalized, { expectedType: 'folder' });
  }

  private async verifyManagedCollisionTarget(resourcePath: string): Promise<boolean> {
    try {
      return await this.verifyManagedPath(resourcePath, {
        expectedType: 'folder',
        allowMissing: true,
      });
    } catch (folderError) {
      try {
        return await this.verifyManagedPath(resourcePath, {
          expectedType: 'file',
          allowMissing: true,
        });
      } catch {
        throw folderError;
      }
    }
  }

  async readManagedFile(filePath: string): Promise<string> {
    await this.verifyManagedPath(filePath, { expectedType: 'file' });
    try {
      return await this.adapter.read(filePath);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not read managed resource: ${filePath}`, {
        cause: error,
      });
    }
  }

  async writeManagedFile(filePath: string, content: string): Promise<void> {
    const normalized = normalizeManagedPath(filePath);
    const parent = normalized.slice(0, normalized.lastIndexOf('/'));
    await this.verifyManagedPath(parent, { expectedType: 'folder' });
    await this.verifyManagedPath(normalized, { expectedType: 'file', allowMissing: true });
    try {
      await this.adapter.write(normalized, content);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not write managed resource: ${normalized}`, {
        cause: error,
      });
    }
  }

  async listManagedFolder(folderPath: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = normalizeManagedPath(folderPath);
    await this.verifyManagedPath(normalized, { expectedType: 'folder' });
    let listing;
    try {
      listing = await this.adapter.list(normalized);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not list managed resource: ${normalized}`, {
        cause: error,
      });
    }
    return { files: [...listing.files], folders: [...listing.folders] };
  }

  async removeManagedFile(filePath: string): Promise<void> {
    if (!await this.verifyManagedPath(filePath, { expectedType: 'file', allowMissing: true })) return;
    try {
      await this.adapter.remove(filePath);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not remove managed resource: ${filePath}`, {
        cause: error,
      });
    }
  }

  async removeManagedFolderIfEmpty(folderPath: string): Promise<void> {
    if (!await this.verifyManagedPath(folderPath, { expectedType: 'folder', allowMissing: true })) return;
    try {
      await this.adapter.rmdir(folderPath, false);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not remove managed folder: ${folderPath}`, {
        cause: error,
      });
    }
  }

  async relocateManagedPackageNoReplace(sourcePath: string, targetPath: string): Promise<void> {
    const source = normalizeManagedPath(sourcePath);
    const target = normalizeManagedPath(targetPath);
    await this.verifyManagedPath(source, { expectedType: 'folder' });
    const moved: Array<{ source: string; target: string }> = [];
    let targetClaimed = false;

    try {
      await this.createManagedFolderExclusive(target);
      targetClaimed = true;
      const listing = await this.listManagedFolder(source);
      const entries = [...listing.folders, ...listing.files]
        .sort((left, right) => {
          const leftSkill = path.posix.basename(left) === 'SKILL.md';
          const rightSkill = path.posix.basename(right) === 'SKILL.md';
          if (leftSkill !== rightSkill) return leftSkill ? 1 : -1;
          return left.localeCompare(right);
        });

      for (const entry of entries) {
        if (path.posix.dirname(entry) !== source) {
          throw new ManagedResourcePathError(`Package listing escaped its directory: ${source}`);
        }
        const destination = `${target}/${path.posix.basename(entry)}`;
        if (await this.adapter.exists(destination)) {
          throw new ManagedResourceCollisionError(destination);
        }
        await this.moveManagedEntryNoReplace(entry, destination);
        moved.push({ source: entry, target: destination });
      }
      await this.adapter.rmdir(source, false);
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const entry of [...moved].reverse()) {
        try {
          if (await this.adapter.exists(entry.target)) {
            await this.moveManagedEntryNoReplace(entry.target, entry.source);
          }
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
      }
      if (targetClaimed) {
        try {
          await this.adapter.rmdir(target, false);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
      }
      const collision = rollbackErrors.length === 0
        ? findFullyRolledBackCollision(error)
        : null;
      if (collision) {
        throw collision;
      }
      throw new ManagedResourceRelocationError(source, target, error, rollbackErrors);
    }
  }

  private async moveManagedEntryNoReplace(sourcePath: string, targetPath: string): Promise<void> {
    const source = normalizeManagedPath(sourcePath);
    const target = normalizeManagedPath(targetPath);
    const desktopAdapter = this.getDesktopAdapter();
    if (!desktopAdapter) {
      throw new ManagedResourcePathError(
        'Exclusive managed relocation requires a filesystem-backed vault adapter',
      );
    }

    const basePath = path.resolve(desktopAdapter.getBasePath());
    const sourceAbsolute = this.resolveManagedDesktopPath(basePath, source);
    const targetAbsolute = this.resolveManagedDesktopPath(basePath, target);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(sourceAbsolute);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not inspect managed resource: ${source}`, {
        cause: error,
      });
    }
    if (stat.isSymbolicLink()) {
      throw new ManagedResourcePathError(`Managed resource must not be a symlink: ${source}`);
    }

    try {
      if (stat.isFile()) {
        await fs.link(sourceAbsolute, targetAbsolute);
        await fs.unlink(sourceAbsolute);
        return;
      }
      if (!stat.isDirectory()) {
        throw new ManagedResourcePathError(
          `Managed resource must be a regular file or folder: ${source}`,
        );
      }
      await this.moveManagedDirectoryNoReplace(
        source,
        target,
        sourceAbsolute,
        targetAbsolute,
      );
    } catch (error) {
      if (isCollision(error)) {
        throw new ManagedResourceCollisionError(target, { cause: error });
      }
      throw error;
    }
  }

  private async moveManagedDirectoryNoReplace(
    source: string,
    target: string,
    sourceAbsolute: string,
    targetAbsolute: string,
  ): Promise<void> {
    try {
      await fs.mkdir(targetAbsolute);
    } catch (error) {
      if (isCollision(error)) {
        throw new ManagedResourceCollisionError(target, { cause: error });
      }
      throw error;
    }

    const moved: Array<{ source: string; target: string }> = [];
    try {
      const entries = await fs.readdir(sourceAbsolute);
      for (const name of entries.sort((left, right) => left.localeCompare(right))) {
        const childSource = `${source}/${name}`;
        const childTarget = `${target}/${name}`;
        await this.moveManagedEntryNoReplace(childSource, childTarget);
        moved.push({ source: childSource, target: childTarget });
      }
      await fs.rmdir(sourceAbsolute);
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const entry of [...moved].reverse()) {
        try {
          await this.moveManagedEntryNoReplace(entry.target, entry.source);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
      }
      try {
        await fs.rmdir(targetAbsolute);
      } catch (rollbackError) {
        rollbackErrors.push(toError(rollbackError));
      }
      throw new ManagedResourceRelocationError(source, target, error, rollbackErrors);
    }

  }

  private resolveManagedDesktopPath(basePath: string, resourcePath: string): string {
    const candidate = path.resolve(basePath, ...resourcePath.split('/'));
    const relative = path.relative(basePath, candidate);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new ManagedResourcePathError('Managed path escapes the vault root');
    }
    return candidate;
  }

  async trash(resourcePath: string): Promise<void> {
    const normalized = normalizeManagedPath(resourcePath);
    try {
      if (!await this.adapter.exists(normalized)) return;
      if (!await this.adapter.trashSystem(normalized)) {
        await this.adapter.trashLocal(normalized);
      }
    } catch (error) {
      throw new ManagedResourcePathError(`Could not trash managed resource: ${normalized}`, {
        cause: error,
      });
    }
  }

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
