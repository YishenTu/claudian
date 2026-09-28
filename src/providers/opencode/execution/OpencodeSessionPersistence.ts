import type { ProviderSessionConfig } from '@/core/execution';

import type { OpencodeServerLease } from '../http/OpencodeServerService';

/** Native retention belongs to the execution session, across kernel replacements. */
export class OpencodeSessionPersistence {
  private readonly discard: boolean;
  private client: Promise<OpencodeServerLease> | null = null;
  private acquireClient: (() => Promise<OpencodeServerLease>) | null = null;
  private readonly sessionIds = new Set<string>();
  private readonly pending = new Set<Promise<string>>();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(config: ProviderSessionConfig) {
    this.discard = config.nativePersistence === 'disabled-if-supported'
      || (config.nativePersistence === 'provider-default' && config.lifecycle === 'ephemeral');
  }

  databasePath(version: 1 | 2 | undefined, persistentPath?: string): string | undefined {
    // V2 needs the native database's saved credentials; V1 can use memory storage.
    return this.discard && version !== 2 ? ':memory:' : persistentPath;
  }

  async openSession(open: () => Promise<string>, acquire: () => Promise<OpencodeServerLease>): Promise<string> {
    if (this.disposed) throw new Error('OpenCode session persistence is disposed.');
    if (!this.discard) return open();
    // Keep one cleanup lease alive even when the execution kernel is replaced.
    this.acquireClient = acquire;
    await this.getClient();
    if (this.disposed) throw new Error('OpenCode session persistence is disposed.');
    const pending = open().then(id => { this.sessionIds.add(id); return id; });
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  private async getClient(): Promise<OpencodeServerLease> {
    const previous = this.client;
    const client = previous ? await previous.catch(() => null) : null;
    // Disposal and a pending open may both be recovering the same lease.
    if (previous !== this.client) return this.getClient();
    if (client?.isReusable()) return client;
    if (!this.acquireClient) throw new Error('OpenCode cleanup has no server binding.');
    const next = this.acquireClient();
    this.client = next;
    await client?.dispose();
    return next;
  }

  /** A late creation response must be owned before its transport can close. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await this.settle();
      const client = await (this.sessionIds.size > 0 ? this.getClient() : this.client)?.catch(() => null);
      if (!client) return;
      try {
        await Promise.all([...this.sessionIds].map(id => client.request(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)));
      } finally {
        this.sessionIds.clear();
        await client.dispose();
      }
    })();
    return this.disposal;
  }
}
