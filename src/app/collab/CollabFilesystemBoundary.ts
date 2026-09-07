import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { CollabError } from '@/core/collab/ClaudianCollabError';

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export interface CollabFilesystemDiagnostic {
  readonly code: 'directory-sync-unavailable' | 'permissions-not-applied';
  readonly path: string;
}

export type CollabFilesystemDiagnosticSink = (
  diagnostic: CollabFilesystemDiagnostic,
) => void;

interface CollabGuardOptions {
  readonly privateContainer?: boolean;
  readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
  readonly preserveExistingDirectoryMode?: boolean;
}

interface CollabAtomicWriteOptions {
  readonly mode?: number;
  readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
}

function filesystemError(
  code:
    | 'path-invalid'
    | 'path-outside-project'
    | 'workspace-boundary-invalid'
    | 'operation-failed',
  reason: string,
  relativePath?: string,
): CollabError {
  return new CollabError({
    code,
    safeContext: {
      reason,
      ...(relativePath === undefined ? {} : { relativePath }),
    },
    recoveryActions: code === 'path-invalid' ? [] : ['open-diagnostics'],
  });
}

function validateVaultRelativePath(relativePath: string): readonly string[] {
  if (
    relativePath.length === 0
    || relativePath.startsWith('/')
    || relativePath.startsWith('\\\\')
    || WINDOWS_ABSOLUTE_PATH.test(relativePath)
    || relativePath.includes('\\')
  ) {
    throw filesystemError('path-invalid', 'vault-path-must-be-relative');
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw filesystemError('path-invalid', 'invalid-vault-path-segment');
  }
  return segments;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function applyModeBestEffort(
  absolutePath: string,
  relativePath: string,
  mode: number,
  onDiagnostic?: CollabFilesystemDiagnosticSink,
): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(absolutePath, mode);
  } catch {
    onDiagnostic?.({ code: 'permissions-not-applied', path: relativePath });
  }
}

async function syncDirectoryBestEffort(
  absolutePath: string,
  relativePath: string,
  onDiagnostic?: CollabFilesystemDiagnosticSink,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    onDiagnostic?.({ code: 'directory-sync-unavailable', path: relativePath });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function syncCollabVaultDirectoryDurably(
  vaultRoot: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = await resolveCollabVaultPath(
    vaultRoot,
    relativePath,
    { mustExist: true },
  );
  await syncDirectoryDurably(absolutePath, relativePath);
}

async function syncDirectoryDurably(
  absolutePath: string,
  relativePath: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    throw filesystemError('operation-failed', 'directory-sync-required', relativePath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegularFileWithoutFollowingLinks(
  absolutePath: string,
  relativePath: string,
  mode: number,
  onDiagnostic?: CollabFilesystemDiagnosticSink,
): Promise<string | null> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (handle === null) return null;
  try {
    const [handleStat, pathStat] = await Promise.all([
      handle.stat(),
      lstat(absolutePath),
    ]);
    if (
      !handleStat.isFile()
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || handleStat.dev !== pathStat.dev
      || handleStat.ino !== pathStat.ino
    ) {
      throw filesystemError(
        'workspace-boundary-invalid',
        'guard-file-boundary-invalid',
        relativePath,
      );
    }
    if (process.platform !== 'win32') {
      await handle.chmod(mode).catch(() => {
        onDiagnostic?.({ code: 'permissions-not-applied', path: relativePath });
      });
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function resolveCollabVaultPath(
  vaultRoot: string,
  relativePath: string,
  options: { readonly mustExist?: boolean } = {},
): Promise<string> {
  const segments = validateVaultRelativePath(relativePath);
  const absoluteRoot = path.resolve(vaultRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    throw filesystemError('workspace-boundary-invalid', 'vault-root-unavailable');
  }

  let current = absoluteRoot;
  let missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (missing) continue;
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        throw filesystemError(
          'workspace-boundary-invalid',
          'symbolic-link-boundary',
          relativePath,
        );
      }
      const canonicalCurrent = await realpath(current);
      if (!isContainedPath(canonicalRoot, canonicalCurrent)) {
        throw filesystemError(
          'path-outside-project',
          'real-path-escapes-vault',
          relativePath,
        );
      }
    } catch (error) {
      if (error instanceof CollabError) throw error;
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        missing = true;
        continue;
      }
      throw filesystemError('workspace-boundary-invalid', 'path-inspection-failed', relativePath);
    }
  }

  if (options.mustExist && missing) {
    throw new CollabError({
      code: 'project-not-found',
      safeContext: { relativePath },
    });
  }
  return path.join(absoluteRoot, ...segments);
}

export async function ensureCollabVaultDirectory(
  vaultRoot: string,
  relativePath: string,
  options: {
    readonly mode?: number;
    readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
    readonly preserveExistingMode?: boolean;
    readonly durable?: boolean;
  } = {},
): Promise<string> {
  const segments = validateVaultRelativePath(relativePath);
  const mode = options.mode ?? 0o755;
  let accumulated = '';
  for (const segment of segments) {
    const parentRelativePath = accumulated;
    accumulated = accumulated.length === 0 ? segment : `${accumulated}/${segment}`;
    const absolutePath = await resolveCollabVaultPath(vaultRoot, accumulated);
    let created = false;
    try {
      await mkdir(absolutePath, { mode });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw filesystemError('operation-failed', 'directory-create-failed', accumulated);
      }
      const stat = await lstat(absolutePath).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw filesystemError('workspace-boundary-invalid', 'directory-boundary-invalid', accumulated);
      }
    }
    if (created || !options.preserveExistingMode) {
      await applyModeBestEffort(absolutePath, accumulated, mode, options.onDiagnostic);
    }
    if (options.durable) {
      const parentAbsolutePath = parentRelativePath.length === 0
        ? path.resolve(vaultRoot)
        : await resolveCollabVaultPath(vaultRoot, parentRelativePath, { mustExist: true });
      await syncDirectoryDurably(absolutePath, accumulated);
      await syncDirectoryDurably(
        parentAbsolutePath,
        parentRelativePath.length === 0 ? '.' : parentRelativePath,
      );
    }
  }
  return resolveCollabVaultPath(vaultRoot, relativePath, { mustExist: true });
}

