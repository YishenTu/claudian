import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

import { type CollabProjectId, isCollabProjectId } from '@claudian/collab-protocol';

import {
  ensureCollabVaultDirectory,
  removeCollabFileDurably,
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import {
  decodeLocalCleanupRecord,
  type LocalCleanupRecord,
} from '@/app/collab/exit/LocalCleanupRecord';
import {
  decodePendingLeaveRecord,
  type PendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PENDING_LEAVE_DIRECTORY = '.claudian/collab/pending-leaves';
const RETIRED_CLEANUP_DIRECTORY = '.claudian/collab/retired-cleanups';

export interface PendingLeaveJournalPort {
  list(): Promise<readonly PendingLeaveRecord[]>;
  load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: PendingLeaveRecord): Promise<void>;
}

export interface RetiredCleanupJournalPort {
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(record: LocalCleanupRecord): Promise<void>;
}

function journalError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function recordPath(directory: string, projectId: CollabProjectId, reason: string): string {
  if (!isCollabProjectId(projectId)) throw journalError(reason);
  return `${directory}/${projectId}.json`;
}

class PendingLeaveJournal implements PendingLeaveJournalPort {
  constructor(private readonly vaultRoot: string) {}

  async load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null> {
    const relativePath = recordPath(
      PENDING_LEAVE_DIRECTORY,
      projectId,
      'pending-leave-project-id-invalid',
    );
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    let contents: string;
    try {
      contents = await readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw journalError('pending-leave-read-failed');
    }
    try {
      const record = decodePendingLeaveRecord(JSON.parse(contents));
      if (record.projectId !== projectId) throw new TypeError();
      return record;
    } catch {
      throw journalError('pending-leave-corrupt');
    }
  }

  async list(): Promise<readonly PendingLeaveRecord[]> {
    const directory = await resolveCollabVaultPath(this.vaultRoot, PENDING_LEAVE_DIRECTORY);
    const names = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw journalError('pending-leave-list-failed');
    });
    const records: PendingLeaveRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const projectId = name.slice(0, -5);
      if (!isCollabProjectId(projectId)) throw journalError('pending-leave-name-invalid');
      const record = await this.load(projectId);
      if (record) records.push(record);
    }
    return records;
  }

  async save(record: PendingLeaveRecord): Promise<void> {
    const decoded = decodePendingLeaveRecord(record);
    await ensureCollabVaultDirectory(this.vaultRoot, PENDING_LEAVE_DIRECTORY, {
      mode: 0o700,
      preserveExistingMode: true,
    });
    await writeCollabFileAtomically(
      this.vaultRoot,
      recordPath(
        PENDING_LEAVE_DIRECTORY,
        decoded.projectId,
        'pending-leave-project-id-invalid',
      ),
      `${JSON.stringify(decoded, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  remove(projectId: CollabProjectId): Promise<boolean> {
    return removeCollabFileDurably(
      this.vaultRoot,
      recordPath(
        PENDING_LEAVE_DIRECTORY,
        projectId,
        'pending-leave-project-id-invalid',
      ),
    );
  }
}

class RetiredCleanupJournal implements RetiredCleanupJournalPort {
  constructor(private readonly vaultRoot: string) {}

  async load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null> {
    const relativePath = recordPath(
      RETIRED_CLEANUP_DIRECTORY,
      projectId,
      'retired-cleanup-project-id-invalid',
    );
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    let contents: string;
    try {
      contents = await readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw journalError('retired-cleanup-read-failed');
    }
    try {
      const record = decodeLocalCleanupRecord(JSON.parse(contents));
      if (record.projectId !== projectId || record.purpose !== 'retire') throw new TypeError();
      return record;
    } catch {
      throw journalError('retired-cleanup-corrupt');
    }
  }

  async save(record: LocalCleanupRecord): Promise<void> {
    const decoded = decodeLocalCleanupRecord(record);
    if (decoded.purpose !== 'retire') throw journalError('retired-cleanup-purpose-invalid');
    await ensureCollabVaultDirectory(this.vaultRoot, RETIRED_CLEANUP_DIRECTORY, {
      mode: 0o700,
      preserveExistingMode: true,
    });
    await writeCollabFileAtomically(
      this.vaultRoot,
      recordPath(
        RETIRED_CLEANUP_DIRECTORY,
        decoded.projectId,
        'retired-cleanup-project-id-invalid',
      ),
      `${JSON.stringify(decoded, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  remove(projectId: CollabProjectId): Promise<boolean> {
    return removeCollabFileDurably(
      this.vaultRoot,
      recordPath(
        RETIRED_CLEANUP_DIRECTORY,
        projectId,
        'retired-cleanup-project-id-invalid',
      ),
    );
  }

  async listProjectIds(): Promise<readonly CollabProjectId[]> {
    let directory: string;
    try {
      directory = await resolveCollabVaultPath(this.vaultRoot, RETIRED_CLEANUP_DIRECTORY, {
        mustExist: true,
      });
    } catch (error) {
      if (error instanceof CollabError && error.code === 'project-not-found') return [];
      throw error;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw journalError('retired-cleanup-list-failed');
    }
    return entries.flatMap(entry => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return [];
      const projectId = entry.name.slice(0, -'.json'.length);
      return isCollabProjectId(projectId) ? [projectId] : [];
    }).sort();
  }
}

export class CollabLifecycleJournalStore {
  readonly pendingLeaves: PendingLeaveJournalPort;
  readonly retiredCleanups: RetiredCleanupJournalPort;

  constructor(vaultRoot: string) {
    this.pendingLeaves = new PendingLeaveJournal(vaultRoot);
    this.retiredCleanups = new RetiredCleanupJournal(vaultRoot);
  }
}
