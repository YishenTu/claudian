import { PassThrough, Writable } from 'node:stream';

import type { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import type { JSONRPCError } from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexLaunchSpec } from '@/providers/codex/runtime/codexLaunchTypes';

type NativeProcessPort = Pick<CodexAppServerProcess, keyof CodexAppServerProcess>;
type ExitCallback = Parameters<CodexAppServerProcess['onExit']>[0];

/** A native JSON-RPC error payload, serialized before the client sees it. */
export class CodexNativeResponseError extends Error {
  constructor(readonly payload: JSONRPCError) {
    super(payload.message);
  }
}

/** Native app-server boundary shared by Codex execution and settings integration. */
export class CodexRuntimeHarness {
  readonly processes: CodexNativeTestProcess[] = [];
  launchKey = 'first';
  autoReconcile = false;
  threadCounter = 0;
  holdSkills = false;
  requestOverride: ((process: CodexNativeTestProcess, request: any) => boolean) | null = null;

  createProcess(target?: Pick<CodexLaunchSpec['target'], 'platformFamily' | 'platformOs'>): CodexNativeTestProcess {
    const process = new CodexNativeTestProcess(this, target);
    this.processes.push(process);
    return process;
  }

  reset(): void {
    this.processes.length = 0;
    this.launchKey = 'first';
    this.autoReconcile = false;
    this.threadCounter = 0;
    this.holdSkills = false;
    this.requestOverride = null;
    this.requestObservers.clear();
  }

  private readonly requestObservers = new Set<() => void>();

  receivedRequest(): void {
    for (const observe of this.requestObservers) observe();
  }

  waitForRequest(method: string, processIndex = 0, count = 1): Promise<CodexNativeTestProcess> {
    return new Promise(resolve => {
      const observe = () => {
        const process = this.processes[processIndex];
        if (!process || process.requests.filter(request => request.method === method).length < count) return;
        this.requestObservers.delete(observe);
        resolve(process);
      };
      this.requestObservers.add(observe);
      observe();
    });
  }

}

