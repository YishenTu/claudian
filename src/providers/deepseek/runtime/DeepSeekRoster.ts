import { type DeepSeekRemoteClient, isRecord } from '../remote/DeepSeekRemoteClient';

export interface DeepSeekAgentRow {
  readonly id: string;
  /** Owning parent of a native subagent. Forks name their source as native parent but are independent roots. */
  readonly parent?: string;
  readonly available: boolean;
  readonly running: boolean;
}

type Deliver = (event: Record<string, unknown>) => void;

/**
 * The Host's only subscriber to process-global streams: session roster, control projections and
 * client events. Claimed roots receive the interactions of every agent they own natively.
 */
export class DeepSeekRoster {
  private readonly rows = new Map<string, DeepSeekAgentRow>();
  private readonly projections = new Map<string, Record<string, unknown>>();
  private readonly roots = new Map<string, Deliver>();
  private readonly unrouted = new Map<string, Record<string, unknown>>();
  private readonly changeListeners = new Set<() => void>();
  private readonly resetListeners = new Set<() => void>();
  private subscriptions: Array<() => void> = [];
  private generation = 0;
  private listed = false;
  private baselined = false;

  constructor(private readonly client: DeepSeekRemoteClient, private readonly onFailure: (error: Error) => void) {}

  get ready(): boolean { return this.listed && this.baselined; }

  /** Opens one baseline generation. Call again after the client reconnects. */
  async start(): Promise<void> {
    this.clear();
    const generation = ++this.generation;
    const pending: unknown[] = [];
    const fail = (error: Error): void => { if (generation === this.generation) this.onFailure(error); };
    this.subscriptions.push(this.client.onEvent(event => {
      if (generation !== this.generation) return;
      if (this.listed) this.event(event); else pending.push(event);
    }));
    this.subscriptions.push(this.client.subscribe('session/control', {}, value => {
      if (generation !== this.generation) return;
      if (!isRecord(value)) throw new Error('Malformed DeepSeek control state.');
      if (value.type === 'baseline' && isRecord(value.value) && isRecord(value.value.projections)) {
        this.projections.clear();
        for (const [id, projection] of Object.entries(value.value.projections)) {
          if (isRecord(projection) && isRecord(projection.values)) this.projections.set(id, projection.values);
        }
        this.baselined = true;
      } else if (value.type === 'projection' && typeof value.sessionId === 'string' && typeof value.key === 'string') {
        const values = this.projections.get(value.sessionId) ?? {};
        values[value.key] = value.value; this.projections.set(value.sessionId, values);
      } else throw new Error('Malformed DeepSeek control frame.');
      this.changed();
    }, fail));
    const roster = await this.client.call('session/list', { _request: {} });
    if (generation !== this.generation) return;
    if (!isRecord(roster) || !Array.isArray(roster.items)) throw new Error('Malformed DeepSeek session roster.');
    for (const item of roster.items) this.upsert(item);
    this.listed = true;
    for (const event of pending) this.event(event);
    this.changed();
  }

  /** The transport dropped: all baselines and outstanding native interactions are void. */
  reset(): void {
    ++this.generation;
    this.clear();
    for (const listener of this.resetListeners) listener();
    this.changed();
  }

  row(id: string): DeepSeekAgentRow | undefined { return this.rows.get(id); }
  allRows(): Iterable<DeepSeekAgentRow> { return this.rows.values(); }
  projection(id: string): Record<string, unknown> | undefined { return this.projections.get(id); }

  /** Nearest claimed ancestor-or-self: the root that owns this agent's work. */
  owner(id: string): string | undefined {
    const seen = new Set<string>();
    for (let current: string | undefined = id; current && !seen.has(current); current = this.rows.get(current)?.parent) {
      if (this.roots.has(current)) return current;
      seen.add(current);
    }
    return undefined;
  }

  /** Exclusive claim of a native session within this Host. */
  claim(rootId: string, deliver: Deliver): () => void {
    if (this.roots.has(rootId)) throw new Error('This DeepSeek conversation is already open in another Claudian view.');
    this.roots.set(rootId, deliver);
    this.changed();
    return () => {
      if (this.roots.get(rootId) !== deliver) return;
      this.roots.delete(rootId);
      this.changed();
    };
  }

  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  onReset(listener: () => void): () => void { this.resetListeners.add(listener); return () => this.resetListeners.delete(listener); }

  dispose(): void {
    ++this.generation; this.clear(); this.roots.clear();
    this.changeListeners.clear(); this.resetListeners.clear();
  }

  private clear(): void {
    for (const off of this.subscriptions.splice(0)) off();
    this.listed = false; this.baselined = false;
    this.rows.clear(); this.projections.clear(); this.unrouted.clear();
  }

  private upsert(value: unknown): void {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.running !== 'boolean'
      || typeof value.agentAvailable !== 'boolean') throw new Error('Malformed DeepSeek session row.');
    this.rows.set(value.sessionId, {
      id: value.sessionId, available: value.agentAvailable, running: value.running,
      ...(value.origin === 'subagent' && typeof value.parentSessionId === 'string' ? { parent: value.parentSessionId } : {}),
    });
  }

  private event(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === 'waterfall' && typeof value.eventId === 'string') {
      if (value.event === 'approval/request' || value.event === 'user-questions/request') this.unrouted.set(value.eventId, value);
    } else if (value.type === 'cancel' && typeof value.eventId === 'string') {
      // Owners ignore unknown identities; a never-routed request simply disappears.
      this.unrouted.delete(value.eventId);
      for (const deliver of [...this.roots.values()]) deliver(value);
    } else if (Array.isArray(value.args)) {
      const [first, second] = value.args as unknown[];
      if (value.event === 'api-session/added') this.upsert(first);
      const row = typeof first === 'string' ? this.rows.get(first) : undefined;
      if (row && value.event === 'api-session/status' && typeof second === 'boolean') this.rows.set(row.id, { ...row, running: second });
      if (row && value.event === 'api-session/removed') this.rows.set(row.id, { ...row, available: false, running: false });
    }
    this.changed();
  }

  private changed(): void {
    // Interactions can precede the roster rows of their agents; route them once ownership is known.
    for (const [eventId, event] of this.unrouted) {
      const owner = typeof event.agentId === 'string' ? this.owner(event.agentId) : undefined;
      if (!owner) continue;
      this.unrouted.delete(eventId);
      this.roots.get(owner)!(event);
    }
    for (const listener of [...this.changeListeners]) listener();
  }
}