/** Creates one file without replacing an existing path. */
export async function createCollabFileExclusively(
  vaultRoot: string,
  relativePath: string,
  contents: string | Uint8Array,
  options: CollabAtomicWriteOptions = {},
): Promise<boolean> {
  const segments = validateVaultRelativePath(relativePath);
  const parentRelativePath = segments.slice(0, -1).join('/');
  if (parentRelativePath.length === 0) {
    throw filesystemError('workspace-boundary-invalid', 'exclusive-write-requires-parent');
  }
  const parentAbsolutePath = await resolveCollabVaultPath(
    vaultRoot,
    parentRelativePath,
    { mustExist: true },
  );
  const targetAbsolutePath = await resolveCollabVaultPath(vaultRoot, relativePath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    handle = await open(targetAbsolutePath, 'wx', options.mode ?? 0o600);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await applyModeBestEffort(
      targetAbsolutePath,
      relativePath,
      options.mode ?? 0o600,
      options.onDiagnostic,
    );
    await syncDirectoryBestEffort(
      parentAbsolutePath,
      parentRelativePath,
      options.onDiagnostic,
    );
    return true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    if (created) {
      await unlink(targetAbsolutePath).catch(() => undefined);
    }
    throw filesystemError('operation-failed', 'exclusive-write-failed', relativePath);
  }
}

export async function writeCollabFileAtomically(
  vaultRoot: string,
  relativePath: string,
  contents: string | Uint8Array,
  options: CollabAtomicWriteOptions = {},
): Promise<void> {
  const segments = validateVaultRelativePath(relativePath);
  const parentRelativePath = segments.slice(0, -1).join('/');
  if (parentRelativePath.length === 0) {
    throw filesystemError('workspace-boundary-invalid', 'atomic-write-requires-parent');
  }
  const parentAbsolutePath = await resolveCollabVaultPath(
    vaultRoot,
    parentRelativePath,
    { mustExist: true },
  );
  const targetAbsolutePath = await resolveCollabVaultPath(vaultRoot, relativePath);
  const tempName = `.${segments.at(-1)}.${randomUUID()}.tmp`;
  const tempRelativePath = `${parentRelativePath}/${tempName}`;
  const tempAbsolutePath = path.join(parentAbsolutePath, tempName);
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(tempAbsolutePath, 'wx', options.mode ?? 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await applyModeBestEffort(
      tempAbsolutePath,
      tempRelativePath,
      options.mode ?? 0o600,
      options.onDiagnostic,
    );
    await rename(tempAbsolutePath, targetAbsolutePath);
    await syncDirectoryBestEffort(
      parentAbsolutePath,
      parentRelativePath,
      options.onDiagnostic,
    );
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(tempAbsolutePath, { force: true }).catch(() => undefined);
    throw filesystemError('operation-failed', 'atomic-write-failed', relativePath);
  }
}

