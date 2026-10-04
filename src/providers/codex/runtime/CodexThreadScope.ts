import type { CodexAppServerConnection, CodexAppServerLease } from './CodexAppServerRuntime';
import type { Thread, ThreadReadResult, Turn } from './codexAppServerTypes';
import { CodexRPCResponseError } from './CodexRPCTransport';
import type { CodexThreadClient, CodexThreadRelinquishResult } from './CodexThreadRouter';

export interface CodexThreadObserver {
  notification(method: string, params: unknown): void;
  serverRequest(id: string | number, method: string, params: unknown): Promise<unknown>;
  stop(): Promise<void>;
  workChanged(): void;
}

interface OwnedThread {
  readonly id: string;
  readonly parentId: string | null;
  state: 'idle' | 'starting' | 'active' | 'unknown';
  turnId: string | null;
  revision: number;
  subscribed: boolean;
  abandoned: boolean;
  readonly completed: Set<string>;
  readonly inputs: Set<() => void>;
  starting?: Promise<unknown>;
  stopping?: Promise<void>;
}

/** Native ownership outlives the attached chat, within one process generation. */
export class CodexThreadScope implements CodexThreadClient {
  private readonly threads = new Map<string, OwnedThread>();
  private observer: CodexThreadObserver | null;
  private lease: CodexAppServerLease | null;
  private openings = 0;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly connection: CodexAppServerConnection, observer: CodexThreadObserver) {
    this.observer = observer;
    this.lease = connection.retain();
    connection.threads.register(this);
  }

  get hasWork(): boolean {
    return this.openings > 0 || [...this.threads.values()].some(thread => thread.state !== 'idle' || thread.starting !== undefined || thread.stopping !== undefined);
  }

  get hasBackgroundWork(): boolean {
    return [...this.threads.values()].some(thread => thread.parentId !== null && thread.state !== 'idle');
  }

  claim(threadId: string): void { this.#adopt(threadId, null); }

  adoptChild(thread: Pick<Thread, 'id' | 'status'>, parentId: string): void {
    const child = this.#adopt(thread.id, parentId);
    if (thread.status.type === 'active') child.state = 'active';
    else this.#idle(child);
    if (this.stopped) void this.#stopThread(child);
    this.observer?.workChanged();
  }

  async open<T extends { thread: Thread }>(
    method: 'thread/start' | 'thread/resume' | 'thread/fork', params: unknown,
  ): Promise<T> {
    await this.waitUntilReady();
    const resumeId = method === 'thread/resume' ? (params as { threadId: string }).threadId : null;
    if (resumeId) {
      const thread = this.#adopt(resumeId, null);
      if (thread.subscribed) {
        await this.connection.transport.request('thread/unsubscribe', { threadId: resumeId });
        thread.subscribed = false;
      }
    }
    this.openings++;
    let abandoned = false;
    const native = this.connection.transport.request<T>(method, params, 0).then(result => {
      this.connection.assertAlive();
      const thread = this.#adopt(result.thread.id, null);
      thread.abandoned = abandoned;
      thread.subscribed = true;
      if (this.stopped || abandoned) void this.#stopThread(thread);
      return result;
    }).finally(() => { this.openings--; this.#releaseIdleLease(); });
    // Keep observing native identity after the caller's deadline. Transport has
    // no thread-lifetime policy; this owner cleans up an abandoned result.
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        abandoned = true;
        reject(new Error(`Request timeout: ${method} (30000ms)`));
      }, 30_000);
      void native.then(result => { window.clearTimeout(timer); resolve(result); }, error => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.stopping;
    if (!this.observer) throw new Error('Codex thread scope is detached.');
    if (this.stopped && this.hasWork) throw new Error('The previous Codex work is still stopping. Retry when it finishes.');
  }

  async beforeTurn(): Promise<void> {
    await this.waitUntilReady();
    this.stopped = false;
  }

  async startTurn<T>(method: 'turn/start' | 'thread/compact/start', params: { threadId: string } & Record<string, unknown>, releaseInput?: () => void): Promise<T> {
    const thread = this.#adopt(params.threadId, null);
    thread.state = 'starting';
    thread.turnId = null;
    thread.revision++;
    if (releaseInput) thread.inputs.add(releaseInput);
    const request = this.connection.transport.request<T>(method, params);
    thread.starting = request;
    try {
      const result = await request;
      const turn = (result as { turn?: Turn }).turn;
      if (thread.starting === request && turn && !thread.completed.has(turn.id)) {
        thread.turnId = turn.id;
        thread.state = 'active';
        thread.revision++;
      }
      return result;
    } catch (error) {
      if (thread.starting === request) {
        if (ambiguous(error)) thread.state = 'unknown';
        else this.#idle(thread);
      }
      throw error;
    } finally {
      if (thread.starting === request) {
        thread.starting = undefined;
        this.#releaseInputs(thread);
        if (this.stopped) void this.#stopThread(thread);
      }
      this.#releaseIdleLease();
      this.observer?.workChanged();
    }
  }

  async steer<T>(params: { threadId: string } & Record<string, unknown>, releaseInput: () => void): Promise<T> {
    const thread = this.#adopt(params.threadId, null);
    thread.inputs.add(releaseInput);
    try {
      const result = await this.connection.transport.request<T>('turn/steer', params);
      thread.inputs.delete(releaseInput);
      releaseInput();
      return result;
    } catch (error) {
      if (!ambiguous(error)) { thread.inputs.delete(releaseInput); releaseInput(); }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.observer) await this.observer.stop();
    await this.detach();
  }

  /** Stop retains the observer; detachment uses the same native cleanup path. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      // Known children can stop while a requested root start is awaiting identity.
      await Promise.all([...this.threads.values()].map(thread => this.#stopThread(thread)));
      await Promise.allSettled([...this.threads.values()].flatMap(thread => thread.starting ? [thread.starting] : []));
      await Promise.all([...this.threads.values()].map(thread => this.#stopThread(thread)));
    })().finally(() => { this.stopping = null; this.#releaseIdleLease(); });
    this.stopping = stopping;
    return stopping;
  }

  detach(): Promise<void> {
    if (this.closing) return this.closing;
    this.observer = null;
    this.closing = this.stop().then(async () => {
      await Promise.all([...this.threads.values()].map(thread => this.#unsubscribeIdle(thread)));
      this.#releaseIdleLease();
    });
    return this.closing;
  }

  /** Explicit reattachment may replace an inactive, detached cleanup observer. */
  relinquish(threadId: string, receiver: CodexThreadClient): CodexThreadRelinquishResult {
    const thread = this.threads.get(threadId);
    if (this.observer || !thread) return 'owned';
    if (this.openings) return 'stopping';
    const subtree = [thread];
    for (let i = 0; i < subtree.length; i++) {
      for (const child of this.threads.values()) {
        if (child.parentId === subtree[i].id) subtree.push(child);
      }
    }
    if (subtree.some(owned => owned.state !== 'idle' || owned.starting !== undefined || owned.stopping !== undefined)) return 'stopping';
    for (const owned of subtree) this.#forget(owned.id);
    for (const child of subtree.slice(1)) {
      receiver.adoptChild({ id: child.id, status: { type: 'idle' } }, child.parentId!);
    }
    return 'transferred';
  }

  serverRequest(id: string | number, method: string, params: unknown): Promise<unknown> {
    return this.observer?.serverRequest(id, method, params)
      ?? Promise.reject(new Error('Codex chat has closed.'));
  }

  notification(method: string, params: unknown): void {
    const data = params as { threadId?: string; thread?: Thread; turnId?: string; turn?: Turn; status?: { type: string }; item?: { type: string; agentThreadId?: string } };
    const id = data.threadId ?? data.thread?.id;
    const thread = id ? this.threads.get(id) : undefined;
    if (!thread) return;
    const turnId = data.turn?.id ?? data.turnId;
    if (method === 'item/completed' && data.item?.type === 'subAgentActivity' && data.item.agentThreadId) {
      const child = this.#adopt(data.item.agentThreadId, thread.id);
      child.abandoned ||= thread.abandoned;
      if (this.stopped || child.abandoned) void this.#stopThread(child);
      else void this.#readState(child);
    }
    if (turnId && thread.completed.has(turnId) && data.item?.type !== 'subAgentActivity') return;
    if (method === 'turn/started') {
      thread.turnId = turnId ?? null;
      thread.state = 'active';
      thread.revision++;
    } else if (method === 'turn/completed') {
      if (turnId) thread.completed.add(turnId);
      if (!thread.turnId || thread.turnId === turnId) this.#idle(thread);
    } else if (method === 'thread/status/changed') {
      if (data.status?.type === 'active') { thread.state = 'active'; thread.revision++; }
      else if (data.status && (!thread.starting || this.stopped)) this.#idle(thread);
    } else if (method === 'thread/closed') {
      this.#idle(thread);
      this.#forget(thread.id);
    }
    if ((this.stopped || thread.abandoned) && thread.state === 'active') void this.#stopThread(thread);
    if (!thread.abandoned && !(this.stopped && thread.parentId === null && turnId)) this.observer?.notification(method, params);
    this.observer?.workChanged();
  }

  closed(): void {
    for (const thread of this.threads.values()) this.#idle(thread);
    this.threads.clear();
    this.observer = null;
    void this.lease?.release();
    this.lease = null;
  }

  #adopt(threadId: string, parentId: string | null): OwnedThread {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    this.connection.threads.claim(threadId, this);
    const thread: OwnedThread = { id: threadId, parentId, state: parentId === null ? 'idle' : 'unknown', turnId: null, revision: 0, subscribed: parentId !== null, abandoned: false, completed: new Set(), inputs: new Set() };
    this.threads.set(threadId, thread);
    return thread;
  }

  #stopThread(thread: OwnedThread): Promise<void> {
    if (thread.stopping) return thread.stopping;
    if (!this.connection.isAlive()) return Promise.resolve();
    const observedRevision = thread.revision;
    const stopping = (async () => {
      if (thread.starting && !thread.turnId) return;
      if (thread.state === 'unknown' && !await this.#readState(thread)) return;
      if (thread.state === 'active' || thread.state === 'starting') {
        this.lease ??= this.connection.retain();
        const revision = thread.revision;
        const turnId = thread.turnId;
        try {
          await this.connection.transport.request('turn/interrupt', { threadId: thread.id, turnId: turnId ?? '' });
          // Empty-ID interrupts acknowledge submission only. Global idle/closed
          // notifications remain observable even after unsubscribe.
          if (turnId && revision === thread.revision) this.#idle(thread);
        } catch {
          await this.#readState(thread);
        }
      }
      await this.#unsubscribeIdle(thread);
    })().finally(() => {
      thread.stopping = undefined;
      if ((this.stopped || thread.abandoned) && thread.state === 'active' && thread.revision !== observedRevision) void this.#stopThread(thread);
      this.#releaseIdleLease();
      this.observer?.workChanged();
    });
    thread.stopping = stopping;
    return stopping;
  }

  async #readState(thread: OwnedThread): Promise<boolean> {
    const revision = thread.revision;
    try {
      const { thread: native } = await this.connection.transport.request<ThreadReadResult>('thread/read', { threadId: thread.id, includeTurns: false });
      if (revision === thread.revision) {
        if (native.status.type === 'active') thread.state = 'active';
        else this.#idle(thread);
      }
      return true;
    } catch (error) {
      if (error instanceof CodexRPCResponseError && /no rollout found|thread not (?:found|loaded)/i.test(error.message)) {
        this.#idle(thread);
        return true;
      }
      return false;
    } finally {
      this.observer?.workChanged();
    }
  }

  async #unsubscribeIdle(thread: OwnedThread): Promise<void> {
    if ((this.observer && !thread.abandoned) || thread.state !== 'idle' || !thread.subscribed || !this.connection.isAlive()) return;
    thread.subscribed = false;
    await this.connection.transport.request('thread/unsubscribe', { threadId: thread.id }).catch(() => undefined);
    // Keep only this scope's status ownership until thread/closed or explicit
    // reattachment. It carries no idle process lease or UI references.
  }

  #idle(thread: OwnedThread): void {
    if (this.stopped && thread.turnId) thread.completed.add(thread.turnId);
    thread.state = 'idle';
    thread.turnId = null;
    thread.revision++;
    this.#releaseInputs(thread);
    if (!this.observer) void this.#unsubscribeIdle(thread);
    this.#releaseIdleLease();
  }

  #releaseInputs(thread: OwnedThread): void {
    // A status snapshot can precede the pending start's native acceptance.
    if (this.connection.isAlive() && (thread.state !== 'idle' || thread.starting)) return;
    for (const release of thread.inputs) release();
    thread.inputs.clear();
  }

  #releaseIdleLease(): void {
    if (this.observer || this.hasWork) return;
    const lease = this.lease;
    this.lease = null;
    void lease?.release().catch(() => undefined);
    if (!this.threads.size) this.connection.threads.release(this);
  }

  #forget(threadId: string): void {
    this.threads.delete(threadId);
    this.connection.threads.release(this, threadId);
    this.#releaseIdleLease();
  }
}

/** Only a native error response proves the request was not applied. */
function ambiguous(error: unknown): boolean {
  return !(error instanceof CodexRPCResponseError);
}