export class CodexNativeTestProcess implements NativeProcessPort {
  constructor(
    private readonly harness: CodexRuntimeHarness,
    private readonly target: Pick<CodexLaunchSpec['target'], 'platformFamily' | 'platformOs'> = { platformFamily: 'unix', platformOs: 'linux' },
  ) {}
  private readonly pendingResponses = new Map<string, (response: unknown) => void>();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly requests: Array<{ id: number; method: string; params: any }> = [];
  readonly exits = new Set<ExitCallback>();
  readonly turns = new Map<string, { id: string; status: string; items: unknown[] }>();
  readonly subscribed = new Set<string>();
  readonly unsubscribed = new Set<string>();
  readonly ephemeral = new Set<string>();
  readonly parents = new Map<string, string>();
  readonly instructions = new Map<string, string>();
  readonly turnInstructions: string[] = [];
  readonly turnCounts = new Map<string, number>();
  stderrText = '';
  alive = false;
  reconciled = false;
  readonly stdin = new Writable({
    write: (data, _encoding, callback) => {
      const request = JSON.parse(data.toString());
      if (request.id !== undefined) {
        this.requests.push(request);
        this.harness.receivedRequest();
        const respond = this.pendingResponses.get(String(request.id));
        if (respond) {
          this.pendingResponses.delete(String(request.id));
          respond(request.result);
          callback();
          return;
        }
        if (this.harness.requestOverride?.(this, request)) { callback(); return; }
        if (request.method === 'initialize') this.respond(request.id, {
          userAgent: 'codex/0.160.0',
          codexHome: this.target.platformFamily === 'windows' ? 'C:\\Users\\test\\.codex' : '/home/test/.codex',
          ...this.target,
        });
        if (request.method === 'model/list') this.respond(request.id, { data: [], nextCursor: null });
        if (request.method === 'plugin/reconcile' && this.harness.autoReconcile) this.completeReconcile();
        if (request.method === 'thread/start' || request.method === 'thread/resume') {
          const id = request.params.threadId ?? `thread-${++this.harness.threadCounter}`;
          if (!this.subscribed.has(id)) this.instructions.set(id, request.params.baseInstructions);
          this.subscribed.add(id);
          this.unsubscribed.delete(id);
          if (request.params.ephemeral) this.ephemeral.add(id);
          this.respond(request.id, { thread: { id, path: `/tmp/${id}.jsonl`, turns: [] }, sandbox: { type: 'dangerFullAccess' } });
        }
        if (request.method === 'turn/start') {
          this.turnInstructions.push(this.instructions.get(request.params.threadId) ?? '');
          const count = (this.turnCounts.get(request.params.threadId) ?? 0) + 1;
          this.turnCounts.set(request.params.threadId, count);
          const turn = { id: `turn-${request.params.threadId}${count === 1 ? '' : `-${count}`}`, status: 'inProgress', items: [] };
          this.turns.set(request.params.threadId, turn);
          this.respond(request.id, { turn });
        }
        if (request.method === 'turn/interrupt') {
          this.notify('turn/completed', { threadId: request.params.threadId, turn: { id: request.params.turnId || this.turns.get(request.params.threadId)?.id || 'startup', status: 'interrupted', items: [] } });
          this.notify('thread/status/changed', { threadId: request.params.threadId, status: { type: 'idle' } });
          this.respond(request.id, {});
        }
        if (request.method === 'thread/read') {
          if (request.params.includeTurns && this.ephemeral.has(request.params.threadId)) {
            this.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32600, message: 'ephemeral threads do not support includeTurns' } })}\n`);
          } else {
            const turn = this.turns.get(request.params.threadId);
            this.respond(request.id, { thread: { id: request.params.threadId, parentThreadId: this.parents.get(request.params.threadId) ?? null, status: { type: turn?.status === 'inProgress' ? 'active' : 'idle' }, ephemeral: this.ephemeral.has(request.params.threadId), turns: request.params.includeTurns && turn ? [turn] : [] } });
          }
        }
        if (request.method === 'thread/unsubscribe') {
          this.subscribed.delete(request.params.threadId);
          this.unsubscribed.add(request.params.threadId);
          this.respond(request.id, { status: 'unsubscribed' });
        }
        if (request.method === 'skills/list' && !this.harness.holdSkills) this.respond(request.id, {
          data: [{ cwd: '/vault', skills: this.reconciled ? [{
            name: 'remote-skill', path: '/plugins/remote/SKILL.md', scope: 'user', enabled: true,
          }] : [] }],
        });
      }
      if (request.id === undefined) this.notifications.push(request);
      callback();
    },
  });
  start(): void { this.alive = true; }
  isAlive(): boolean { return this.alive; }
  getStderrSnapshot(): string { return this.stderrText; }
  onExit(callback: ExitCallback): void { this.exits.add(callback); }
  offExit(callback: ExitCallback): void { this.exits.delete(callback); }
  async shutdown(): Promise<void> { if (this.alive) this.exit(); }
  exit(): void {
    this.alive = false;
    for (const callback of [...this.exits]) callback(null, null);
  }
  requestFromServer(id: string, method: string, params: unknown): Promise<unknown> {
    return new Promise(resolve => {
      this.pendingResponses.set(id, resolve);
      this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }
  respondWhen(id: number, response: Promise<unknown>): void {
    void response.then(
      result => { if (this.isAlive()) this.respond(id, result); },
      error => {
        if (!this.isAlive()) return;
        const payload = error instanceof CodexNativeResponseError
          ? error.payload
          : { code: -32603, message: error instanceof Error ? error.message : String(error) };
        this.stdout.write(`${JSON.stringify({ id, error: payload })}\n`);
      },
    );
  }
  respondError(id: number, message: string, code = -32603): void {
    this.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }
  notify(method: string, params: unknown = {}): void {
    if (method === 'turn/started' || method === 'turn/completed') {
      const event = params as { threadId: string; turn: { id: string; status: string; items: unknown[] } };
      this.turns.set(event.threadId, event.turn);
    }
    const threadId = (params as { threadId?: string }).threadId;
    if (threadId && this.unsubscribed.has(threadId) && !['thread/status/changed', 'thread/closed'].includes(method)) return;
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
  completeReconcile(): void {
    this.reconciled = true;
    for (const request of this.requests.filter(request => request.method === 'plugin/reconcile')) {
      this.respond(request.id, {});
    }
  }
}

