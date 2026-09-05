import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { isCollabProjectId } from '@claudian-collab/protocol';

import {
  createCollabFileExclusively,
  ensureCollabContainerGuard,
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
  syncCollabVaultDirectoryDurably,
} from '@/app/collab/CollabFilesystemBoundary';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudProjectCredential {
  readonly credential: string;
  readonly principalId: string;
}

function invalidCredential(): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason: 'cloud-vault-credential-unavailable' },
  });
}

export class CloudProjectCredentialStore {
  private readonly pending = new Map<string, Promise<CloudProjectCredential>>();

  constructor(private readonly vaultRoot: string) {}

  async require(projectId: string): Promise<CloudProjectCredential> {
    const value = await this.read(projectId);
    if (value === null) throw invalidCredential();
    return value;
  }

  getOrCreate(projectId: string): Promise<CloudProjectCredential> {
    const existing = this.pending.get(projectId);
    if (existing) return existing;
    const operation = this.loadOrCreate(projectId).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, operation);
    return operation;
  }

  private async loadOrCreate(projectId: string): Promise<CloudProjectCredential> {
    const existing = await this.read(projectId);
    if (existing !== null) return existing;
    const relativePath = this.relativePath(projectId);
    await ensureCollabContainerGuard(this.vaultRoot, '.claudian/collab', { privateContainer: true });
    await ensureCollabVaultDirectory(this.vaultRoot, '.claudian/collab/cloud-credentials', {
      mode: 0o700,
      durable: true,
    });
    await createCollabFileExclusively(this.vaultRoot, relativePath, JSON.stringify({
      schemaVersion: 1,
      projectId,
      credential: randomBytes(32).toString('hex'),
    }));
    return this.require(projectId);
  }

  private relativePath(projectId: string): string {
    if (!isCollabProjectId(projectId)) throw invalidCredential();
    return `.claudian/collab/cloud-credentials/${projectId}.json`;
  }

  private async read(projectId: string): Promise<CloudProjectCredential | null> {
    const relativePath = this.relativePath(projectId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const file = await resolveCollabVaultPath(this.vaultRoot, relativePath);
      try {
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 512) throw invalidCredential();
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidCredential();
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).length !== 3
        || record.schemaVersion !== 1
        || record.projectId !== projectId
        || typeof record.credential !== 'string'
        || !/^[0-9a-f]{64}$/u.test(record.credential)
      ) throw invalidCredential();
      await handle.sync();
      await syncCollabVaultDirectoryDurably(this.vaultRoot, '.claudian/collab/cloud-credentials');
      return Object.freeze({
        credential: record.credential,
        principalId: `vault-${createHash('sha256').update(record.credential, 'utf8').digest('hex')}`,
      });
    } catch {
      throw invalidCredential();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
