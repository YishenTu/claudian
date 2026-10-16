import type { SessionToolRoutedCallRequest } from '@/core/session-tools/SessionToolEndpoint';
import type { SessionToolResult } from '@/core/session-tools/sessionToolSpecs';

import { type DeepSeekRemoteClient, isRecord } from '../remote/DeepSeekRemoteClient';

export interface DeepSeekAgentRow {
  readonly id: string;
  /** Owning parent of a native subagent. Forks name their source as native parent but are independent roots. */
  readonly parent?: string;
  readonly available: boolean;
  readonly running: boolean;
}

/** Captured synchronously at HTTP ingress; invoking later must retain this request's lifetime. */
export interface DeepSeekSessionToolAdmission {
  readonly signal: AbortSignal;
  invoke(): Promise<SessionToolResult>;
}

export type DeepSeekSessionToolCapture = (call: SessionToolRoutedCallRequest, deadline: number) => DeepSeekSessionToolAdmission | undefined;

// One budget covers roster discovery and execution-session follow reconciliation.
const SESSION_TOOL_DEADLINE_MS = 10_000;

type Deliver = (event: Record<string, unknown>) => void;

/**
 * The Host's only subscriber to process-global streams: session roster, control projections and
 * client events. Claimed roots receive the interactions of every agent they own natively.
 */
export class DeepSeekRoster {
  private readonly rows = new Map<string, DeepSeekAgentRow>();
  private readonly projections = new Map<string, Record<string, unknown>>();
  private readonly roots = new Map<string, { deliver: Deliver; sessionTools?: DeepSeekSessionToolCapture }>();
  private readonly unrouted = new Map<string, Record<string, unknown>>();
  private readonly changeListeners = new Set<() => void>();
  private readonly resetListeners = new Set<() => void>();
  private subscriptions: Array<() => void> = [];
  private generation = 0;
  private listed = false;
  private baselined = false;
  private ended = false;
  private resetting = false;

  constructor(private readonly client: DeepSeekRemoteClient, private readonly onFailure: (error: Error) => void) {}

  get ready(): boolean { return this.listed && this.baselined; }
  /** The Host is reconnecting after a dropped transport; its bounded budget ends in a new baseline or retirement. */
  get recovering(): boolean { return this.resetting; }
  /** The Host retired this process generation; its native work is gone and no reconnect follows. */
  get disposed(): boolean { return this.ended; }

  /** Opens one baseline generation. Call again after the client reconnects. */
  async start(signal?: AbortSignal): Promise<void> {
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
    const roster = await this.client.call('session/list', { _request: {} }, signal ? { signal } : {});
    if (generation !== this.generation) return;
    if (!isRecord(roster) || !Array.isArray(roster.items)) throw new Error('Malformed DeepSeek session roster.');
    for (const item of roster.items) this.upsert(item);
    this.listed = true;
    this.resetting = false;
    for (const event of pending) this.event(event);
    this.changed();
  }

  /** The transport dropped: all baselines and outstanding native interactions are void. */
  reset(): void {
    this.resetting = true;
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

  /** The roster alone resolves ancestry; sessions capture request lifetimes before any discovery wait. */
  callSessionTool(request: SessionToolRoutedCallRequest): Promise<SessionToolResult> {
    const denied: SessionToolResult = { isError: true, text: 'Unbound or ended Claudian session tool caller.' };
    const generation = this.generation;
    const deadline = Date.now() + SESSION_TOOL_DEADLINE_MS;
    const owner = this.ready ? this.owner(request.callerNativeId) : undefined;
    // These are immutable candidates for this invocation, not another ownership registry. The live claim and
    // authoritative roster must still agree before dispatch; a later claim or request cannot join this call.
    const candidates = [...this.roots].flatMap(([rootId, claim]) => {
      if (owner && owner !== rootId) return [];
      const admission = claim.sessionTools?.(request, deadline);
      return admission ? [{ rootId, claim, admission }] : [];
    });
    if (!candidates.length) return Promise.resolve(denied);
    return new Promise<SessionToolResult>(resolve => {
      let settled = false;
      const signals = new Set([request.signal, ...candidates.map(candidate => candidate.admission.signal)]);
      const finish = (candidate?: typeof candidates[number]): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer); off();
        for (const signal of signals) signal.removeEventListener('abort', reconcile);
        resolve(candidate ? candidate.admission.invoke() : denied);
      };
      const eligible = (candidate: typeof candidates[number]) => this.roots.get(candidate.rootId) === candidate.claim && !candidate.admission.signal.aborted;
      const reconcile = (): void => {
        if (generation !== this.generation || request.signal.aborted || Date.now() >= deadline) { finish(); return; }
        const owner = this.ready ? this.owner(request.callerNativeId) : undefined;
        if (owner) { finish(candidates.find(candidate => candidate.rootId === owner && eligible(candidate))); return; }
        if (!candidates.some(eligible)) finish();
      };
      const off = this.onChange(reconcile);
      const timer = window.setTimeout(() => finish(), Math.max(0, deadline - Date.now()));
      for (const signal of signals) signal.addEventListener('abort', reconcile, { once: true });
      reconcile();
    });
  }

  /** Exclusive claim of a native session within this Host. */
  claim(rootId: string, deliver: Deliver, sessionTools?: DeepSeekSessionToolCapture): () => void {
    if (this.roots.has(rootId)) throw new Error('This DeepSeek conversation is already open in another Claudian view.');
    const claim = { deliver, sessionTools };
    this.roots.set(rootId, claim);
    this.changed();
    return () => {
      if (this.roots.get(rootId) !== claim) return;
      this.roots.delete(rootId);
      this.changed();
    };
  }

  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  onReset(listener: () => void): () => void { this.resetListeners.add(listener); return () => this.resetListeners.delete(listener); }

  dispose(): void {
    this.ended = true; this.resetting = false;
    ++this.generation; this.clear(); this.roots.clear();
    this.changed();
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
      for (const { deliver } of [...this.roots.values()]) deliver(value);
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
      this.roots.get(owner)!.deliver(event);
    }
    for (const listener of [...this.changeListeners]) listener();
  }
}
