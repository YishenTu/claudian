import { readdir, readFile } from 'node:fs/promises';

import {
  type CollabProjectId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import {
  CLOUD_BOOTSTRAP_TRANSITION_PHASES,
  type CloudBootstrapTransitionRecord,
  type CloudBootstrapTransitionStorePort,
  decodeCloudBootstrapTransitionRecord,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import {
  createCollabFileExclusively,
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
  syncCollabVaultDirectoryDurably,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const TRANSITION_DIRECTORY = '.claudian/collab/cloud-bootstrap-transitions';
const TRANSITION_HISTORY_DIRECTORY = '.claudian/collab/cloud-bootstrap-transition-history';
const MAX_TRANSITION_BYTES = 128 * 1024;

function storeError(reason: string, projectId?: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['open-diagnostics'],
    safeContext: {
      ...(projectId === undefined ? {} : { projectId }),
      reason,
    },
  });
}

function recordPath(projectId: CollabProjectId): string {
  if (!isCollabProjectId(projectId)) {
    throw storeError('cloud-bootstrap-transition-project-id-invalid');
  }
  return `${TRANSITION_DIRECTORY}/${projectId}.json`;
}

function historyPath(projectId: CollabProjectId, attemptId: string): string {
  if (!isCollabProjectId(projectId) || !isCollabOpaqueId(attemptId)) {
    throw storeError('cloud-bootstrap-transition-history-identity-invalid', projectId);
  }
  return `${TRANSITION_HISTORY_DIRECTORY}/${projectId}/${attemptId}.json`;
}

function serialize(record: CloudBootstrapTransitionRecord): string {
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_TRANSITION_BYTES) {
    throw storeError('cloud-bootstrap-transition-too-large', record.projectId);
  }
  return contents;
}

function immutableIdentity(record: CloudBootstrapTransitionRecord): string {
  return JSON.stringify({
    attemptId: record.attemptId,
    createdAt: record.createdAt,
    developmentActorId: record.developmentActorId,
    kind: record.kind,
    manifest: record.manifest,
    manifestSha256: record.manifestSha256,
    memberId: record.memberId,
    newAuthority: record.newAuthority,
    oldAuthority: record.oldAuthority,
    projectId: record.projectId,
    repositoryIdentity: record.repositoryIdentity,
    schemaVersion: record.schemaVersion,
  });
}

function assertMonotonic(
  previous: CloudBootstrapTransitionRecord,
  next: CloudBootstrapTransitionRecord,
): void {
  const previousPhase = CLOUD_BOOTSTRAP_TRANSITION_PHASES.indexOf(previous.phase);
  const nextPhase = CLOUD_BOOTSTRAP_TRANSITION_PHASES.indexOf(next.phase);
  const attemptTransitionAllowed = previous.attemptState === next.attemptState
    || (previous.attemptState === 'pending'
      && (next.attemptState === 'activated' || next.attemptState === 'cancelled'));
  const fenceTransitionAllowed = previous.fence.state === next.fence.state
    || (previous.fence.state === 'active' && next.fence.state === 'host-stopped')
    || (previous.fence.state === 'active' && next.fence.state === 'released-before-activation')
    || (previous.fence.state === 'host-stopped'
      && (next.fence.state === 'released-before-activation' || next.fence.state === 'terminal'));
  const cleanupTransitionAllowed = previous.terminalCleanupCompleted
    === next.terminalCleanupCompleted
    || (!previous.terminalCleanupCompleted && next.terminalCleanupCompleted);
  if (
    immutableIdentity(previous) !== immutableIdentity(next)
    || nextPhase < previousPhase
    || !attemptTransitionAllowed
    || !fenceTransitionAllowed
    || !cleanupTransitionAllowed
    || next.updatedAt < previous.updatedAt
  ) {
    throw storeError('cloud-bootstrap-transition-not-monotonic', previous.projectId);
  }
}

export class CloudBootstrapTransitionStore implements CloudBootstrapTransitionStorePort {
  private readonly queue = new SerialTaskQueue();

  constructor(private readonly vaultRoot: string) {}

  create(
    record: CloudBootstrapTransitionRecord,
  ): Promise<CloudBootstrapTransitionRecord> {
    return this.queue.run(async () => {
      const decoded = decodeCloudBootstrapTransitionRecord(record);
      await ensureCollabVaultDirectory(this.vaultRoot, TRANSITION_DIRECTORY, {
        mode: 0o700,
        preserveExistingMode: true,
      });
      const created = await createCollabFileExclusively(
        this.vaultRoot,
        recordPath(decoded.projectId),
        serialize(decoded),
        { mode: 0o600 },
      );
      if (created) {
        await this.syncTransitionStorage();
        return decoded;
      }
      const existing = await this.loadUnlocked(decoded.projectId);
      if (
        existing?.attemptState === 'cancelled'
        && existing.terminalCleanupCompleted
        && decoded.attemptState === 'pending'
        && existing.attemptId !== decoded.attemptId
      ) {
        await this.archiveCancelled(existing);
        await writeCollabFileAtomically(
          this.vaultRoot,
          recordPath(decoded.projectId),
          serialize(decoded),
          { mode: 0o600 },
        );
        await this.syncTransitionStorage();
        return decoded;
      }
      if (!existing || immutableIdentity(existing) !== immutableIdentity(decoded)) {
        throw storeError('cloud-bootstrap-transition-conflict', decoded.projectId);
      }
      await this.syncTransitionStorage();
      return existing;
    });
  }

