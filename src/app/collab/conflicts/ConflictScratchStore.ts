import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';

import { type CollabOperationId, isCollabOpaqueId } from '@claudian-collab/protocol';

import {
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  type ConflictResolutionRecord,
  decodeConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type ConflictPathOwner = Pick<
  CollabLocalProjectRepository,
  'ensurePrivateStateContainer' | 'getConflictDirectoryPath'
>;

function storeError(
  code: 'operation-failed' | 'workspace-boundary-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function requireOperationId(operationId: CollabOperationId): void {
  if (!isCollabOpaqueId(operationId)) {
    throw storeError('workspace-boundary-invalid', 'conflict-operation-id-invalid');
  }
}

export class ConflictScratchStore {
  constructor(
    private readonly vaultRoot: string,
    private readonly paths: ConflictPathOwner,
  ) {}

  async ensureContainer(): Promise<string> {
    await this.paths.ensurePrivateStateContainer();
    return ensureCollabVaultDirectory(
      this.vaultRoot,
      this.paths.getConflictDirectoryPath(),
      { mode: 0o700 },
    );
  }

  async save(record: ConflictResolutionRecord): Promise<void> {
    const normalized = decodeConflictResolutionRecord(record);
    await this.ensureOperationDirectory(normalized.operationId);
    await writeCollabFileAtomically(
      this.vaultRoot,
      this.stateRelativePath(normalized.operationId),
      `${JSON.stringify(normalized, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async load(operationId: CollabOperationId): Promise<ConflictResolutionRecord | null> {
    requireOperationId(operationId);
    const statePath = await resolveCollabVaultPath(
      this.vaultRoot,
      this.stateRelativePath(operationId),
    );
    let contents: string;
    try {
      contents = await readFile(statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw storeError('operation-failed', 'conflict-state-read-failed');
    }
    try {
      return decodeConflictResolutionRecord(JSON.parse(contents) as unknown);
    } catch {
      throw storeError('operation-failed', 'conflict-state-corrupt');
    }
  }

  async list(): Promise<readonly ConflictResolutionRecord[]> {
    const conflictDirectory = await resolveCollabVaultPath(
      this.vaultRoot,
      this.conflictDirectory(),
    );
    let entries: Dirent<string>[];
    try {
      entries = await readdir(conflictDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw storeError('operation-failed', 'conflict-directory-read-failed');
    }
    const operationIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isCollabOpaqueId(entry.name)) {
        throw storeError(
          'workspace-boundary-invalid',
          'conflict-operation-entry-invalid',
        );
      }
      operationIds.push(entry.name);
    }
    const records = (await Promise.all(operationIds.sort().map(operationId => (
      this.load(operationId)
    )))).filter((record): record is ConflictResolutionRecord => record !== null);
    records.sort((left, right) => (
      left.updatedAt < right.updatedAt
        ? -1
        : left.updatedAt > right.updatedAt
          ? 1
          : left.operationId.localeCompare(right.operationId)
    ));
    return records;
  }

  async recreateRepository(operationId: CollabOperationId): Promise<string> {
    await this.ensureOperationDirectory(operationId);
    const repositoryRelativePath = this.repositoryRelativePath(operationId);
    const repositoryPath = await resolveCollabVaultPath(
      this.vaultRoot,
      repositoryRelativePath,
    );
    const existing = await lstat(repositoryPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw storeError('operation-failed', 'conflict-repository-inspection-failed');
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw storeError(
          'workspace-boundary-invalid',
          'conflict-repository-boundary-invalid',
        );
      }
      try {
        await rm(repositoryPath, { recursive: true });
      } catch {
        throw storeError('operation-failed', 'conflict-repository-remove-failed');
      }
    }
    try {
      await mkdir(repositoryPath, { mode: 0o700 });
    } catch {
      throw storeError('operation-failed', 'conflict-repository-create-failed');
    }
    return repositoryPath;
  }

  async repositoryPath(operationId: CollabOperationId): Promise<string> {
    requireOperationId(operationId);
    return resolveCollabVaultPath(
      this.vaultRoot,
      this.repositoryRelativePath(operationId),
      { mustExist: true },
    );
  }

  async remove(operationId: CollabOperationId): Promise<boolean> {
    requireOperationId(operationId);
    const operationPath = await resolveCollabVaultPath(
      this.vaultRoot,
      this.operationRelativePath(operationId),
    );
    const existing = await lstat(operationPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw storeError('operation-failed', 'conflict-operation-inspection-failed');
    });
    if (!existing) return false;
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw storeError(
        'workspace-boundary-invalid',
        'conflict-operation-boundary-invalid',
      );
    }
    try {
      await rm(operationPath, { recursive: true });
      return true;
    } catch {
      throw storeError('operation-failed', 'conflict-operation-remove-failed');
    }
  }

  private async ensureOperationDirectory(operationId: CollabOperationId): Promise<string> {
    requireOperationId(operationId);
    await this.ensureContainer();
    return ensureCollabVaultDirectory(
      this.vaultRoot,
      this.operationRelativePath(operationId),
      { mode: 0o700 },
    );
  }

  private conflictDirectory(): string {
    return this.paths.getConflictDirectoryPath();
  }

  private operationRelativePath(operationId: CollabOperationId): string {
    return `${this.conflictDirectory()}/${operationId}`;
  }

  private repositoryRelativePath(operationId: CollabOperationId): string {
    return `${this.operationRelativePath(operationId)}/repository`;
  }

  private stateRelativePath(operationId: CollabOperationId): string {
    return `${this.operationRelativePath(operationId)}/state.json`;
  }
}
