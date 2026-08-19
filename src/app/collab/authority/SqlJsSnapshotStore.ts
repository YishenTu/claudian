import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { CollabError } from '@/core/collab/ClaudianCollabError';

export type SqlJsSnapshotKind = 'backup' | 'primary' | 'temporary';

export interface SqlJsSnapshotStore {
  readCandidate(kind: SqlJsSnapshotKind): Promise<Uint8Array | null>;
  writeTemporary(contents: Uint8Array): Promise<void>;
  removeBackup(): Promise<void>;
  rotatePrimaryToBackup(): Promise<void>;
  removePrimary(): Promise<void>;
  promoteTemporary(): Promise<void>;
  syncDirectory(): Promise<void>;
}

const SNAPSHOT_NAMES: Readonly<Record<SqlJsSnapshotKind, string>> = {
  backup: 'collab.db.bak',
  primary: 'collab.db',
  temporary: 'collab.db.tmp',
};

function snapshotError(reason: string): CollabError {
  return new CollabError({
    code: 'database-corrupt',
    recoveryActions: ['open-diagnostics', 'export-repair-data'],
    safeContext: { reason },
  });
}

export class NodeSqlJsSnapshotStore implements SqlJsSnapshotStore {
  constructor(private readonly authorityDirectory: string) {}

  async readCandidate(kind: SqlJsSnapshotKind): Promise<Uint8Array | null> {
    const candidatePath = this.pathFor(kind);
    const candidateStat = await lstat(candidatePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw snapshotError('authority-snapshot-inspection-failed');
    });
    if (candidateStat === null) return null;
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw snapshotError('authority-snapshot-boundary-invalid');
    }
    try {
      return await readFile(candidatePath);
    } catch {
      throw snapshotError('authority-snapshot-read-failed');
    }
  }

  async writeTemporary(contents: Uint8Array): Promise<void> {
    await this.removeCandidate('temporary');
    const temporaryPath = this.pathFor('temporary');
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    } catch {
      await handle?.close().catch(() => undefined);
      throw snapshotError('authority-temporary-write-failed');
    }
  }

  removeBackup(): Promise<void> {
    return this.removeCandidate('backup');
  }

  async rotatePrimaryToBackup(): Promise<void> {
    try {
      await rename(this.pathFor('primary'), this.pathFor('backup'));
    } catch {
      throw snapshotError('authority-primary-rotation-failed');
    }
  }

  removePrimary(): Promise<void> {
    return this.removeCandidate('primary');
  }

  async promoteTemporary(): Promise<void> {
    try {
      await rename(this.pathFor('temporary'), this.pathFor('primary'));
    } catch {
      throw snapshotError('authority-temporary-promotion-failed');
    }
  }

  async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.authorityDirectory, fsConstants.O_RDONLY);
      await handle.sync();
    } catch {
      throw snapshotError('authority-directory-sync-failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private pathFor(kind: SqlJsSnapshotKind): string {
    return path.join(this.authorityDirectory, SNAPSHOT_NAMES[kind]);
  }

  private async removeCandidate(kind: SqlJsSnapshotKind): Promise<void> {
    const candidatePath = this.pathFor(kind);
    const candidateStat = await lstat(candidatePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw snapshotError('authority-snapshot-inspection-failed');
    });
    if (candidateStat === null) return;
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw snapshotError('authority-snapshot-boundary-invalid');
    }
    try {
      await rm(candidatePath);
    } catch {
      throw snapshotError('authority-snapshot-remove-failed');
    }
  }
}