  load(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord | null> {
    return this.queue.run(() => this.loadUnlocked(projectId));
  }

  runWithLanHostStartGuard<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.queue.run(async () => {
      const record = await this.loadUnlocked(projectId);
      if (
        record?.fence.state === 'active'
        || record?.fence.state === 'host-stopped'
        || record?.fence.state === 'terminal'
      ) {
        throw storeError('cloud-bootstrap-host-fence-active', projectId);
      }
      return operation();
    });
  }

  list(): Promise<{
    readonly blockedProjectIds: readonly CollabProjectId[];
    readonly records: readonly CloudBootstrapTransitionRecord[];
    readonly retryRequired: boolean;
  }> {
    return this.queue.run(async () => {
      const directory = await resolveCollabVaultPath(this.vaultRoot, TRANSITION_DIRECTORY);
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw storeError('cloud-bootstrap-transition-list-failed');
      });
      const blockedProjectIds: CollabProjectId[] = [];
      const projectIds: CollabProjectId[] = [];
      let retryRequired = false;
      for (const entry of entries.sort((left, right) => (
        left.name.localeCompare(right.name, 'en-US')
      ))) {
        if (/^\..+\.tmp$/u.test(entry.name)) continue;
        const match = /^(.+)\.json$/u.exec(entry.name);
        if (!match || !isCollabProjectId(match[1])) {
          throw storeError('cloud-bootstrap-transition-directory-invalid');
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
          blockedProjectIds.push(match[1]);
          continue;
        }
        projectIds.push(match[1]);
      }
      const records: CloudBootstrapTransitionRecord[] = [];
      for (const projectId of projectIds) {
        try {
          const record = await this.loadUnlocked(projectId);
          if (record) records.push(record);
        } catch (error: unknown) {
          if (
            error instanceof CollabError
            && (
              error.safeContext.reason === 'cloud-bootstrap-transition-too-large'
              || error.safeContext.reason === 'cloud-bootstrap-transition-corrupt'
            )
          ) {
            blockedProjectIds.push(projectId);
            continue;
          }
          if (
            error instanceof CollabError
            && error.safeContext.reason === 'cloud-bootstrap-transition-read-failed'
          ) {
            blockedProjectIds.push(projectId);
            retryRequired = true;
            continue;
          }
          throw error;
        }
      }
      return Object.freeze({
        blockedProjectIds: Object.freeze(blockedProjectIds.sort((left, right) => (
          left.localeCompare(right, 'en-US')
        ))),
        records: Object.freeze(records),
        retryRequired,
      });
    });
  }

  save(record: CloudBootstrapTransitionRecord): Promise<void> {
    return this.queue.run(async () => {
      const decoded = decodeCloudBootstrapTransitionRecord(record);
      const previous = await this.loadUnlocked(decoded.projectId);
      if (!previous) {
        throw storeError('cloud-bootstrap-transition-not-found', decoded.projectId);
      }
      assertMonotonic(previous, decoded);
      await writeCollabFileAtomically(
        this.vaultRoot,
        recordPath(decoded.projectId),
        serialize(decoded),
        { mode: 0o600 },
      );
      await this.syncTransitionStorage();
    });
  }

  private async syncTransitionStorage(): Promise<void> {
    await syncCollabVaultDirectoryDurably(this.vaultRoot, TRANSITION_DIRECTORY);
    await syncCollabVaultDirectoryDurably(this.vaultRoot, '.claudian/collab');
  }

  private async loadUnlocked(
    projectId: CollabProjectId,
  ): Promise<CloudBootstrapTransitionRecord | null> {
    const relativePath = recordPath(projectId);
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    let contents: string;
    try {
      contents = await readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw storeError('cloud-bootstrap-transition-read-failed', projectId);
    }
    if (Buffer.byteLength(contents, 'utf8') > MAX_TRANSITION_BYTES) {
      throw storeError('cloud-bootstrap-transition-too-large', projectId);
    }
    try {
      const record = decodeCloudBootstrapTransitionRecord(JSON.parse(contents));
      if (record.projectId !== projectId) throw new TypeError();
      return record;
    } catch {
      throw storeError('cloud-bootstrap-transition-corrupt', projectId);
    }
  }

  private async archiveCancelled(record: CloudBootstrapTransitionRecord): Promise<void> {
    if (record.attemptState !== 'cancelled') {
      throw storeError('cloud-bootstrap-transition-history-state-invalid', record.projectId);
    }
    const directory = `${TRANSITION_HISTORY_DIRECTORY}/${record.projectId}`;
    await ensureCollabVaultDirectory(this.vaultRoot, directory, {
      mode: 0o700,
      preserveExistingMode: true,
    });
    const contents = serialize(record);
    const relativePath = historyPath(record.projectId, record.attemptId);
    const created = await createCollabFileExclusively(
      this.vaultRoot,
      relativePath,
      contents,
      { mode: 0o600 },
    );
    if (created) {
      await syncCollabVaultDirectoryDurably(this.vaultRoot, directory);
      await syncCollabVaultDirectoryDurably(
        this.vaultRoot,
        TRANSITION_HISTORY_DIRECTORY,
      );
      return;
    }
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    const existing = await readFile(absolutePath, 'utf8').catch(() => null);
    if (existing !== contents) {
      throw storeError('cloud-bootstrap-transition-history-conflict', record.projectId);
    }
    await syncCollabVaultDirectoryDurably(this.vaultRoot, directory);
    await syncCollabVaultDirectoryDurably(
      this.vaultRoot,
      TRANSITION_HISTORY_DIRECTORY,
    );
  }
}
