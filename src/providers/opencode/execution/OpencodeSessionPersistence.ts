import type { ProviderSessionConfig } from '@/core/execution';

import type { OpencodeServerLease } from '../http/OpencodeServerService';

/** Native retention belongs to the execution session, across kernel replacements. */
export class OpencodeSessionPersistence {
  private readonly discard: boolean;
  // Independent of the lifecycle: the cleanup lease is released and reacquired while active,
  // and disposal reacquires it to delete owned sessions.
  private client: Promise<OpencodeServerLease> | null = null;
  private acquireClient: (() => Promise<OpencodeServerLease>) | null = null;
  private readonly sessionIds = new Set<string>();
  private readonly pending = new Set<Promise<string>>();
  private state: { phase: 'active' } | { phase: 'disposed'; disposal: Promise<void> } = { phase: 'active' };

  constructor(config: ProviderSessionConfig) {
    this.discard = config.nativePersistence === 'disabled-if-supported'
      || (config.nativePersistence === 'provider-default' && config.lifecycle === 'ephemeral');
  }

  async openSession(open: () => Promise<string>, acquire: () => Promise<OpencodeServerLease>): Promise<string> {
    if (this.#isDisposed()) throw new Error('OpenCode session persistence is disposed.');
    if (!this.discard) return open();
    // Keep one cleanup lease alive even when the execution kernel is replaced.
    this.acquireClient = acquire;
    await this.getClient();
    if (this.#isDisposed()) throw new Error('OpenCode session persistence is disposed.');
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

  /** An idle session retains its database identity, not a drained process generation. */
  async releaseClient(): Promise<void> {
    await this.settle();
    const client = this.client;
    this.client = null;
    await (await client?.catch(() => null))?.dispose();
  }

  dispose(): Promise<void> {
    if (this.state.phase === 'disposed') return this.state.disposal;
    const disposal = (async () => {
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
    this.state = { phase: 'disposed', disposal };
    return disposal;
  }

  #isDisposed(): boolean {
    return this.state.phase === 'disposed';
  }
}
