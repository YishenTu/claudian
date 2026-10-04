import { existsSync, readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { testClock } from '@test/helpers/testClock';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';
import { createCodexPathMapper } from '@/providers/codex/runtime/CodexPathMapper';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

const mockProcesses: FakeProcess[] = [];
let mockLaunchKey = 'first';
let mockAutoReconcile = false;
let mockThreadCounter = 0;
let mockHoldSkills = false;
let mockRequestOverride: ((process: FakeProcess, request: any) => boolean) | null = null;
const target = { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' } as const;

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => {
    const process = new FakeProcess();
    mockProcesses.push(process);
    return process;
  }),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => ({
  ...jest.requireActual('@/providers/codex/runtime/codexAppServerSupport'),
  resolveCodexAppServerLaunchSpec: jest.fn(async () => ({
    command: 'codex', args: ['app-server'], env: { KEY: mockLaunchKey }, spawnCwd: '/vault', targetCwd: '/vault',
    target, pathMapper: createCodexPathMapper(target),
  })),
}));

class FakeProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<{ id: number; method: string; params: any }> = [];
  readonly exits = new Set<() => void>();
  readonly turns = new Map<string, { id: string; status: string; items: unknown[] }>();
  readonly subscribed = new Set<string>();
  readonly unsubscribed = new Set<string>();
  readonly ephemeral = new Set<string>();
  readonly parents = new Map<string, string>();
  readonly instructions = new Map<string, string>();
  readonly turnInstructions: string[] = [];
  readonly turnCounts = new Map<string, number>();
  alive = false;
  reconciled = false;
  readonly stdin = new Writable({
    write: (data, _encoding, callback) => {
      const request = JSON.parse(data.toString());
      if (request.id !== undefined) {
        this.requests.push(request);
        if (mockRequestOverride?.(this, request)) { callback(); return; }
        if (request.method === 'initialize') this.respond(request.id, {
          userAgent: 'codex/0.160.0', codexHome: '/home/test/.codex',
          platformFamily: 'unix', platformOs: 'linux',
        });
        if (request.method === 'model/list') this.respond(request.id, { data: [], nextCursor: null });
        if (request.method === 'plugin/reconcile' && mockAutoReconcile) this.completeReconcile();
        if (request.method === 'thread/start' || request.method === 'thread/resume') {
          const id = request.params.threadId ?? `thread-${++mockThreadCounter}`;
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
        if (request.method === 'skills/list' && !mockHoldSkills) this.respond(request.id, {
          data: [{ cwd: '/vault', skills: this.reconciled ? [{
            name: 'remote-skill', path: '/plugins/remote/SKILL.md', scope: 'user', enabled: true,
          }] : [] }],
        });
      }
      callback();
    },
  });
  start(): void { this.alive = true; }
  isAlive(): boolean { return this.alive; }
  getStderrSnapshot(): string { return ''; }
  onExit(callback: () => void): void { this.exits.add(callback); }
  offExit(callback: () => void): void { this.exits.delete(callback); }
  async shutdown(): Promise<void> {
    this.alive = false;
    for (const callback of [...this.exits]) callback();
  }
  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
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

describe('Codex shared runtime', () => {
  const runtimes: CodexAppServerRuntime[] = [];
  const plugin = { settings: { providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG } } } } as unknown as ProviderHost;
  function createRuntime(warn = jest.fn()): CodexAppServerRuntime {
    const runtime = new CodexAppServerRuntime(plugin, warn);
    runtimes.push(runtime);
    return runtime;
  }
  beforeEach(() => { mockProcesses.length = 0; mockLaunchKey = 'first'; mockAutoReconcile = false; mockThreadCounter = 0; mockHoldSkills = false; mockRequestOverride = null; });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  });

  async function waitForRequest(method: string, processIndex = 0): Promise<FakeProcess> {
    for (let count = 0; count < 100; count++) {
      const process = mockProcesses[processIndex];
      if (process?.requests.some(request => request.method === method)) return process;
      await Promise.resolve();
    }
    throw new Error(`Missing ${method} on process ${processIndex}`);
  }

  it('shares skill and model discovery and waits for plugin readiness only for skills', async () => {
    const runtime = createRuntime();
    const skills = new CodexSkillListingService(runtime);
    const models = new CodexModelDiscoveryService(plugin, runtime);
    const listing = skills.listSkills();
    try {
      await models.discoverModels();
      expect(mockProcesses).toHaveLength(1);
      const process = mockProcesses[0];
      expect(process.requests.filter(request => request.method === 'skills/list')).toHaveLength(0);
      process.completeReconcile();
      await expect(listing).resolves.toEqual([expect.objectContaining({ name: 'remote-skill' })]);
      await models.discoverModels();
      await skills.listSkills({ forceReload: true });
      expect(mockProcesses).toHaveLength(1);
      expect(process.requests.filter(request => request.method === 'plugin/reconcile')).toHaveLength(2);
      expect(process.isAlive()).toBe(true);
    } finally {
      mockProcesses.forEach(process => process.completeReconcile());
      await listing;
      await skills.dispose();
      await runtime.dispose();
      await Promise.all(mockProcesses.map(process => process.shutdown()));
    }
  });

  it('aborts one skill caller without cancelling shared startup or another caller', async () => {
    const runtime = createRuntime();
    const skills = new CodexSkillListingService(runtime);
    const abort = new AbortController();
    const cancelled = skills.listSkills({ signal: abort.signal });
    const surviving = skills.listSkills();
    const process = await waitForRequest('plugin/reconcile');
    abort.abort(new Error('Caller cancelled'));
    await expect(cancelled).rejects.toThrow('Caller cancelled');
    expect(process.isAlive()).toBe(true);
    process.completeReconcile();
    await expect(surviving).resolves.toEqual([expect.objectContaining({ name: 'remote-skill' })]);
    expect(mockProcesses).toHaveLength(1);
    await skills.dispose();
    expect(process.isAlive()).toBe(true);
  });

  it('keeps skill lookups live across native notifications and process death', async () => {
    const runtime = createRuntime();
    const skills = new CodexSkillListingService(runtime);
    const first = skills.listSkills();
    const process = await waitForRequest('plugin/reconcile');
    process.completeReconcile();
    await first;
    await skills.listSkills();
    expect(process.requests.filter(request => request.method === 'skills/list')).toHaveLength(2);
    process.notify('skills/changed');
    await Promise.resolve();
    await skills.listSkills();
    expect(process.requests.filter(request => request.method === 'skills/list')).toHaveLength(3);
    await process.shutdown();
    expect(mockProcesses).toHaveLength(1);
    const restarted = skills.listSkills();
    const replacement = await waitForRequest('plugin/reconcile', 1);
    replacement.completeReconcile();
    await expect(restarted).resolves.toEqual([expect.objectContaining({ name: 'remote-skill' })]);
    await skills.dispose();
  });

  it('drains the old fingerprint while new consumers use its replacement', async () => {
    const runtime = createRuntime();
    const old = await runtime.acquire({ readiness: 'initialized' });
    mockLaunchKey = 'second';
    const replacement = await runtime.acquire({ readiness: 'initialized' });
    expect(mockProcesses).toHaveLength(2);
    expect(old.connection.isRetired()).toBe(true);
    expect(old.connection.isAlive()).toBe(true);
    expect(replacement.connection.isAlive()).toBe(true);
    await old.release();
    expect(old.connection.isAlive()).toBe(false);
    await replacement.release();
    expect(replacement.connection.isAlive()).toBe(true);
  });

  it.each(['unsupported', 'partial'])('warns once and allows skills after %s reconciliation', async failure => {
    const warn = jest.fn();
    const runtime = createRuntime(warn);
    const skills = new CodexSkillListingService(runtime);
    const listing = skills.listSkills();
    const process = await waitForRequest('plugin/reconcile');
    const request = process.requests.find(request => request.method === 'plugin/reconcile')!;
    if (failure === 'unsupported') {
      process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    } else {
      process.respond(request.id, { failedRemotePluginIds: ['failed-plugin'] });
    }
    await expect(listing).resolves.toEqual([]);
    await skills.listSkills({ forceReload: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(process.requests.filter(request => request.method === 'plugin/reconcile')).toHaveLength(2);
    expect(process.isAlive()).toBe(true);
    await skills.dispose();
  });

  it('rejects plugin waiters on disposal and never restarts a disposed runtime', async () => {
    const runtime = createRuntime();
    const pending = runtime.acquire();
    await waitForRequest('plugin/reconcile');
    await Promise.all([expect(pending).rejects.toThrow('closed'), runtime.dispose()]);
    await expect(runtime.acquire()).rejects.toThrow('disposed');
    expect(mockProcesses).toHaveLength(1);
    expect(mockProcesses[0].isAlive()).toBe(false);
  });

  const config: ProviderSessionConfig = {
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault',
    interactionPort: { requestApproval: jest.fn(), askUserQuestion: jest.fn(), dismissInteraction: jest.fn() },
  };
  const request: ProviderExecutionRequest = {
    input: [{ type: 'text', text: 'hello' }],
    configuration: { model: TEST_CODEX_MODEL, permissionMode: 'yolo', systemInstructions: { kind: 'explicit', instructions: 'Be concise.' } },
    toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
  };
  async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
    const result: ProviderExecutionEvent[] = [];
    for await (const event of events) result.push(event);
    return result;
  }
  function complete(process: FakeProcess, threadId: string): void {
    process.notify('turn/completed', { threadId, turn: { id: process.turns.get(threadId)?.id ?? `turn-${threadId}`, status: 'completed', items: [] } });
  }

  it('releases a completed ephemeral thread and lets its retired server drain', async () => {
    mockAutoReconcile = true;
    const runtime = createRuntime();
    const session = new CodexExecutionBackend(plugin, runtime).createSession({ ...config, nativePersistence: 'disabled-if-supported' });
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    complete(process, 'thread-1');
    await output;
    await session.dispose();
    expect(process.requests.filter(r => r.method === 'thread/unsubscribe').map(r => r.params.threadId)).toContain('thread-1');
    mockLaunchKey = 'replacement';
    const next = await runtime.acquire();
    expect(process.isAlive()).toBe(false);
    await next.release();
  });

  it('stops late native work through global status after closing and unsubscribing its chat', async () => {
    mockAutoReconcile = true;
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstOutput = collect(first.execute(request).events);
    const secondOutput = collect(second.execute(request).events);
    const process = await waitForRequest('turn/start');
    for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    complete(process, 'thread-1');
    await firstOutput;
    await first.dispose();
    expect(process.unsubscribed.has('thread-1')).toBe(true);
    let wokeAgain = false;
    mockRequestOverride = (native, rpc) => {
      if (rpc.method !== 'turn/interrupt' || rpc.params.threadId !== 'thread-1' || wokeAgain) return false;
      wokeAgain = true;
      native.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
      native.notify('turn/started', { threadId: 'thread-1', turn: { id: 'second-mail', status: 'inProgress', items: [] } });
      native.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } });
      native.respond(rpc.id, {});
      return true;
    };
    // Native turn events are subscription-scoped. Status remains broadcast.
    process.notify('turn/started', { threadId: 'thread-1', turn: { id: 'late-mail', status: 'inProgress', items: [] } });
    process.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).toContain('thread-1');
    expect(process.turns.get('thread-1')?.status).toBe('interrupted');
    // No parent item event survives unsubscribe. A grandchild can become visible
    // while discovery of its parent is still awaiting metadata.
    process.parents.set('late-child', 'thread-1');
    process.parents.set('late-grandchild', 'late-child');
    process.parents.set('other-child', 'thread-2');
    let childRead: number | undefined;
    mockRequestOverride = (_native, rpc) => {
      if (rpc.method !== 'thread/read' || rpc.params.threadId !== 'late-child') return false;
      childRead = rpc.id;
      return true;
    };
    for (const threadId of ['late-grandchild', 'late-child', 'other-child']) {
      process.notify('turn/started', { threadId, turn: { id: `turn-${threadId}`, status: 'inProgress', items: [] } });
      process.notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
    }
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(childRead).toBeDefined();
    mockRequestOverride = null;
    process.respond(childRead!, { thread: { id: 'late-child', parentThreadId: 'thread-1', status: { type: 'active' }, turns: [] } });
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(process.turns.get('late-child')?.status).toBe('interrupted');
    expect(process.turns.get('late-grandchild')?.status).toBe('interrupted');
    expect(process.turns.get('other-child')?.status).toBe('inProgress');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).not.toContain('thread-2');
    complete(process, 'thread-2');
    expect((await secondOutput).at(-1)?.type).toBe('turn_completed');
    expect(process.isAlive()).toBe(true);
    await second.dispose();
  });

  it('keeps copied fork history separate from the source chat’s child ownership', async () => {
    mockAutoReconcile = true;
    const runtime = createRuntime();
    const lease = await runtime.acquire();
    const observer = () => ({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    const source = lease.connection.createThreadScope(observer());
    const fork = lease.connection.createThreadScope(observer());
    const process = mockProcesses[0];
    await source.open('thread/start', {});
    process.parents.set('source-child', 'thread-1');
    process.notify('turn/started', { threadId: 'source-child', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
    process.notify('item/completed', { threadId: 'thread-1', turnId: 'source-turn', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'source-child', agentPath: '/root/worker' } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    const copiedHistory = [{ id: 'old-turn', status: 'completed', items: [{ type: 'subAgentActivity', id: 'old-spawn', kind: 'started', agentThreadId: 'source-child', agentPath: '/root/worker' }] }];
    mockRequestOverride = (native, rpc) => {
      if (rpc.method !== 'thread/fork' && rpc.method !== 'thread/resume') return false;
      native.respond(rpc.id, { thread: { id: 'fork-root', turns: copiedHistory, status: { type: 'idle' } } });
      return true;
    };
    await expect(fork.open('thread/fork', { threadId: 'thread-1' })).resolves.toMatchObject({ thread: { id: 'fork-root' } });
    await expect(fork.open('thread/resume', { threadId: 'fork-root' })).resolves.toMatchObject({ thread: { id: 'fork-root' } });
    await fork.detach();
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).not.toContain('source-child');
    await source.stop();
    expect(process.turns.get('source-child')?.status).toBe('interrupted');
    await source.detach();
    await lease.release();
  });

  it('transfers idle descendants when a closed chat is reopened before native unloading', async () => {
    mockAutoReconcile = true;
    const lease = await createRuntime().acquire();
    const observer = () => ({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    const original = lease.connection.createThreadScope(observer());
    const reopened = lease.connection.createThreadScope(observer());
    const process = mockProcesses[0];
    await original.open('thread/start', {});
    process.parents.set('existing-child', 'thread-1');
    process.notify('item/completed', { threadId: 'thread-1', turnId: 'old-turn', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'existing-child', agentPath: '/root/worker' } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    await original.detach();
    await reopened.open('thread/resume', { threadId: 'thread-1' });
    process.notify('turn/started', { threadId: 'existing-child', turn: { id: 'requested-child-turn', status: 'inProgress', items: [] } });
    process.notify('thread/status/changed', { threadId: 'existing-child', status: { type: 'active' } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(process.turns.get('existing-child')?.status).toBe('inProgress');
    expect(reopened.hasBackgroundWork).toBe(true);
    await reopened.stop();
    expect(process.turns.get('existing-child')?.status).toBe('interrupted');
    await reopened.detach();
    await lease.release();
  });

  it('asks for a retry when a chat is reopened while its closed predecessor is still stopping', async () => {
    mockAutoReconcile = true;
    const lease = await createRuntime().acquire();
    const observer = () => ({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    const original = lease.connection.createThreadScope(observer());
    const reopened = lease.connection.createThreadScope(observer());
    const process = mockProcesses[0];
    await original.open('thread/start', {});
    await original.startTurn('turn/start', { threadId: 'thread-1', input: [] });
    let interruptId: number | undefined;
    mockRequestOverride = (_native, rpc) => {
      if (rpc.method !== 'turn/interrupt') return false;
      interruptId = rpc.id;
      return true;
    };
    const closing = original.detach();
    await waitForRequest('turn/interrupt');

    await expect(reopened.open('thread/resume', { threadId: 'thread-1' })).rejects.toThrow(/still stopping/);

    mockRequestOverride = null;
    process.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-thread-1', status: 'interrupted', items: [] } });
    process.respond(interruptId!, {});
    await closing;
    await expect(reopened.open('thread/resume', { threadId: 'thread-1' })).resolves.toMatchObject({ thread: { id: 'thread-1' } });
    await reopened.detach();
    await lease.release();
  });

  it('keeps turn inputs while a start fails without a native response', async () => {
    mockAutoReconcile = true;
    const lease = await createRuntime().acquire();
    const scope = lease.connection.createThreadScope({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    await scope.open('thread/start', {});
    const process = mockProcesses[0];
    mockRequestOverride = (_native, rpc) => rpc.method === 'turn/start';
    const releaseInput = jest.fn();
    const starting = scope.startTurn('turn/start', { threadId: 'thread-1', input: [] }, releaseInput);
    await waitForRequest('turn/start');
    process.stdout.emit('error', new Error('read ECONNRESET'));

    await expect(starting).rejects.toThrow('read ECONNRESET');
    expect(releaseInput).not.toHaveBeenCalled();

    await process.shutdown();
    expect(releaseInput).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it.each([false, true])('retains turn inputs and the process while a start is unresolved despite an idle status (detach: %s)', async detach => {
    mockAutoReconcile = true;
    const runtime = createRuntime();
    const lease = await runtime.acquire();
    const scope = lease.connection.createThreadScope({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    await scope.open('thread/start', {});
    await lease.release();
    const process = mockProcesses[0];
    let startId: number | undefined;
    mockRequestOverride = (_native, rpc) => {
      if (rpc.method !== 'turn/start') return false;
      startId = rpc.id;
      return true;
    };
    const releaseInput = jest.fn();
    const starting = scope.startTurn('turn/start', { threadId: 'thread-1', input: [] }, releaseInput);
    const stopping = detach ? scope.detach() : scope.stop();
    process.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    mockLaunchKey = 'replacement';
    const replacement = await runtime.acquire();
    try {
      expect(process.isAlive()).toBe(true);
      expect(releaseInput).not.toHaveBeenCalled();
    } finally {
      process.respond(startId!, { turn: { id: 'late-start', status: 'inProgress', items: [] } });
      await starting;
      await stopping;
    }
    expect(releaseInput).toHaveBeenCalledTimes(1);
    await scope.detach();
    await replacement.release();
  });

  it('retires a drained server when the completed turn receives its delayed start response', async () => {
    mockAutoReconcile = true;
    let pendingStart: FakeProcess['requests'][number] | undefined;
    mockRequestOverride = (_process, rpc) => {
      if (rpc.method !== 'turn/start') return false;
      pendingStart = rpc;
      return true;
    };
    const runtime = createRuntime();
    const session = new CodexExecutionBackend(plugin, runtime).createSession(config);
    const events = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const turn = { id: 'delayed', status: 'inProgress', items: [] };
    process.notify('turn/started', { threadId: 'thread-1', turn });
    mockLaunchKey = 'replacement';
    const replacement = await runtime.acquire();
    try {
      expect(process.isAlive()).toBe(true);
      complete(process, 'thread-1');
      process.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
      expect((await events).at(-1)?.type).toBe('turn_completed');
      expect(process.isAlive()).toBe(true);
      process.respond(pendingStart!.id, { turn });
      for (let i = 0; i < 200 && process.isAlive(); i++) await Promise.resolve();
      expect(process.isAlive()).toBe(false);
      expect(mockProcesses[1].isAlive()).toBe(true);
    } finally {
      process.respond(pendingStart!.id, { turn });
      await session.dispose();
      await replacement.release();
    }
  });

  it('keeps the next turn’s image until its own pending start settles after an earlier response', async () => {
    mockAutoReconcile = true;
    const starts: FakeProcess['requests'] = [];
    mockRequestOverride = (_process, rpc) => {
      if (rpc.method !== 'turn/start') return false;
      starts.push(rpc);
      return true;
    };
    const session = new CodexExecutionBackend(plugin, createRuntime()).createSession(config);
    const firstEvents = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const firstTurn = { id: 'first', status: 'inProgress', items: [] };
    process.notify('turn/started', { threadId: 'thread-1', turn: firstTurn });
    complete(process, 'thread-1');
    expect((await firstEvents).at(-1)?.type).toBe('turn_completed');
    const second = session.execute({ ...request, input: [{ type: 'image', image: {
      id: 'image-1', name: 'pasted.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste',
    } }] });
    const secondEvents = collect(second.events);
    for (let i = 0; i < 100 && starts.length < 2; i++) await Promise.resolve();
    expect(starts).toHaveLength(2);
    const imageInput = starts[1].params.input.find((item: { type: string }) => item.type === 'localImage');
    const inputPath: string = imageInput.path;
    try {
      expect(readFileSync(inputPath)).toEqual(Buffer.from('hello'));
      process.respond(starts[0].id, { turn: firstTurn });
      for (let i = 0; i < 100; i++) await Promise.resolve();
      second.cancel();
      expect((await secondEvents).at(-1)?.type).toBe('cancelled');
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(existsSync(inputPath)).toBe(true);
    } finally {
      process.respond(starts[0].id, { turn: firstTurn });
      process.respond(starts[1].id, { turn: { id: 'second', status: 'inProgress', items: [] } });
      await session.dispose();
    }
    expect(existsSync(inputPath)).toBe(false);
    expect(process.isAlive()).toBe(true);
  });

  it('waits for plugin reconciliation before the first chat thread while models remain readable', async () => {
    const runtime = createRuntime();
    const session = new CodexExecutionBackend(plugin, runtime).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('plugin/reconcile');
    await new CodexModelDiscoveryService(plugin, runtime).discoverModels();
    expect(process.requests.filter(r => r.method === 'thread/start')).toHaveLength(0);
    process.completeReconcile();
    await waitForRequest('turn/start');
    expect(mockProcesses).toHaveLength(1);
    complete(process, 'thread-1');
    await output;
    await session.dispose();
  });

  it('routes a native approval exclusively to its owning chat', async () => {
    mockAutoReconcile = true;
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const approval = () => jest.fn(async interaction => ({ interactionId: interaction.interactionId, decision: 'allow' as const }));
    const firstApproval = approval();
    const secondApproval = approval();
    const first = backend.createSession({ ...config, interactionPort: { ...config.interactionPort, requestApproval: firstApproval } });
    const second = backend.createSession({ ...config, interactionPort: { ...config.interactionPort, requestApproval: secondApproval } });
    const output = [first, second].map(session => collect(session.execute(request).events));
    const process = await waitForRequest('turn/start');
    for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    process.stdout.write(`${JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-2', turnId: 'turn-thread-2', itemId: 'command', command: 'pwd', cwd: '/vault',
    } })}\n`);
    for (let i = 0; i < 100 && secondApproval.mock.calls.length === 0; i++) await Promise.resolve();
    expect(secondApproval).toHaveBeenCalledTimes(1);
    expect(firstApproval).not.toHaveBeenCalled();
    complete(process, 'thread-1');
    complete(process, 'thread-2');
    await Promise.all(output);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('refreshes instructions on a retained native thread that ignores subscribed resume overrides', async () => {
    mockAutoReconcile = true;
    const session = new CodexExecutionBackend(plugin, createRuntime()).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    complete(process, 'thread-1');
    await output;
    const changed = collect(session.execute({ ...request, configuration: {
      ...request.configuration, systemInstructions: { kind: 'explicit', instructions: 'Use the new rules.' },
    } }).events);
    for (let i = 0; i < 100 && process.turnInstructions.length < 2; i++) await Promise.resolve();
    expect(process.turnInstructions).toHaveLength(2);
    expect(process.turnInstructions[0]).toContain('Be concise.');
    expect(process.turnInstructions[1]).toContain('Use the new rules.');
    expect(process.turnInstructions[1]).not.toContain('Be concise.');
    complete(process, 'thread-1');
    await changed;
    expect(mockProcesses).toHaveLength(1);
    await session.dispose();
  });

  it('aborts an in-flight skills RPC without disrupting model discovery on the same transport', async () => {
    mockAutoReconcile = true;
    mockHoldSkills = true;
    const runtime = createRuntime();
    const skills = new CodexSkillListingService(runtime);
    const abort = new AbortController();
    const listing = skills.listSkills({ signal: abort.signal });
    const process = await waitForRequest('skills/list');
    abort.abort(new Error('Query cancelled'));
    await expect(listing).rejects.toThrow('Request aborted: skills/list');
    await expect(new CodexModelDiscoveryService(plugin, runtime).discoverModels()).resolves.toMatchObject({ kind: 'completed' });
    expect(mockProcesses).toHaveLength(1);
    expect(process.isAlive()).toBe(true);
    await skills.dispose();
  });

  it('keeps active execution through a workspace transition, resumes on the replacement, and disposes on disable', async () => {
    mockAutoReconcile = true;
    const registry = new ProviderExecutionLifecycleRegistry();
    const host = {
      ...plugin,
      settings: { providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG } } },
      executionLifecycleRegistry: registry,
    } as unknown as ProviderHost;
    const services = await createCodexWorkspaceServices(host);
    const backend = new CodexExecutionBackend(host, services.runtime);
    const first = registry.acquire(backend, config, 'chat');
    const firstEvents = collect(first.session.execute(request).events);
    try {
      const old = await waitForRequest('turn/start');
      await registry.runTransition(['codex'], async () => { mockLaunchKey = 'second'; });
      expect(first.isCurrent()).toBe(true);
      expect(old.isAlive()).toBe(true);
      const second = registry.acquire(backend, config, 'chat');
      const secondEvents = collect(second.session.execute(request).events);
      const replacement = await waitForRequest('turn/start', 1);
      complete(old, 'thread-1');
      expect(await firstEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      for (let i = 0; i < 100 && old.isAlive(); i++) await Promise.resolve();
      expect(old.isAlive()).toBe(false);
      const resumed = collect(first.session.execute(request).events);
      await waitForRequest('thread/resume', 1);
      for (let i = 0; i < 100 && replacement.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
      expect(replacement.requests.filter(r => r.method === 'turn/start')).toHaveLength(2);
      complete(replacement, 'thread-1');
      expect(await resumed).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      await registry.runTransition(['codex'], async () => { host.settings.providerConfigs.codex!.enabled = false; });
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(false);
      expect(await secondEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'cancelled' })]));
      expect(replacement.isAlive()).toBe(false);
    } finally {
      await registry.dispose();
      await services.dispose();
    }
  });

  it('fails active chats on a crash and resumes their persistent threads lazily on one replacement', async () => {
    mockAutoReconcile = true;
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const runs = [first, second].map(session => collect(session.execute(request).events));
    const process = await waitForRequest('turn/start');
    for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    await process.shutdown();
    const failed = await Promise.all(runs);
    expect(failed.map(events => events.at(-1)?.type)).toEqual(['execution_error', 'execution_error']);
    expect(mockProcesses).toHaveLength(1);
    const retries = [first, second].map(session => collect(session.execute(request).events));
    const replacement = await waitForRequest('turn/start', 1);
    for (let i = 0; i < 100 && replacement.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    expect(replacement.requests.filter(r => r.method === 'thread/resume').map(r => r.params.threadId).sort()).toEqual(['thread-1', 'thread-2']);
    expect(replacement.requests.filter(r => r.method === 'thread/start')).toHaveLength(0);
    complete(replacement, 'thread-1');
    complete(replacement, 'thread-2');
    const completed = await Promise.all(retries);
    expect(completed.map(events => events.at(-1)?.type)).toEqual(['turn_completed', 'turn_completed']);
    expect(mockProcesses).toHaveLength(2);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('allows retry when a cancelled turn completes before its late start response and interrupt rejection', async () => {
    mockAutoReconcile = true;
    let pendingStart: any;
    mockRequestOverride = (process, rpc) => {
      if (rpc.method === 'turn/start') {
        if (!pendingStart) pendingStart = rpc;
        else process.respond(rpc.id, { turn: { id: 'retry-turn', status: 'inProgress' } });
        return true;
      }
      if (rpc.method === 'turn/interrupt') {
        process.stdout.write(`${JSON.stringify({ id: rpc.id, error: { code: -32600, message: 'no active turn to interrupt' } })}\n`);
        return true;
      }
      return false;
    };
    const session = new CodexExecutionBackend(plugin, createRuntime()).createSession(config);
    const run = session.execute(request);
    const process = await waitForRequest('turn/start');
    run.cancel();
    complete(process, 'thread-1');
    process.respond(pendingStart.id, { turn: { id: 'turn-thread-1', status: 'inProgress' } });
    await collect(run.events);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const retry = collect(session.execute(request).events);
    for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    expect(process.requests.filter(r => r.method === 'turn/start')).toHaveLength(2);
    process.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'retry-turn', status: 'completed', items: [] } });
    expect((await retry).at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it.each([false, true])('stops owned children and late mailbox turns on Stop (parent completed: %s) while another chat continues', async (parentCompleted) => {
    mockAutoReconcile = true;
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstRun = first.execute(request);
    const firstOutput = collect(firstRun.events);
    const secondOutput = collect(second.execute(request).events);
    const process = await waitForRequest('turn/start');
    for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
    process.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-thread-1',
      item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' },
    });
    process.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
    process.notify('item/completed', {
      threadId: 'child', turnId: 'child-turn',
      item: { type: 'subAgentActivity', id: 'spawn-grandchild', kind: 'started', agentThreadId: 'grandchild', agentPath: '/root/worker/helper' },
    });
    process.notify('turn/started', { threadId: 'grandchild', turn: { id: 'grandchild-turn', status: 'inProgress', items: [] } });
    if (parentCompleted) {
      complete(process, 'thread-1');
      await firstOutput;
    }
    first.cancel();
    await firstOutput;
    for (let i = 0; i < 150; i++) await Promise.resolve();
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).toEqual(expect.arrayContaining(['child', 'grandchild']));
    expect(first.hasBackgroundWork?.()).toBe(false);
    expect(process.requests.filter(r => r.method === 'thread/unsubscribe')).toHaveLength(0);
    // Codex may already have queued mail that wakes a durably sleeping root.
    process.notify('turn/started', { threadId: 'thread-1', turn: { id: 'mailbox-turn', status: 'inProgress', items: [] } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.turnId)).toContain('mailbox-turn');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).not.toContain('thread-2');
    complete(process, 'thread-2');
    expect((await secondOutput).at(-1)?.type).toBe('turn_completed');
    expect(process.isAlive()).toBe(true);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('reads fresh skills without a local result cache or a loaded native thread', async () => {
    mockAutoReconcile = true;
    let diskSkill = 'first-skill';
    let nativeSkill = diskSkill;
    mockRequestOverride = (process, rpc) => {
      if (rpc.method !== 'skills/list') return false;
      if (rpc.params.forceReload) nativeSkill = diskSkill;
      process.respond(rpc.id, { data: [{ cwd: '/vault', skills: [{ name: nativeSkill, path: '/skills/SKILL.md', scope: 'user', enabled: true }] }] });
      return true;
    };
    const skills = new CodexSkillListingService(createRuntime());
    expect(await skills.listSkills()).toEqual([expect.objectContaining({ name: 'first-skill' })]);
    diskSkill = 'second-skill';
    expect(await skills.listSkills()).toEqual([expect.objectContaining({ name: 'second-skill' })]);
    expect(mockProcesses).toHaveLength(1);
    expect(mockProcesses[0].requests.filter(r => r.method === 'thread/start')).toHaveLength(0);
    await skills.dispose();
  });

  it('refreshes remote plugins in the background on the same server without delaying skills', async () => {
    mockAutoReconcile = true;
    const clock = testClock();
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock().getTime());
    const skills = new CodexSkillListingService(createRuntime());
    try {
      await skills.listSkills();
      const process = mockProcesses[0];
      mockAutoReconcile = false;
      clock.advance({ seconds: 31 });
      await expect(skills.listSkills()).resolves.toEqual([expect.objectContaining({ name: 'remote-skill' })]);
      await skills.listSkills();
      expect(process.requests.filter(r => r.method === 'plugin/reconcile')).toHaveLength(2);
      expect(mockProcesses).toHaveLength(1);
      process.completeReconcile();
    } finally {
      now.mockRestore();
      await skills.dispose();
    }
  });

  it.each([false, true])('stops and unsubscribes owned background children when a completed parent tab closes (late work: %s)', async (lateWork) => {
    mockAutoReconcile = true;
    const session = new CodexExecutionBackend(plugin, createRuntime()).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    process.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-thread-1',
      item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' },
    });
    process.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
    complete(process, 'thread-1');
    await output;
    expect(session.hasBackgroundWork?.()).toBe(true);
    if (lateWork) {
      mockRequestOverride = (native, rpc) => {
        if (rpc.method !== 'turn/interrupt' || rpc.params.threadId !== 'child') return false;
        native.notify('turn/started', { threadId: 'thread-1', turn: { id: 'late-root', status: 'inProgress', items: [] } });
        native.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'subAgentActivity', id: 'late-spawn', kind: 'started', agentThreadId: 'grandchild', agentPath: '/root/worker/helper' } });
        native.notify('turn/started', { threadId: 'grandchild', turn: { id: 'late-child', status: 'inProgress', items: [] } });
        return false;
      };
    }
    await session.dispose();
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.turnId))
      .toEqual(expect.arrayContaining(lateWork ? ['late-root', 'late-child'] : ['child-turn']));
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params)).toContainEqual({ threadId: 'child', turnId: 'child-turn' });
    expect(process.requests.filter(r => r.method === 'thread/unsubscribe').map(r => r.params.threadId).sort()).toEqual(lateWork ? ['child', 'grandchild', 'thread-1'] : ['child', 'thread-1']);
    expect(process.isAlive()).toBe(true);
  });

  it('keeps the parent running when one of its child threads closes', async () => {
    mockAutoReconcile = true;
    const session = new CodexExecutionBackend(plugin, createRuntime()).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    process.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-thread-1',
      item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' },
    });
    process.notify('thread/closed', { threadId: 'child' });
    complete(process, 'thread-1');
    expect((await output).at(-1)?.type).toBe('turn_completed');
    expect(session.hasBackgroundWork?.()).toBe(false);
    expect(process.requests.filter(r => r.method === 'thread/unsubscribe')).toHaveLength(0);
    await session.dispose();
  });

  it.each(['thread/start', 'thread/fork'])('unsubscribes a late %s result after its caller times out without stopping another chat', async method => {
    mockAutoReconcile = true;
    const runtime = createRuntime();
    const session = new CodexExecutionBackend(plugin, runtime).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const lease = await runtime.acquire();
    const scope = lease.connection.createThreadScope({ notification: jest.fn(), serverRequest: jest.fn(), stop: jest.fn(), workChanged: jest.fn() });
    let creationId!: number;
    mockRequestOverride = (_process, rpc) => {
      if (rpc.method !== method) return false;
      creationId = rpc.id;
      return true;
    };
    jest.useFakeTimers();
    try {
      const creation = scope.open(method as 'thread/start' | 'thread/fork', { threadId: 'source' });
      const failure = creation.catch(error => error);
      await jest.advanceTimersByTimeAsync(30_001);
      expect(await failure).toEqual(expect.objectContaining({ message: `Request timeout: ${method} (30000ms)` }));
      process.respond(creationId, { thread: { id: 'late-thread', turns: [] } });
      for (let i = 0; i < 100 && !process.requests.some(r => r.method === 'thread/unsubscribe'); i++) await Promise.resolve();
      expect(process.requests.filter(r => r.method === 'thread/unsubscribe').map(r => r.params.threadId)).toContain('late-thread');
      expect(process.isAlive()).toBe(true);
      complete(process, 'thread-1');
      expect((await output).at(-1)?.type).toBe('turn_completed');
    } finally {
      jest.useRealTimers();
      await session.dispose();
      await scope.detach();
      await lease.release();
    }
  });

  it.each([false, true])('interrupts a late native start after cancellation cleanup reads time out (dispose: %s)', async (dispose) => {
    mockAutoReconcile = true;
    let holdCleanup = true;
    mockRequestOverride = (_process, rpc) => holdCleanup && rpc.params?.threadId === 'thread-1'
      && (rpc.method === 'turn/start' || rpc.method === 'thread/read');
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    jest.useFakeTimers();
    try {
      const run = first.execute(request);
      const output = collect(run.events);
      const process = await waitForRequest('turn/start');
      const surviving = collect(second.execute(request).events);
      run.cancel();
      expect((await output).at(-1)?.type).toBe('cancelled');
      // Let the start request and all bounded cleanup attempts time out.
      await jest.advanceTimersByTimeAsync(90_003);
      expect(process.requests.filter(r => r.method === 'thread/read' && r.params.threadId === 'thread-1').length).toBeGreaterThan(0);
      const disposal = dispose ? first.dispose() : Promise.resolve();
      await jest.advanceTimersByTimeAsync(60_002);
      await disposal;
      holdCleanup = false;
      process.notify('turn/started', { threadId: 'thread-1', turn: { id: 'late-after-cleanup', status: 'inProgress', items: [] } });
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params))
        .toContainEqual({ threadId: 'thread-1', turnId: 'late-after-cleanup' });
      const retrySession = dispose ? backend.createSession({ ...config, resumeSeed: { providerSessionId: 'thread-1' } }) : first;
      const retry = collect(retrySession.execute(request).events);
      for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 3; i++) await Promise.resolve();
      expect(process.requests.filter(r => r.method === 'turn/start')).toHaveLength(3);
      complete(process, 'thread-1');
      complete(process, 'thread-2');
      expect((await retry).at(-1)?.type).toBe('turn_completed');
      expect((await surviving).at(-1)?.type).toBe('turn_completed');
      expect(process.isAlive()).toBe(true);
      await retrySession.dispose();
    } finally {
      holdCleanup = false;
      jest.useRealTimers();
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it.each([true, false])('interrupts an ambiguous timed-out turn before releasing its root (started notification: %s)', async notifyStarted => {
    mockAutoReconcile = true;
    mockRequestOverride = (process, rpc) => {
      if (rpc.method !== 'turn/start' || rpc.params.threadId !== 'thread-1') return false;
      const turn = { id: 'slow-turn', status: 'inProgress', items: [] };
      process.turns.set('thread-1', turn);
      if (notifyStarted) process.notify('turn/started', { threadId: 'thread-1', turn });
      return true;
    };
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    jest.useFakeTimers();
    try {
      const failed = collect(first.execute(request).events);
      const process = await waitForRequest('turn/start');
      const surviving = collect(second.execute(request).events);
      for (let i = 0; i < 100 && process.requests.filter(r => r.method === 'turn/start').length < 2; i++) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(30_001);
      expect((await failed).at(-1)?.type).toBe('execution_error');
      await first.dispose();
      const interrupt = process.requests.findIndex(r => r.method === 'turn/interrupt' && r.params.threadId === 'thread-1');
      const unsubscribe = process.requests.findIndex(r => r.method === 'thread/unsubscribe' && r.params.threadId === 'thread-1');
      expect(interrupt).toBeGreaterThan(-1);
      expect(unsubscribe).toBeGreaterThan(interrupt);
      expect(process.isAlive()).toBe(true);
      complete(process, 'thread-2');
      expect((await surviving).at(-1)?.type).toBe('turn_completed');
    } finally {
      jest.useRealTimers();
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it('joins an already retiring process shutdown during runtime disposal', async () => {
    mockAutoReconcile = true;
    const runtime = createRuntime();
    const old = await runtime.acquire();
    const process = mockProcesses[0];
    const originalShutdown = process.shutdown.bind(process);
    let finishShutdown!: () => void;
    const pending = new Promise<void>(resolve => { finishShutdown = resolve; });
    jest.spyOn(process, 'shutdown').mockImplementation(async () => { await pending; await originalShutdown(); });
    mockLaunchKey = 'second';
    const replacement = await runtime.acquire();
    const release = old.release();
    let disposed = false;
    const disposal = runtime.dispose().then(() => { disposed = true; });
    try {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(disposed).toBe(false);
    } finally {
      finishShutdown();
      await Promise.all([release, disposal, replacement.release()]);
    }
  });

  it('isolates concurrent chat threads and keeps the server alive when one is cancelled or disposed', async () => {
    mockAutoReconcile = true;
    const backend = new CodexExecutionBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstRun = first.execute(request);
    const secondRun = second.execute(request);
    const firstEvents = collect(firstRun.events);
    const secondEvents = collect(secondRun.events);
    try {
      for (let count = 0; count < 200; count++) {
        if (mockProcesses.flatMap(process => process.requests).filter(request => request.method === 'turn/start').length === 2) break;
        await Promise.resolve();
      }
      expect(mockProcesses.flatMap(process => process.requests).filter(request => request.method === 'turn/start')).toHaveLength(2);
      expect(mockProcesses).toHaveLength(1);
      const process = mockProcesses[0];
      firstRun.cancel();
      await firstEvents;
      await first.dispose();
      expect(process.isAlive()).toBe(true);
      expect(process.requests.filter(request => request.method === 'turn/interrupt').map(request => request.params.threadId)).toEqual(['thread-1']);
      process.notify('item/agentMessage/delta', { threadId: 'thread-2', turnId: 'turn-thread-2', itemId: 'message', delta: 'second only' });
      process.notify('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-thread-2', status: 'completed', items: [] } });
      expect(await secondEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      await second.dispose();
      expect(process.isAlive()).toBe(true);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await Promise.all([firstEvents, secondEvents]);
    }
  });
});
