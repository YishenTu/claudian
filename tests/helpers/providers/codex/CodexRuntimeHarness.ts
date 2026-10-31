import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';

import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import type { JSONRPCError, LegacyDynamicToolSpec, UserInput } from '@/providers/codex/runtime/codexAppServerTypes';

import { codexThreadId } from './CodexRequests';

/** Native request fields exercised by this peer; other protocol fields remain opaque. */
export interface CodexNativeRequest {
  id: number;
  method: string;
  params: Record<string, unknown> & {
    threadId?: string;
    turnId?: string;
    baseInstructions?: string;
    input?: UserInput[];
    dynamicTools?: LegacyDynamicToolSpec[];
  };
}
interface CodexClientResponse { id: string; result?: unknown; error?: JSONRPCError }

/** A native JSON-RPC error payload, serialized before the client sees it. */
export class CodexNativeResponseError extends Error {
  constructor(readonly payload: JSONRPCError) {
    super(payload.message);
  }
}

/** Native app-server boundary shared by Codex execution and settings integration. */
export class CodexRuntimeHarness {
  readonly processes: CodexNativeTestProcess[] = [];
  autoReconcile = false;
  threadCounter = 0;
  holdSkills = false;
  requestOverride: ((process: CodexNativeTestProcess, request: CodexNativeRequest) => boolean) | null = null;

  createProcess(target?: Pick<TargetLaunchSpec['target'], 'platformFamily' | 'platformOs'>): CodexNativeTestProcess {
    const process = new CodexNativeTestProcess(this, target);
    this.processes.push(process);
    return process;
  }

  reset(): void {
    this.processes.length = 0;
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

  waitForRequest(method: string, processIndex = 0, count = 1, matches: (request: CodexNativeRequest) => boolean = () => true): Promise<CodexNativeTestProcess> {
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(1_000);
      const missing = () => {
        this.requestObservers.delete(observe);
        reject(new Error(`Missing Codex request ${method} (count ${count}, process ${processIndex}); received ${JSON.stringify(this.processes[processIndex]?.requests)}`));
      };
      const observe = () => {
        const process = this.processes[processIndex];
        if (!process || process.requests.filter(request => request.method === method && matches(request)).length < count) return;
        this.requestObservers.delete(observe);
        deadline.removeEventListener('abort', missing);
        resolve(process);
      };
      deadline.addEventListener('abort', missing, { once: true });
      this.requestObservers.add(observe);
      observe();
    });
  }

}

export class CodexNativeTestProcess extends ChildProcess implements ChildProcessWithoutNullStreams {
  constructor(
    private readonly harness: CodexRuntimeHarness,
    private readonly target: Pick<TargetLaunchSpec['target'], 'platformFamily' | 'platformOs'> = {
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
      platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    },
  ) { super(); }
  private readonly pendingResponses = new Map<string, (response: CodexClientResponse) => void>();
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly requests: CodexNativeRequest[] = [];
  readonly turns = new Map<string, { id: string; status: string; items: unknown[] }>();
  readonly subscribed = new Set<string>();
  readonly unsubscribed = new Set<string>();
  readonly ephemeral = new Set<string>();
  readonly parents = new Map<string, string>();
  readonly instructions = new Map<string, string>();
  readonly turnInstructions: string[] = [];
  readonly turnCounts = new Map<string, number>();
  override pid: number | undefined = 12345;
  override killed = false;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  reconciled = false;
  override readonly stdin = new Writable({
    write: (data, _encoding, callback) => {
      const message: CodexNativeRequest | CodexClientResponse | { method: string; params?: unknown } = JSON.parse(data.toString());
      if (!('method' in message)) {
        const respond = this.pendingResponses.get(message.id);
        this.pendingResponses.delete(message.id);
        respond?.(message);
        callback();
        return;
      }
      if ('id' in message) {
        const request = message;
        this.requests.push(request);
        this.harness.receivedRequest();
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
          if (!this.subscribed.has(id)) this.instructions.set(id, request.params.baseInstructions ?? '');
          this.subscribed.add(id);
          this.unsubscribed.delete(id);
          if (request.params.ephemeral) this.ephemeral.add(id);
          this.respond(request.id, { thread: { id, path: `/tmp/${id}.jsonl`, turns: [] }, sandbox: { type: 'dangerFullAccess' } });
        }
        if (request.method === 'turn/start') {
          const threadId = codexThreadId(request.params);
          this.turnInstructions.push(this.instructions.get(threadId) ?? '');
          const count = (this.turnCounts.get(threadId) ?? 0) + 1;
          this.turnCounts.set(threadId, count);
          const turn = { id: `turn-${threadId}${count === 1 ? '' : `-${count}`}`, status: 'inProgress', items: [] };
          this.turns.set(threadId, turn);
          this.respond(request.id, { turn });
        }
        if (request.method === 'turn/interrupt') {
          const threadId = codexThreadId(request.params);
          this.notify('turn/completed', { threadId, turn: { id: request.params.turnId || this.turns.get(threadId)?.id || 'startup', status: 'interrupted', items: [] } });
          this.notify('thread/status/changed', { threadId, status: { type: 'idle' } });
          this.respond(request.id, {});
        }
        if (request.method === 'thread/read') {
          const threadId = codexThreadId(request.params);
          if (request.params.includeTurns && this.ephemeral.has(threadId)) {
            this.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32600, message: 'ephemeral threads do not support includeTurns' } })}\n`);
          } else {
            const turn = this.turns.get(threadId);
            this.respond(request.id, { thread: { id: threadId, parentThreadId: this.parents.get(threadId) ?? null, status: { type: turn?.status === 'inProgress' ? 'active' : 'idle' }, ephemeral: this.ephemeral.has(threadId), turns: request.params.includeTurns && turn ? [turn] : [] } });
          }
        }
        if (request.method === 'thread/unsubscribe') {
          const threadId = codexThreadId(request.params);
          this.subscribed.delete(threadId);
          this.unsubscribed.add(threadId);
          this.respond(request.id, { status: 'unsubscribed' });
        }
        if (request.method === 'skills/list' && !this.harness.holdSkills) this.respond(request.id, {
          data: [{ cwd: '/vault', skills: this.reconciled ? [{
            name: 'remote-skill', path: '/plugins/remote/SKILL.md', scope: 'user', enabled: true,
          }] : [] }],
        });
      }
      if (!('id' in message)) this.notifications.push(message);
      callback();
    },
  });
  override readonly stdio: ChildProcessWithoutNullStreams['stdio'] = [this.stdin, this.stdout, this.stderr, null, null];
  isAlive(): boolean { return this.exitCode === null && this.signalCode === null; }
  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (!this.isAlive()) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
  requestFromServer(id: string, method: string, params: unknown): Promise<CodexClientResponse> {
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
