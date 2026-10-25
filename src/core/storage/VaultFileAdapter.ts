/**
 * VaultFileAdapter - Wrapper around Obsidian Vault API for file operations.
 *
 * Provides a consistent interface for file operations using Obsidian's
 * vault adapter instead of Node's fs module.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { App, DataAdapter } from 'obsidian';

import { mapWithConcurrency } from '@/utils/concurrency';

export type ManagedResourceType = 'file' | 'folder';

/** State of a vault path that may be a folder link to an expected vault folder. */
export type FolderLinkState = 'missing' | 'folder' | 'linked' | 'foreign-link' | 'broken-link' | 'other';

/** A direct child of a managed folder; `link` covers symlinks and junctions, including dangling ones. */
export interface ManagedFolderEntry {
  path: string;
  type: ManagedResourceType | 'link' | 'other';
}

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

export class VaultFileAdapter {
  private folderCreationPromises = new Map<string, Promise<void>>();

  constructor(private app: App) {}

  private get adapter(): DataAdapter {
    return this.app.vault.adapter;
  }

  #getDesktopAdapter(): DesktopDataAdapter | null {
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
    await this.#ensureParentFolder(path);
    await this.app.vault.adapter.write(path, content);
  }

  async delete(path: string): Promise<void> {
    if (await this.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  async listFiles(folder: string): Promise<string[]> {
    if (!(await this.exists(folder))) {
      return [];
    }
    const listing = await this.app.vault.adapter.list(folder);
    return listing.files;
  }

  /** Recursively list all files in a folder and subfolders. */
  async listFilesRecursive(folder: string): Promise<string[]> {
    const listings = new Map<string, { files: string[]; folders: string[] }>();
    let pending = [folder];
    while (pending.length) {
      const children = await mapWithConcurrency(pending, async current => {
        if (!await this.exists(current)) return [];
        const listing = await this.app.vault.adapter.list(current);
        listings.set(current, listing);
        return listing.folders;
      }, 8);
      pending = children.flat();
    }
    const allFiles: string[] = [];
    const collect = (current: string): void => {
      const listing = listings.get(current);
      if (!listing) return;
      allFiles.push(...listing.files);
      for (const child of listing.folders) collect(child);
    };
    collect(folder);
    return allFiles;
  }

  async #ensureParentFolder(filePath: string): Promise<void> {
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
      await this.#ensureSingleFolder(current);
    }
  }

  async #ensureSingleFolder(path: string): Promise<void> {
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
    const desktopAdapter = this.#getDesktopAdapter();
    if (desktopAdapter) {
      return this.#verifyDesktopManagedPath(desktopAdapter, normalized, options);
    }
    return this.#verifyAdapterManagedPath(normalized, options);
  }

  async #verifyDesktopManagedPath(
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

  async #verifyAdapterManagedPath(
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
    if (await this.verifyManagedPath(normalized, { expectedType: 'folder', allowMissing: true })) return;
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
    if (await this.#verifyManagedCollisionTarget(normalized)) {
      throw new ManagedResourceCollisionError(normalized);
    }
    try {
      await this.#createFolderExclusive(normalized);
    } catch (error) {
      if (await this.#verifyManagedCollisionTarget(normalized)) {
        throw new ManagedResourceCollisionError(normalized, { cause: error });
      }
      throw new ManagedResourcePathError(
        `Could not exclusively create managed folder: ${normalized}`,
        { cause: error },
      );
    }
    await this.verifyManagedPath(normalized, { expectedType: 'folder' });
  }

  async #verifyManagedCollisionTarget(resourcePath: string): Promise<boolean> {
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

  async readManagedBinary(filePath: string): Promise<ArrayBuffer> {
    await this.verifyManagedPath(filePath, { expectedType: 'file' });
    try {
      return await this.adapter.readBinary(filePath);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not read managed resource: ${filePath}`, {
        cause: error,
      });
    }
  }

  async writeManagedFile(filePath: string, content: string): Promise<void> {
    const normalized = normalizeManagedPath(filePath);
    const separator = normalized.lastIndexOf('/');
    // The vault root itself needs no verification.
    if (separator !== -1) await this.verifyManagedPath(normalized.slice(0, separator), { expectedType: 'folder' });
    await this.verifyManagedPath(normalized, { expectedType: 'file', allowMissing: true });
    try {
      const desktopAdapter = this.#getDesktopAdapter();
      if (desktopAdapter) {
        await this.#writeDesktopFileAtomically(desktopAdapter, normalized, content);
      } else {
        await this.adapter.write(normalized, content);
      }
    } catch (error) {
      throw new ManagedResourcePathError(`Could not write managed resource: ${normalized}`, {
        cause: error,
      });
    }
  }

  /**
   * Writes a sibling temp file and renames it over the target, so a failed or
   * torn write never leaves the previous content partially overwritten.
   */
  async #writeDesktopFileAtomically(
    adapter: DesktopDataAdapter,
    normalized: string,
    content: string,
  ): Promise<void> {
    const target = this.#resolveManagedDesktopPath(path.resolve(adapter.getBasePath()), normalized);
    const temp = path.join(path.dirname(target), `.claudian-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
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

  /**
   * Lists direct children without following links. Obsidian's desktop `list`
   * stats through links and rejects the whole listing on a dangling one.
   */
  async listManagedFolderEntries(folderPath: string): Promise<ManagedFolderEntry[]> {
    const normalized = normalizeManagedPath(folderPath);
    const desktopAdapter = this.#getDesktopAdapter();
    if (!desktopAdapter) {
      const listing = await this.listManagedFolder(normalized);
      return [
        ...listing.folders.map(entry => ({ path: entry, type: 'folder' as const })),
        ...listing.files.map(entry => ({ path: entry, type: 'file' as const })),
      ];
    }
    await this.verifyManagedPath(normalized, { expectedType: 'folder' });
    let dirents;
    try {
      dirents = await fs.readdir(
        this.#resolveManagedDesktopPath(path.resolve(desktopAdapter.getBasePath()), normalized),
        { withFileTypes: true },
      );
    } catch (error) {
      throw new ManagedResourcePathError(`Could not list managed resource: ${normalized}`, {
        cause: error,
      });
    }
    return dirents.map(dirent => ({
      path: `${normalized}/${dirent.name}`,
      type: dirent.isSymbolicLink() ? 'link'
        : dirent.isDirectory() ? 'folder'
          : dirent.isFile() ? 'file'
            : 'other',
    }));
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
      await this.#removeEmptyFolder(normalizeManagedPath(folderPath));
    } catch (error) {
      throw new ManagedResourcePathError(`Could not remove managed folder: ${folderPath}`, {
        cause: error,
      });
    }
  }

  /**
   * Moves a file into an existing folder, never replacing a resource at the target. Throws
   * `ManagedResourceCollisionError` with both paths untouched when the target is taken.
   */
  async moveManagedFileNoReplace(sourcePath: string, targetPath: string): Promise<void> {
    const source = normalizeManagedPath(sourcePath);
    const target = normalizeManagedPath(targetPath);
    await this.verifyManagedPath(source, { expectedType: 'file' });
    const separator = target.lastIndexOf('/');
    // The vault root itself needs no verification.
    if (separator !== -1) await this.verifyManagedPath(target.slice(0, separator), { expectedType: 'folder' });
    if (await this.#verifyManagedCollisionTarget(target)) {
      throw new ManagedResourceCollisionError(target);
    }
    if (this.#getDesktopAdapter()) {
      // A hard link claims the target exclusively, so a racing writer is never replaced.
      await this.moveManagedEntryNoReplace(source, target);
      return;
    }
    try {
      await this.adapter.rename(source, target);
    } catch (error) {
      if (await this.#verifyManagedCollisionTarget(target)) {
        throw new ManagedResourceCollisionError(target, { cause: error });
      }
      throw new ManagedResourcePathError(`Could not move managed resource: ${source}`, { cause: error });
    }
  }

  /**
   * Renames the complete package after rejecting existing targets. A directory created
   * after the check may be replaced if it is still empty when the filesystem renames.
   */
  async relocateManagedPackage(sourcePath: string, targetPath: string): Promise<void> {
    const source = normalizeManagedPath(sourcePath);
    const target = normalizeManagedPath(targetPath);
    await this.verifyManagedPath(source, { expectedType: 'folder' });
    const parent = path.posix.dirname(target);
    if (parent !== '.') await this.verifyManagedPath(parent, { expectedType: 'folder' });
    if (await this.#verifyManagedCollisionTarget(target)) {
      throw new ManagedResourceCollisionError(target);
    }
    const basePath = this.#requireDesktopBasePath();
    try {
      await fs.rename(
        this.#resolveManagedDesktopPath(basePath, source),
        this.#resolveManagedDesktopPath(basePath, target),
      );
    } catch (error) {
      // Windows can report a destination collision as EPERM instead of EEXIST/ENOTEMPTY.
      if (isCollision(error) || await this.#verifyManagedCollisionTarget(target)) {
        throw new ManagedResourceCollisionError(target, { cause: error });
      }
      throw new ManagedResourcePathError(`Could not relocate managed package from ${source} to ${target}`, {
        cause: error,
      });
    }
  }

  private async moveManagedEntryNoReplace(source: string, target: string): Promise<void> {
    const basePath = this.#requireDesktopBasePath();
    const sourceAbsolute = this.#resolveManagedDesktopPath(basePath, source);
    const targetAbsolute = this.#resolveManagedDesktopPath(basePath, target);
    try {
      await fs.link(sourceAbsolute, targetAbsolute);
      await fs.unlink(sourceAbsolute);
    } catch (error) {
      if (isCollision(error)) throw new ManagedResourceCollisionError(target, { cause: error });
      throw error;
    }
  }

  #resolveManagedDesktopPath(basePath: string, resourcePath: string): string {
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

  /**
   * Inspects `linkPath` without following it. The parent chain must be regular
   * vault folders; only the final segment may be a link.
   */
  async inspectFolderLink(linkPath: string, expectedTargetPath: string): Promise<FolderLinkState> {
    const link = normalizeManagedPath(linkPath);
    const target = normalizeManagedPath(expectedTargetPath);
    const basePath = this.#requireDesktopBasePath();
    const parent = path.posix.dirname(link);
    if (parent !== '.' && !await this.verifyManagedPath(parent, { expectedType: 'folder', allowMissing: true })) {
      return 'missing';
    }
    const linkAbsolute = this.#resolveManagedDesktopPath(basePath, link);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(linkAbsolute);
    } catch (error) {
      if (isNotFound(error)) return 'missing';
      throw new ManagedResourcePathError(`Could not inspect managed resource: ${link}`, { cause: error });
    }
    if (!stat.isSymbolicLink()) return stat.isDirectory() ? 'folder' : 'other';

    let linkReal: string;
    try {
      linkReal = await fs.realpath(linkAbsolute);
    } catch {
      return 'broken-link';
    }
    let targetReal: string | null;
    try {
      targetReal = await fs.realpath(this.#resolveManagedDesktopPath(basePath, target));
    } catch {
      targetReal = null;
    }
    return targetReal !== null && linkReal === targetReal ? 'linked' : 'foreign-link';
  }

  /**
   * Creates `linkPath` as a folder link to `targetPath`. POSIX links are relative
   * so they survive moving the vault; Windows uses a junction, which needs no
   * elevated privileges but must be absolute.
   */
  async createFolderLink(linkPath: string, targetPath: string): Promise<void> {
    const link = normalizeManagedPath(linkPath);
    const target = normalizeManagedPath(targetPath);
    const basePath = this.#requireDesktopBasePath();
    await this.verifyManagedPath(target, { expectedType: 'folder' });
    const parent = path.posix.dirname(link);
    if (parent !== '.') await this.ensureManagedFolder(parent);

    const linkAbsolute = this.#resolveManagedDesktopPath(basePath, link);
    const targetAbsolute = this.#resolveManagedDesktopPath(basePath, target);
    try {
      if (process.platform === 'win32') {
        await fs.symlink(targetAbsolute, linkAbsolute, 'junction');
      } else {
        await fs.symlink(path.relative(path.dirname(linkAbsolute), targetAbsolute), linkAbsolute, 'dir');
      }
    } catch (error) {
      if (isCollision(error)) throw new ManagedResourceCollisionError(link, { cause: error });
      throw new ManagedResourcePathError(`Could not create folder link: ${link}`, { cause: error });
    }
  }

  /** Removes a folder link itself. Never follows the link or touches its target. */
  async removeFolderLink(linkPath: string): Promise<void> {
    const link = normalizeManagedPath(linkPath);
    const basePath = this.#requireDesktopBasePath();
    const parent = path.posix.dirname(link);
    if (parent !== '.') await this.verifyManagedPath(parent, { expectedType: 'folder' });
    const linkAbsolute = this.#resolveManagedDesktopPath(basePath, link);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(linkAbsolute);
    } catch (error) {
      throw new ManagedResourcePathError(`Could not inspect managed resource: ${link}`, { cause: error });
    }
    if (!stat.isSymbolicLink()) {
      throw new ManagedResourcePathError(`Managed resource is not a link: ${link}`);
    }
    try {
      await fs.unlink(linkAbsolute);
    } catch (error) {
      if (process.platform !== 'win32') {
        throw new ManagedResourcePathError(`Could not remove folder link: ${link}`, { cause: error });
      }
      // Windows junctions can refuse unlink; rmdir removes the junction, not its target.
      try {
        await fs.rmdir(linkAbsolute);
      } catch (rmdirError) {
        throw new ManagedResourcePathError(`Could not remove folder link: ${link}`, { cause: rmdirError });
      }
    }
  }

  /**
   * Obsidian's desktop `rmdir(path, false)` is `fs.rm` without `recursive`, which
   * refuses every directory. `fs.rmdir` removes only an empty one.
   */
  async #removeEmptyFolder(normalized: string): Promise<void> {
    const desktopAdapter = this.#getDesktopAdapter();
    if (!desktopAdapter) {
      await this.adapter.rmdir(normalized, false);
      return;
    }
    await fs.rmdir(this.#resolveManagedDesktopPath(path.resolve(desktopAdapter.getBasePath()), normalized));
  }

  /** Obsidian's desktop `mkdir` is recursive and succeeds when the folder exists. */
  async #createFolderExclusive(normalized: string): Promise<void> {
    const desktopAdapter = this.#getDesktopAdapter();
    if (!desktopAdapter) {
      await this.adapter.mkdir(normalized);
      return;
    }
    await fs.mkdir(this.#resolveManagedDesktopPath(path.resolve(desktopAdapter.getBasePath()), normalized));
  }

  #requireDesktopBasePath(): string {
    const desktopAdapter = this.#getDesktopAdapter();
    if (!desktopAdapter) {
      throw new ManagedResourcePathError('Folder links require a filesystem-backed vault adapter');
    }
    return path.resolve(desktopAdapter.getBasePath());
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