export async function removeCollabFileDurably(
  vaultRoot: string,
  relativePath: string,
  onDiagnostic?: CollabFilesystemDiagnosticSink,
): Promise<boolean> {
  const segments = validateVaultRelativePath(relativePath);
  const parentRelativePath = segments.slice(0, -1).join('/');
  if (parentRelativePath.length === 0) {
    throw filesystemError('workspace-boundary-invalid', 'durable-remove-requires-parent');
  }
  const absolutePath = await resolveCollabVaultPath(vaultRoot, relativePath);
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw filesystemError('operation-failed', 'file-remove-inspection-failed', relativePath);
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw filesystemError('workspace-boundary-invalid', 'file-remove-boundary-invalid', relativePath);
  }
  try {
    await unlink(absolutePath);
    const parentAbsolutePath = await resolveCollabVaultPath(
      vaultRoot,
      parentRelativePath,
      { mustExist: true },
    );
    await syncDirectoryBestEffort(parentAbsolutePath, parentRelativePath, onDiagnostic);
    return true;
  } catch {
    throw filesystemError('operation-failed', 'file-remove-failed', relativePath);
  }
}

export async function removeCollabDirectoryDurably(
  vaultRoot: string,
  relativePath: string,
  onDiagnostic?: CollabFilesystemDiagnosticSink,
): Promise<boolean> {
  const segments = validateVaultRelativePath(relativePath);
  const parentRelativePath = segments.slice(0, -1).join('/');
  if (parentRelativePath.length === 0) {
    throw filesystemError('workspace-boundary-invalid', 'durable-remove-requires-parent');
  }
  const absolutePath = await resolveCollabVaultPath(vaultRoot, relativePath);
  let directoryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryStat = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw filesystemError('operation-failed', 'directory-remove-inspection-failed', relativePath);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw filesystemError(
      'workspace-boundary-invalid',
      'directory-remove-boundary-invalid',
      relativePath,
    );
  }
  try {
    await rm(absolutePath, { recursive: true });
    const parentAbsolutePath = await resolveCollabVaultPath(
      vaultRoot,
      parentRelativePath,
      { mustExist: true },
    );
    await syncDirectoryBestEffort(parentAbsolutePath, parentRelativePath, onDiagnostic);
    return true;
  } catch {
    throw filesystemError('operation-failed', 'directory-remove-failed', relativePath);
  }
}

function withOneStandaloneGuard(contents: string): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /\r?\n$/.test(contents);
  const lines = contents.split(/\r?\n/);
  if (hasFinalNewline) lines.pop();
  const guardCount = lines.filter(line => line === '/*').length;
  if (guardCount === 1) return contents;
  if (guardCount === 0) {
    const separator = contents.length === 0 || hasFinalNewline ? '' : newline;
    return `${contents}${separator}/*${newline}`;
  }

  let guardSeen = false;
  const retained = lines.filter(line => {
    if (line !== '/*') return true;
    if (guardSeen) return false;
    guardSeen = true;
    return true;
  });
  return `${retained.join(newline)}${hasFinalNewline ? newline : ''}`;
}

export async function ensureCollabContainerGuard(
  vaultRoot: string,
  containerRelativePath: string,
  options: CollabGuardOptions = {},
): Promise<void> {
  const directoryMode = options.privateContainer ? 0o700 : 0o755;
  const fileMode = options.privateContainer ? 0o600 : 0o644;
  const containerAbsolutePath = await ensureCollabVaultDirectory(
    vaultRoot,
    containerRelativePath,
    {
      mode: directoryMode,
      onDiagnostic: options.onDiagnostic,
      preserveExistingMode: options.preserveExistingDirectoryMode,
    },
  );
  const guardRelativePath = `${containerRelativePath}/.gitignore`;
  const guardAbsolutePath = path.join(containerAbsolutePath, '.gitignore');
  let existing: string | null = null;
  try {
    existing = await readRegularFileWithoutFollowingLinks(
      guardAbsolutePath,
      guardRelativePath,
      fileMode,
      options.onDiagnostic,
    );
  } catch (error) {
    if (error instanceof CollabError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw filesystemError('operation-failed', 'guard-read-failed', guardRelativePath);
    }
  }

  if (existing === null) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(guardAbsolutePath, 'wx', fileMode);
      await handle.writeFile('/*\n');
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectoryBestEffort(
        containerAbsolutePath,
        containerRelativePath,
        options.onDiagnostic,
      );
      return;
    } catch {
      await handle?.close().catch(() => undefined);
      throw filesystemError('operation-failed', 'guard-create-failed', guardRelativePath);
    }
  }

  const guardedContents = withOneStandaloneGuard(existing);
  if (guardedContents !== existing) {
    await writeCollabFileAtomically(
      vaultRoot,
      guardRelativePath,
      guardedContents,
      { mode: fileMode, onDiagnostic: options.onDiagnostic },
    );
  }
}
