import { type DeepSeekRemoteClient, isRecord } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekRoster } from '../runtime/DeepSeekRoster';

export interface DeepSeekQueueItem {
  readonly id: string;
  readonly content: readonly unknown[];
  readonly source?: { readonly kind?: string; readonly rpcId?: string };
}
export interface DeepSeekJob { readonly id: string; readonly owner: string; readonly status: string }
export interface DeepSeekActiveAgent { readonly id: string; readonly parent?: string; readonly mode?: 'one-shot' | 'continuable'; readonly running: boolean }

interface Followed {
  mode?: 'one-shot' | 'continuable';
  ready: boolean;
  /** Latest of native status and follow turn boundaries; either stream may arrive first. */
  running: boolean;
  statusRunning: boolean;
  jobs?: DeepSeekJob[];
  readonly tools: Set<string>;
  off: () => void;
  offJobs?: () => void;
}

/** Authoritative projection of one claimed root and the native descendants it owns. */
export class DeepSeekSessionObserver {
  private readonly followed = new Map<string, Followed>();
  private readonly interactions = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly offRoster: Array<() => void> = [];
  private failure?: Error;

  constructor(
    private readonly client: DeepSeekRemoteClient,
    private readonly roster: DeepSeekRoster,
    readonly rootId: string,
    private readonly onFollow: (sessionId: string, frame: Record<string, unknown>) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    this.offRoster.push(this.roster.onChange(() => this.reconcile()));
    // A reconnect voids every follow stream; reconcile re-follows once the roster rebaselines.
    this.offRoster.push(this.roster.onReset(() => { this.unfollowAll(); this.interactions.clear(); }));
    this.reconcile();
    await this.waitUntil(() => this.isReady(), 30_000, signal);
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  isReady(): boolean {
    return this.roster.ready && !!this.roster.row(this.rootId) && this.ownedIds().every(id => {
      const state = this.followed.get(id);
      return (id !== this.rootId && !this.roster.row(id)?.available) || (!!state?.ready && state.jobs !== undefined);
    });
  }

  hasWork(): boolean {
    return !this.isReady() || this.ownedIds().some(id => this.running(id) || (this.followed.get(id)?.tools.size ?? 0) > 0
      || this.queuedItems(id).length > 0 || this.followed.get(id)?.jobs?.some(job => isLiveJob(job.status)))
      || [...this.interactions.values()].some(id => this.owns(id));
  }

  permissionBoundaryAvailable(): boolean {
    return this.isReady() && !this.ownedIds().some(id => this.running(id) || (this.followed.get(id)?.tools.size ?? 0) > 0)
      && ![...this.interactions.values()].some(id => this.owns(id));
  }

  owns(id: string): boolean { return this.roster.owner(id) === this.rootId; }

  ownedJobs(): DeepSeekJob[] { return this.ownedIds().flatMap(id => this.followed.get(id)?.jobs ?? []).filter(job => isLiveJob(job.status)); }

  activeAgents(): DeepSeekActiveAgent[] {
    return this.ownedIds().filter(id => id === this.rootId || this.roster.row(id)?.available).map(id => ({
      id, running: this.running(id), mode: this.followed.get(id)?.mode,
      ...(id !== this.rootId ? { parent: this.roster.row(id)?.parent } : {}),
    }));
  }

  queuedItems(id: string): DeepSeekQueueItem[] {
    if (!this.owns(id)) return [];
    const inbox = this.roster.projection(id)?.inbox;
    if (!isRecord(inbox)) return [];
    return ['next-turn', 'next-step'].flatMap(key => {
      const items = inbox[key];
      return Array.isArray(items) ? items.filter((item): item is DeepSeekQueueItem => isRecord(item)
        && typeof item.id === 'string' && Array.isArray(item.content)) : [];
    });
  }

  setInteraction(eventId: string, owner: string | undefined): void {
    if (owner) this.interactions.set(eventId, owner); else this.interactions.delete(eventId);
    this.changed();
  }

  async waitUntil(predicate: () => boolean, timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error('DeepSeek observation cancelled.');
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        window.clearTimeout(timer); off(); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = (): void => finish(new Error('DeepSeek observation cancelled.'));
      const off = this.onChange(() => {
        if (this.failure) finish(this.failure); else if (predicate()) finish();
      });
      const timer = window.setTimeout(() => finish(new Error('DeepSeek native state did not reconcile before the deadline.')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  dispose(): void {
    for (const off of this.offRoster.splice(0)) off();
    this.unfollowAll(); this.failure = new Error('DeepSeek observation disposed.');
    this.changed(); this.listeners.clear();
  }

  /** Root first, then descendants whose nearest claimed ancestor is this root. */
  private ownedIds(): string[] {
    const ids = [this.rootId];
    for (const row of this.roster.allRows()) if (row.id !== this.rootId && this.owns(row.id)) ids.push(row.id);
    return ids;
  }

  private running(id: string): boolean {
    const state = this.followed.get(id);
    return state ? state.running : !!this.roster.row(id)?.running;
  }

  private reconcile(): void {
    if (!this.roster.ready) { this.changed(); return; }
    const owned = new Set(this.ownedIds());
    for (const [id, state] of this.followed) {
      const row = this.roster.row(id);
      if (!owned.has(id) || (id !== this.rootId && !row?.available)) { state.off(); state.offJobs?.(); this.followed.delete(id); continue; }
      if (row && row.running !== state.statusRunning) { state.statusRunning = row.running; state.running = row.running; }
    }
    for (const id of owned) {
      if (this.followed.has(id) || (id !== this.rootId && !this.roster.row(id)?.available)) continue;
      let mode: Followed['mode'];
      const parent = this.roster.row(id)?.parent;
      if (id !== this.rootId) {
        const catalog = parent ? this.roster.projection(parent)?.subagentCatalog : undefined;
        const descriptor: unknown = Array.isArray(catalog) ? catalog.find(item => isRecord(item) && item.id === id) : undefined;
        // The native catalog supplies the address discriminator. Never guess a mode or activate cold children.
        if (!isRecord(descriptor) || (descriptor.mode !== 'one-shot' && descriptor.mode !== 'continuable')) continue;
        mode = descriptor.mode;
      }
      this.follow(id, mode, parent);
    }
    this.changed();
  }

  private follow(id: string, mode: Followed['mode'], parent: string | undefined): void {
    // Unfollowing removes the entry and a re-follow creates new state, so identity fences stale streams.
    const live = (): boolean => this.followed.get(id) === state;
    const fail = (error: Error): void => {
      if (!live()) return;
      this.failure = error; this.changed(); this.onError(error);
    };
    const followJobs = (): (() => void) => this.client.subscribe('job/list', { request: { sessionId: id } }, frame => {
      if (!live()) return;
      if (!isRecord(frame) || frame.type !== 'rows' || !Array.isArray(frame.jobs)) throw new Error('Malformed DeepSeek jobs.');
      state.jobs = frame.jobs.filter((job): job is DeepSeekJob => isRecord(job) && job.owner === id
        && typeof job.id === 'string' && typeof job.status === 'string');
      this.changed();
    }, fail);
    const address = id === this.rootId ? { kind: 'session', sessionId: id }
      : { kind: 'subagent', childSessionId: id, parentSessionId: parent, mode };
    const statusRunning = !!this.roster.row(id)?.running;
    const state: Followed = { mode, ready: false, running: statusRunning, statusRunning, tools: new Set(), off: () => {} };
    this.followed.set(id, state);
    state.off = this.client.subscribe('session/follow', { request: { address, assistantStream: true } }, frame => {
      if (!live()) return;
      if (!isRecord(frame)) throw new Error('Malformed DeepSeek follow frame.');
      if (frame.type === 'snapshot') state.ready = true;
      if (frame.type === 'event' && isRecord(frame.event)) {
        const event = frame.event;
        const data = isRecord(event.data) ? event.data : {};
        if (event.type === 'turn/start') state.running = true;
        if (event.type === 'turn/end') {
          state.running = false; state.tools.clear();
          // job/list coalesces pushes; reacquire its immediate anchor before publishing quiescence.
          state.offJobs?.(); state.jobs = undefined; state.offJobs = followJobs();
        }
        if (event.type === 'tool/call' && typeof data.callId === 'string') state.tools.add(data.callId);
        if (event.type === 'tool/result' && isRecord(data.message) && typeof data.message.toolCallId === 'string') state.tools.delete(data.message.toolCallId);
      }
      this.onFollow(id, frame); this.changed();
    }, fail);
    state.offJobs = followJobs();
  }

  private unfollowAll(): void {
    for (const state of this.followed.values()) { state.off(); state.offJobs?.(); }
    this.followed.clear();
  }

  private changed(): void { for (const listener of [...this.listeners]) listener(); }
}

function isLiveJob(status: string): boolean { return status === 'running' || status === 'stopping'; }
