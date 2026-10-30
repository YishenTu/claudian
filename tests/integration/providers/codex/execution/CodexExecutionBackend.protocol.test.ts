// @test-ci {"native":true}
import { DesktopVault } from '@test/helpers/core/DesktopVault';
const actualModule0 = await import('node:fs');
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';

import pair from '@test/fixtures/providers/codex/turn-stats-pair.json';
import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { type CodexNativeRequest, CodexNativeResponseError, CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import spawn from 'cross-spawn';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
  ProviderSessionEvent,
} from '@/core/execution';
import { isSteerableExecutionSession } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';

/** The backend resolves its runtime per session; tests pin one instance. */
const fixedRuntime = (runtime: CodexAppServerRuntime) => (): CodexAppServerRuntime => runtime;
type MutableTestHost = ProviderHost & { settings: ClaudianSettings };

const nativeRequest = vi.fn<(method: string, params: CodexNativeRequest['params']) => unknown>();
const nativeUnsubscribe = vi.fn<(params: CodexNativeRequest['params']) => Promise<{ status: string }>>().mockResolvedValue({ status: 'unsubscribed' });
const resolveCliPath = vi.fn(async () => '/native/codex');
let wslTarget = false;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let transportDispose: MockInstance;
let transportStart: MockInstance;

let mockProcessStart: MockInstance<CodexAppServerProcess['start']>;
let mockProcessShutdown: MockInstance<CodexAppServerProcess['shutdown']>;
const native = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => native.createProcess()) }));

import type { MockInstance } from 'vitest';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';


const runtimes: CodexAppServerRuntime[] = [];
function createBackend(plugin: ProviderHost): CodexExecutionBackend {
  const host = plugin.getRuntimeHost('codex');
  const runtime = new CodexAppServerRuntime(host, () => undefined);
  runtimes.push(runtime);
  return new CodexExecutionBackend(
    host,
    fixedRuntime(runtime),
  );
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', originalPlatform);
});

function nativeImagePath(input: CodexNativeRequest['params']['input']): string {
  const image = input?.[0];
  if (image?.type !== 'localImage') throw new Error('Expected a native localImage input');
  return image.path;
}

function latestSubagentUpdate(updates: ProviderSessionEvent[]) {
  const update = updates.at(-1);
  if (update?.type !== 'subagent_updated') throw new Error('Expected a subagent update');
  return update;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function emitNotification(method: string, params: unknown): void {
  native.processes.at(-1)!.notify(method, params);
}

// Policies the app server derives from a config.toml with sandbox_workspace_write overrides.
const CONFIGURED_WORKSPACE_WRITE_SANDBOX = {
  type: 'workspaceWrite',
  writableRoots: ['/configured/root'],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
} as const;

function configuredSandboxFor(mode: unknown) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return CONFIGURED_WORKSPACE_WRITE_SANDBOX;
}

function createThreadResult(
  threadId: string,
  turns: Array<{
    id: string;
    error?: unknown;
    items?: unknown[];
    status?: 'completed' | 'failed' | 'inProgress' | 'interrupted';
  }> = [],
) {
  return {
    thread: {
      id: threadId,
      path: `/tmp/sessions/${threadId}.jsonl`,
      preview: '',
      ephemeral: false,
      status: { type: 'idle' },
      turns: turns.map(turn => ({
        ...turn,
        items: turn.items ?? [],
        status: turn.status ?? 'completed',
        error: turn.error ?? null,
      })),
      cwd: '/vault',
      cliVersion: '0.146.0',
      modelProvider: 'openai',
      source: 'app-server',
      createdAt: 0,
      lastActivityAt: 0,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
    },
    model: TEST_CODEX_MODEL,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/vault',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: CONFIGURED_WORKSPACE_WRITE_SANDBOX as Record<string, unknown>,
    reasoningEffort: 'medium',
  };
}

function createTurnResult(turnId: string) {
  return {
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  };
}

async function createPlugin(): Promise<MutableTestHost> {
  const fixture = await createProviderHostFixture({ vault: sharedVault,
    overrides: { workingDirectory: wslTarget ? 'C:\\vault' : '/vault', getResolvedProviderCliPath: resolveCliPath },
    settings: {
      model: TEST_CODEX_MODEL,
      effortLevel: 'medium',
      serviceTier: 'default',
      permissionMode: 'normal',
      systemPrompt: '',
      mediaFolder: '',
      userName: '',
      providerConfigs: {
        codex: {
          enabled: true,
          environmentVariables: `HOME=${sharedVault.root}\nUSERPROFILE=${sharedVault.root}`,
          discoveredModels: [{
            model: TEST_CODEX_MODEL,
            displayName: 'Test Codex',
            description: '',
            supportedReasoningEfforts: [
              { value: 'low', description: '' },
              { value: 'medium', description: '' },
              { value: 'high', description: '' },
            ],
            defaultReasoningEffort: 'medium',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
            defaultServiceTier: null,
            inputModalities: ['text', 'image'],
            isDefault: true,
          }],
        },
      },
    },
  });
  if (wslTarget) updateCodexProviderSettings(fixture.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
  return fixture.host;
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    requestApproval: vi.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      decision: 'allow',
    })),
    askUserQuestion: vi.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      answers: { choice: 'yes' },
    })),
    dismissInteraction: vi.fn(),
  };
}

function createSessionConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: wslTarget ? 'C:\\vault' : '/vault',
    interactionPort: createInteractionPort(),
    ...overrides,
  };
}

function createForkSessionConfig(
  providerState: Record<string, unknown> = {},
): ProviderSessionConfig {
  return createSessionConfig({
    resumeSeed: {
      providerState: {
        forkSourceSessionFilePath: '/tmp/source.jsonl',
        forkSourceTranscriptRootPath: '/tmp/sessions',
        forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
        unknownFutureState: { keep: true },
        ...providerState,
      },
    },
  });
}

function expectPendingForkOwnership(
  session: ReturnType<CodexExecutionBackend['createSession']>,
  status: 'idle' | 'invalidated' | 'disposed' = 'idle',
): void {
  expect(session.getSnapshot()).toMatchObject({
    providerSessionId: 'thread-fork-target',
    providerState: {
      forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
      pendingForkTarget: {
        sessionFilePath: '/tmp/sessions/thread-fork-target.jsonl',
        threadId: 'thread-fork-target',
      },
      threadId: 'thread-fork-target',
      unknownFutureState: { keep: true },
    },
    status,
  });
  expect(session.getSnapshot().providerStateDeletes).toBeUndefined();
}

function expectPendingForkOwnershipEvent(
  events: readonly ProviderExecutionEvent[],
): void {
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'session_state_changed',
      snapshot: expect.objectContaining({
        providerSessionId: 'thread-fork-target',
        providerState: expect.objectContaining({
          forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
          pendingForkTarget: {
            sessionFilePath: '/tmp/sessions/thread-fork-target.jsonl',
            threadId: 'thread-fork-target',
          },
          threadId: 'thread-fork-target',
          unknownFutureState: { keep: true },
        }),
      }),
    }),
  ]));
}

function createRequest(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text: 'hello' }],
    configuration: {
      systemInstructions: { kind: 'explicit', instructions: 'Be concise.' },
      model: TEST_CODEX_MODEL,
      reasoning: 'high',
      serviceTier: 'priority',
      permissionMode: 'normal',
    },
    toolPolicy: { kind: 'provider-default' },
    signal,
    ...overrides,
  };
}

async function collectEvents(
  events: AsyncIterable<ProviderExecutionEvent>,
  observe?: (event: ProviderExecutionEvent) => void,
): Promise<ProviderExecutionEvent[]> {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    result.push(event);
    observe?.(event);
  }
  return result;
}

function createImageRequest(): ProviderExecutionRequest {
  return createRequest(undefined, {
    input: [{
      type: 'image',
      image: {
        id: 'image-1', name: 'pasted.png', mediaType: 'image/png',
        data: 'aGVsbG8=', size: 5, source: 'paste',
      },
    }],
  });
}

async function collectUntil(
  events: AsyncIterable<ProviderExecutionEvent>,
  predicate: (event: ProviderExecutionEvent) => boolean,
): Promise<ProviderExecutionEvent[]> {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    result.push(event);
    if (predicate(event)) break;
  }
  return result;
}

function completeTurn(threadId: string, turnId: string): void {
  emitNotification('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'completed', error: null },
  });
}

function configureNativeTurn(
  threadId: string,
  turnId: string,
  steer: () => unknown | Promise<unknown>,
): void {
  nativeRequest.mockImplementation(async (method: string) => {
    if (method === 'initialize') {
      return {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: wslTarget ? 'linux' : 'macos',
      };
    }
    if (method === 'thread/start') return createThreadResult(threadId);
    if (method === 'turn/start') return createTurnResult(turnId);
    if (method === 'turn/steer') return steer();
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method: ${method}`);
  });
}

async function createActiveSteerSession() {
  const session = createBackend(await createPlugin()).createSession(createSessionConfig());
  const run = session.execute(createRequest());
  const started = createDeferred<ProviderExecutionEvent>();
  const runEvents = collectEvents(run.events, event => {
    if (event.type === 'turn_started' || event.type === 'execution_error') started.resolve(event);
  });
  const firstEvent = await started.promise;
  expect(firstEvent).toMatchObject({ type: 'turn_started', accepted: true });
  if (!isSteerableExecutionSession(session)) throw new Error('Codex session should be steerable');
  return { run, session, runEvents };
}

/** A real response confirms that prior native notifications crossed the client transport. */
async function nativeRoundTrip(): Promise<void> {
  const lease = await runtimes.at(-1)!.acquire({ readiness: 'initialized' });
  try { await lease.connection.transport.request('model/list', {}); }
  finally { await lease.release(); }
}

function waitForSessionEvent(
  session: ReturnType<CodexExecutionBackend['createSession']>,
  predicate: (event: ProviderSessionEvent) => boolean,
): Promise<ProviderSessionEvent> {
  return new Promise(resolve => {
    const off = session.onEvent(event => {
      if (predicate(event)) { off(); resolve(event); }
    });
  });
}

describe('CodexExecutionBackend', () => {
  it.each([
    ['normal', 'workspace-write', 'on-request', 'user', undefined, 'workspace-write'],
    ['auto-review', 'workspace-write', 'on-request', 'auto_review', undefined, 'workspace-write'],
    ['yolo', 'danger-full-access', 'never', 'user', { type: 'dangerFullAccess' }, 'workspace-write'],
    ['auto-review', 'read-only', 'on-request', 'auto_review', undefined, 'read-only'],
    ['invalid', 'read-only', 'on-request', 'user', undefined, 'corrupt'],
  ])('sends the %s preset on thread start, resume, and every turn', async (
    permissionMode, sandbox, approvalPolicy, approvalsReviewer, sandboxPolicy, safeMode,
  ) => {
    let turn = 0;
    let nativeSandbox: unknown;
    nativeRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      // A loaded thread keeps its policy on resume; only thread/start derives one from the mode.
      if (method === 'thread/start') nativeSandbox = configuredSandboxFor(params.sandbox);
      if (method === 'thread/start' || method === 'thread/resume') return {
        ...createThreadResult('thread-permissions'), approvalsReviewer, sandbox: nativeSandbox,
      };
      if (method === 'turn/start') {
        const turnId = `turn-permissions-${++turn}`;
        queueMicrotask(() => completeTurn('thread-permissions', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    plugin.settings.providerConfigs.codex!.safeMode = safeMode;
    const session = createBackend(plugin).createSession(createSessionConfig());
    for (const instructions of ['First instructions.', 'Updated instructions.']) {
      const request = createRequest();
      await collectEvents(session.execute({
        ...request,
        configuration: {
          ...request.configuration, permissionMode,
          systemInstructions: { kind: 'explicit', instructions },
        },
      }).events);
    }
    for (const method of ['thread/start', 'thread/resume']) {
      expect(nativeRequest).toHaveBeenCalledWith(method, expect.objectContaining({
        sandbox, approvalPolicy, approvalsReviewer,
      }));
    }
    const turns = nativeRequest.mock.calls.filter(([method]) => method === 'turn/start');
    expect(turns).toHaveLength(2);
    for (const [, params] of turns) {
      expect(params).toEqual(expect.objectContaining({ approvalPolicy, approvalsReviewer }));
      expect(params.sandboxPolicy).toEqual(sandboxPolicy);
    }
    expect(nativeRequest).not.toHaveBeenCalledWith('config/read', expect.anything());
    await session.dispose();
  });

  it.each([undefined, 'user'])('does not run auto-review when the server returns reviewer %s', async reviewer => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      if (method === 'thread/start') return { ...createThreadResult('thread-no-review'), approvalsReviewer: reviewer };
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-no-review', 'turn-no-review'));
        return createTurnResult('turn-no-review');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const request = createRequest();
    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, permissionMode: 'auto-review' },
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error' }));
    expect(nativeRequest.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    await session.dispose();
  });

  it.each([false, true])('switches a warm thread to auto-review and surfaces native rejection (reject: %s)', async reject => {
    let turn = 0;
    nativeRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      if (method === 'thread/start') return createThreadResult('thread-review-switch');
      if (method === 'turn/start') {
        if (reject && params.approvalsReviewer === 'auto_review') {
          throw new CodexNativeResponseError({ code: -32602, message: 'Unsupported approvalsReviewer: auto_review' });
        }
        const turnId = `turn-review-switch-${++turn}`;
        queueMicrotask(() => completeTurn('thread-review-switch', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const request = createRequest();
    await collectEvents(session.execute(request).events);
    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, permissionMode: 'auto-review' },
    }).events);
    expect(nativeRequest.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1);
    const turns = nativeRequest.mock.calls.filter(([method]) => method === 'turn/start');
    expect(turns.map(([, params]) => params.approvalsReviewer)).toEqual(['user', 'auto_review']);
    expect(turns[1][1]).toMatchObject({ approvalPolicy: 'on-request' });
    expect(turns[1][1]).not.toHaveProperty('sandboxPolicy');
    expect(events.some(event => event.type === 'execution_error')).toBe(reject);
    expect(events.some(event => event.type === 'turn_started' && event.accepted)).toBe(!reject);
    await session.dispose();
  });

  it.each([
    ['yolo', 'workspace-write', 'normal', 'workspace-write', CONFIGURED_WORKSPACE_WRITE_SANDBOX, [{ cwd: '/vault' }]],
    ['normal', 'workspace-write', 'normal', 'read-only', {
      type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false,
    }, []],
    ['normal', 'read-only', 'normal', 'workspace-write', CONFIGURED_WORKSPACE_WRITE_SANDBOX, [{ cwd: '/vault' }]],
  ])('restores the configured sandbox when a warm thread switches from %s/%s to %s/%s', async (
    firstMode, firstSafeMode, nextMode, nextSafeMode, restoredPolicy, configReads,
  ) => {
    let turn = 0;
    nativeRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      if (method === 'thread/start') return {
        ...createThreadResult('thread-sandbox-switch'), sandbox: configuredSandboxFor(params.sandbox),
      };
      if (method === 'config/read') return {
        config: {
          sandbox_mode: 'danger-full-access',
          sandbox_workspace_write: {
            writable_roots: ['/configured/root'],
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      };
      if (method === 'turn/start') {
        const turnId = `turn-sandbox-switch-${++turn}`;
        queueMicrotask(() => completeTurn('thread-sandbox-switch', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    const session = createBackend(plugin).createSession(createSessionConfig());
    const runWith = async (permissionMode: string, safeMode: string) => {
      plugin.settings.providerConfigs.codex!.safeMode = safeMode;
      const request = createRequest();
      await collectEvents(session.execute({
        ...request, configuration: { ...request.configuration, permissionMode },
      }).events);
    };
    await runWith(firstMode, firstSafeMode);
    await runWith(nextMode, nextSafeMode);
    await runWith(nextMode, nextSafeMode);

    const turns = nativeRequest.mock.calls.filter(([method]) => method === 'turn/start');
    expect(turns).toHaveLength(3);
    expect(turns[1][1].sandboxPolicy).toEqual(restoredPolicy);
    expect(turns[2][1]).not.toHaveProperty('sandboxPolicy');
    expect(nativeRequest.mock.calls.filter(([method]) => method === 'config/read')
      .map(([, params]) => params)).toEqual(configReads);
    await session.dispose();
  });

  it.each(['late', 'lost'])('does not trust the prior sandbox after an override response is %s', async outcome => {
    if (outcome === 'lost') vi.useFakeTimers();
    const yoloResponse = createDeferred<unknown>();
    let turn = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      if (method === 'thread/start') return createThreadResult('thread-late-override');
      if (method === 'config/read') return {
        config: { sandbox_workspace_write: { writable_roots: ['/configured/root'], network_access: true } },
      };
      if (method === 'turn/start') {
        const turnId = `turn-late-override-${++turn}`;
        if (turn === 2) {
          // Native handoff and completion precede the acknowledgement of the YOLO override.
          emitNotification('turn/started', { threadId: 'thread-late-override', turn: createTurnResult(turnId).turn });
          queueMicrotask(() => completeTurn('thread-late-override', turnId));
          return yoloResponse.promise;
        }
        queueMicrotask(() => completeTurn('thread-late-override', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const runWith = (permissionMode: string) => {
      const request = createRequest();
      return collectEvents(session.execute({
        ...request, configuration: { ...request.configuration, permissionMode },
      }).events);
    };
    await runWith('normal');
    if (outcome === 'late') {
      await runWith('yolo');
    } else {
      const yoloRun = runWith('yolo');
      await native.waitForRequest('turn/start', 0, 2);
      await vi.advanceTimersByTimeAsync(30_000);
      await yoloRun;
    }
    await runWith('normal');
    yoloResponse.resolve(createTurnResult('turn-late-override-2'));
    await nativeRoundTrip();
    await runWith('normal');

    const turns = nativeRequest.mock.calls.filter(([method]) => method === 'turn/start');
    expect(turns.map(([, params]) => params.sandboxPolicy)).toEqual([
      undefined,
      { type: 'dangerFullAccess' },
      CONFIGURED_WORKSPACE_WRITE_SANDBOX,
      undefined,
    ]);
    await session.dispose();
  });

  it('sends the configured workspace-write sandbox when a fork child ignores the resume mode', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      // thread/fork applies the config sandbox_mode, and resuming the loaded child keeps it.
      if (method === 'thread/fork' || method === 'thread/resume') return {
        ...createThreadResult('thread-fork-sandbox', [{ id: 'checkpoint' }]),
        sandbox: { type: 'dangerFullAccess' },
      };
      if (method === 'config/read') return {
        config: {
          sandbox_workspace_write: { writable_roots: ['/configured/root'], network_access: true },
        },
      };
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-sandbox', 'turn-fork-sandbox'));
        return createTurnResult('turn-fork-sandbox');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createForkSessionConfig());
    await collectEvents(session.execute(createRequest()).events);

    expect(nativeRequest).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'thread-fork-sandbox', sandbox: 'workspace-write',
    }));
    expect(nativeRequest).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      sandboxPolicy: CONFIGURED_WORKSPACE_WRITE_SANDBOX,
    }));
    await session.dispose();
  });

  it('falls back to saved Codex preferences, then current selections, for unset request fields', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: wslTarget ? 'linux' : 'macos',
      };
      if (method === 'thread/start') return createThreadResult('thread-fallbacks');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fallbacks', 'turn-fallbacks'));
        return createTurnResult('turn-fallbacks');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    Object.assign(plugin.settings, {
      savedProviderEffort: { codex: 'low', claude: 'high' },
      savedProviderPermissionMode: { codex: 'yolo' },
    });
    const session = createBackend(plugin).createSession(createSessionConfig());
    await collectEvents(session.execute(createRequest(undefined, {
      configuration: { systemInstructions: { kind: 'explicit', instructions: 'Be concise.' } },
    })).events);

    expect(nativeRequest).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      model: TEST_CODEX_MODEL, effort: 'low', serviceTier: 'default', approvalPolicy: 'never',
    }));
    await session.dispose();
  });

  it('rejects an unavailable selected model before native startup with a configuration error', async () => {
    const host = await createPlugin();
    host.settings.providerConfigs!.codex!.visibleModels = [];
    const session = createBackend(host).createSession(createSessionConfig());
    const events = await collectEvents(session.execute(createRequest()).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', category: 'configuration' }));
    expect(events.some(event => event.type === 'turn_started' && event.accepted)).toBe(false);
    expect(mockProcessStart).not.toHaveBeenCalled();
    await session.dispose();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    wslTarget = false;
    // These protocol fixtures describe a macOS host; WSL rows select Windows explicitly.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    mockProcessStart = vi.spyOn(CodexAppServerProcess.prototype, 'start');
    mockProcessShutdown = vi.spyOn(CodexAppServerProcess.prototype, 'shutdown');
    nativeUnsubscribe.mockReset().mockResolvedValue({ status: 'unsubscribed' });
    nativeRequest.mockReset();
    transportDispose = vi.spyOn(CodexRPCTransport.prototype, 'dispose');
    transportStart = vi.spyOn(CodexRPCTransport.prototype, 'start');
    native.reset();
    native.autoReconcile = true;
    native.requestOverride = (process, request) => {
      if (request.method === 'plugin/reconcile' || request.method === 'model/list') return false;
      process.respondWhen(request.id, (async () => request.method === 'thread/unsubscribe'
        ? nativeUnsubscribe(request.params)
        : nativeRequest(request.method, request.params))());
      return true;
    };

  });

  it('keeps parent output flowing after a child messages its parent', async () => {
    configureNativeTurn('parent', 'parent-turn', () => ({}));
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const updates: ProviderSessionEvent[] = [];
    session.onEvent(event => updates.push(event));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = session.execute(createRequest());
      const output = collectEvents(run.events);
      await native.waitForRequest('turn/start');
      emitNotification('item/completed', { threadId: 'parent', turnId: 'parent-turn',
        item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/review' } });
      emitNotification('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [], error: null } });
      // Native records a child's message to its parent on the child thread, targeting the parent.
      emitNotification('item/completed', { threadId: 'child', turnId: 'child-turn',
        item: { type: 'subAgentActivity', id: 'message-parent', kind: 'interacted', agentThreadId: 'parent', agentPath: '/root' } });
      emitNotification('item/completed', { threadId: 'parent', turnId: 'parent-turn',
        item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Parent done.', memoryCitation: null } });
      completeTurn('parent', 'parent-turn');
      const settled = await Promise.race([
        output.then(events => JSON.stringify(events)),
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 1_000); }),
      ]);
      expect(settled).toContain('Parent done.');
      expect(updates).not.toContainEqual(expect.objectContaining({
        subagent: expect.objectContaining({ agentId: 'parent' }),
      }));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await session.dispose();
    }
  });

  it('keeps a sibling message from replacing the receiving subagent invocation', async () => {
    configureNativeTurn('parent', 'parent-turn', () => ({}));
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const updates: ProviderSessionEvent[] = [];
    session.onEvent(event => updates.push(event));
    try {
      session.execute(createRequest());
      await native.waitForRequest('turn/start');
      for (const name of ['a', 'b']) {
        emitNotification('item/completed', { threadId: 'parent', turnId: 'parent-turn',
          item: { type: 'subAgentActivity', id: `spawn-${name}`, kind: 'started', agentThreadId: name, agentPath: `/root/${name}` } });
      }
      emitNotification('turn/started', { threadId: 'b', turn: { id: 'b-turn-1', status: 'inProgress', items: [], error: null } });
      emitNotification('turn/completed', { threadId: 'b', turn: { id: 'b-turn-1', status: 'completed', items: [], error: null } });
      emitNotification('turn/started', { threadId: 'a', turn: { id: 'a-turn', status: 'inProgress', items: [], error: null } });
      emitNotification('item/completed', { threadId: 'a', turnId: 'a-turn',
        item: { type: 'subAgentActivity', id: 'a-message-b', kind: 'interacted', agentThreadId: 'b', agentPath: '/root/b' } });
      emitNotification('turn/started', { threadId: 'b', turn: { id: 'b-turn-2', status: 'inProgress', items: [], error: null } });
      await nativeRoundTrip();
      const latestB = updates.filter(event => event.type === 'subagent_updated').filter(event => event.subagent.agentId === 'b').at(-1)!;
      expect(latestB.subagent).toEqual(expect.objectContaining({ id: 'spawn-b', status: 'running' }));
    } finally {
      await session.dispose();
    }
  });

  it('publishes native subagent completion after the parent settles and through later follow-ups', async () => {
    configureNativeTurn('parent', 'parent-turn', () => ({}));
    const baseRequest = nativeRequest.getMockImplementation()!;
    let answer = 'Ready.';
    nativeRequest.mockImplementation((method: string, params: CodexNativeRequest['params']) => {
      if (method === 'thread/read') return Promise.resolve({ thread: {
        ...createThreadResult('child', [{ id: 'child-turn', items: [
          { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: answer },
        ] }]).thread,
        agentNickname: 'Bohr', model: TEST_CODEX_MODEL, reasoningEffort: 'high',
      } });
      return baseRequest(method, params);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const updates: ProviderSessionEvent[] = [];
    session.onEvent(event => updates.push(event));
    try {
      const run = session.execute(createRequest());
      const output = collectEvents(run.events);
      await native.waitForRequest('turn/start');
      const activity = (id: string, kind: string) => emitNotification('item/completed', {
        threadId: 'parent', turnId: 'parent-turn',
        item: { type: 'subAgentActivity', id, kind, agentThreadId: 'child', agentPath: '/root/ui_test_helper' },
      });
      activity('spawn', 'started');
      completeTurn('parent', 'parent-turn');
      await output;
      emitNotification('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [], error: null } });
      emitNotification('rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'custom_tool_call', call_id: 'clock-call', name: 'exec', input: 'const t = await tools.clock__curr_time({}); text(t.current_time);',
      } });
      await nativeRoundTrip();
      expect(latestSubagentUpdate(updates).subagent.toolCalls).toEqual([expect.objectContaining({ id: 'clock-call', status: 'running' })]);
      emitNotification('rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'custom_tool_call_output', call_id: 'clock-call', output: [{ type: 'input_text', text: 'Clock result' }],
      } });
      await nativeRoundTrip();
      expect(latestSubagentUpdate(updates).subagent.toolCalls).toEqual([expect.objectContaining({ id: 'clock-call', status: 'completed', result: 'Clock result' })]);
      // A later canonical projection must update the already visible raw row.
      emitNotification('item/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'dynamicToolCall', id: 'canonical-clock', tool: 'clock__curr_time', arguments: {},
        status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'Clock result' }],
      } });
      await nativeRoundTrip();
      expect(latestSubagentUpdate(updates).subagent.toolCalls).toEqual([expect.objectContaining({ id: 'clock-call', status: 'completed', result: 'Clock result' })]);
      emitNotification('rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'function_call', call_id: 'command-call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo child' }),
      } });
      emitNotification('item/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'commandExecution', id: 'canonical-command', command: 'echo child', cwd: '/vault',
        status: 'completed', commandActions: [{ type: 'unknown', command: 'echo child' }], aggregatedOutput: 'child', exitCode: 0, durationMs: 10,
      } });
      emitNotification('rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item: {
        type: 'function_call_output', call_id: 'command-call', output: 'child',
      } });
      emitNotification('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed', items: [], error: null } });
      await nativeRoundTrip();
      expect(updates.at(-1)).toEqual(expect.objectContaining({ subagent: expect.objectContaining({
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ id: 'clock-call', status: 'completed', result: expect.stringContaining('Clock result') }),
          expect.objectContaining({ id: 'command-call', status: 'completed', result: 'child' }),
        ]),
      }) }));
      await nativeRoundTrip();
      expect(latestSubagentUpdate(updates).subagent.toolCalls).toHaveLength(2);
      const firstResult = waitForSessionEvent(session, event => event.type === 'subagent_updated' && event.subagent.result === 'Ready.');
      activity('child-completed-1', 'completed');
      await firstResult;
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'subagent_updated', scope: expect.objectContaining({ kind: 'session' }),
        subagent: expect.objectContaining({ id: 'spawn', agentId: 'child', status: 'completed', result: 'Ready.' }),
      }));
      answer = 'Two.';
      activity('followup', 'interacted');
      const secondResult = waitForSessionEvent(session, event => event.type === 'subagent_updated' && event.subagent.result === 'Two.');
      activity('child-completed-2', 'completed');
      await secondResult;
      expect(updates.at(-1)).toEqual(expect.objectContaining({ subagent: expect.objectContaining({ id: 'spawn', status: 'completed', result: 'Two.' }) }));
    } finally { await session.dispose(); }
  });

  it.each(['completion', 'failure', 'cancellation', 'disposal'] as const)(
    'sends image bytes through a temporary file and removes it on %s',
    async outcome => {
      const startResult = createDeferred<ReturnType<typeof createTurnResult>>();
      configureNativeTurn('thread-image', 'turn-image', () => ({}));
      const transport = nativeRequest.getMockImplementation()!;
      nativeRequest.mockImplementation((method: string, params: CodexNativeRequest['params']) => (
        method === 'turn/start' ? startResult.promise : transport(method, params)
      ));
      const session = createBackend(await createPlugin()).createSession(createSessionConfig());
      try {
        const run = session.execute(createImageRequest());
        const events = collectEvents(run.events);
        await native.waitForRequest('turn/start');
        const input = nativeRequest.mock.calls.find(([method]) => method === 'turn/start')![1].input;
        expect(input).toEqual([{ type: 'localImage', path: expect.any(String) }]);
        const filePath = nativeImagePath(input);
        expect(readFileSync(filePath)).toEqual(Buffer.from('hello'));

        if (outcome === 'failure') {
          startResult.reject(new CodexNativeResponseError({ code: -32602, message: 'Native turn rejected' }));
        } else {
          startResult.resolve(createTurnResult('turn-image'));
        }
        await nativeRoundTrip();
        expect(existsSync(filePath)).toBe(outcome !== 'failure');
        if (outcome === 'completion') completeTurn('thread-image', 'turn-image');
        else if (outcome === 'cancellation') run.cancel();
        else if (outcome === 'disposal') await session.dispose();
        expect((await events).at(-1)?.type).toBe(
          outcome === 'completion' ? 'turn_completed' : outcome === 'failure' ? 'execution_error' : 'cancelled',
        );
        await nativeRoundTrip();
        expect(existsSync(dirname(filePath))).toBe(false);
      } finally {
        await session.dispose();
      }
    },
  );

  it('submits an image with a filesystem-limit basename and cleans up its bytes', async () => {
    configureNativeTurn('thread-image', 'turn-image', () => ({}));
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const request = createImageRequest();
    const image = request.input.find(block => block.type === 'image')!;
    if (image.type !== 'image') throw new Error('Expected image request');
    image.image.name = `${'a'.repeat(251)}.png`;
    expect(Buffer.byteLength(image.image.name)).toBe(255);
    let filePath: string | undefined;
    try {
      const run = session.execute(request);
      const events = collectEvents(run.events);
      await native.waitForRequest('turn/start');
      const nativeInput = nativeRequest.mock.calls.find(([method]) => method === 'turn/start')?.[1].input;
      expect(nativeInput).toEqual([{ type: 'localImage', path: expect.any(String) }]);
      filePath = nativeImagePath(nativeInput);
      expect(Buffer.byteLength(basename(filePath!))).toBeLessThanOrEqual(255);
      expect(filePath).toMatch(/\.png$/);
      expect(readFileSync(filePath!)).toEqual(Buffer.from('hello'));
      completeTurn('thread-image', 'turn-image');
      expect((await events).at(-1)?.type).toBe('turn_completed');
      await nativeRoundTrip();
      expect(existsSync(dirname(filePath!))).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it.each([false, true])('steers session references with target-visible paths (WSL: %s)', async wsl => {
    if (wsl) {
      wslTarget = true;
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    }
    configureNativeTurn('thread-reference', 'turn-reference', () => ({ turnId: 'turn-reference' }));
    const { run, session, runEvents } = await createActiveSteerSession();
    try {
      await expect(session.steer(createRequest(new AbortController().signal, {
        input: [{ type: 'text', text: 'Use @"Review"' }],
        context: { ...capturedSelections, sessionReferences: [{ id: 'conv-1-ref', title: 'Review & fix', providerId: 'codex', updatedAt: 'updated' }] },
      }))).resolves.toBe(true);
      const input = nativeRequest.mock.calls.find(([method]) => method === 'turn/steer')![1].input;
      expect(input).toEqual([{ type: 'text', text_elements: [], text: 'Use @"Review"\n\n' + capturedSelectionPrompt + '\n\n<context_sessions>\n<context_session title="Review &amp; fix" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>' }]);
    } finally { run.cancel(); await runEvents; await session.dispose(); }
  });

  it.each([true, false])('retains steering image bytes until native acknowledgement (accepted: %s)', async accepted => {
    const steerResult = createDeferred<{ turnId: string }>();
    configureNativeTurn('thread-image', 'turn-image', () => steerResult.promise);
    const { run, session, runEvents } = await createActiveSteerSession();
    try {
      const steering = session.steer(createImageRequest());
      await native.waitForRequest('turn/steer');
      const input = nativeRequest.mock.calls.find(([method]) => method === 'turn/steer')![1].input;
      expect(input).toEqual([{ type: 'localImage', path: expect.any(String) }]);
      const filePath = nativeImagePath(input);
      expect(readFileSync(filePath)).toEqual(Buffer.from('hello'));
      if (accepted) steerResult.resolve({ turnId: 'turn-image' });
      else steerResult.reject(new CodexNativeResponseError({ code: -32602, message: 'Rejected image' }));
      await expect(steering).resolves.toBe(accepted);
      expect(existsSync(dirname(filePath))).toBe(false);
    } finally {
      run.cancel();
      await runEvents;
      await session.dispose();
    }
  });

  it('matches live TurnStats to the rollout from a captured native Codex turn', async () => {
    configureNativeTurn('thread', 'turn', () => ({}));
    const { session, runEvents } = await createActiveSteerSession();
    try {
      for (const notification of pair.notifications) emitNotification(notification.method, notification.params);
      const completion = (await runEvents).at(-1);
      const replay = parseCodexSessionContent(pair.rollout.map(record => JSON.stringify(record)).join('\n'));
      expect(completion).toMatchObject({ type: 'turn_completed', turnStats: { outputTokens: 5, durationMs: 4862 } });
      expect(replay.at(-1)?.turnStats).toEqual({ outputTokens: 5, durationMs: 4862 });
      expect(completion).toMatchObject({ turnStats: replay.at(-1)?.turnStats });
    } finally {
      await session.dispose();
    }
  });

  it('counts raw native responses once and excludes child-thread output', async () => {
    configureNativeTurn('thread', 'turn', () => ({}));
    const { session, runEvents } = await createActiveSteerSession();
    try {
      for (const [threadId, responseId, outputTokens] of [
        ['thread', 'response1', 100], ['thread', 'response1', 100],
        ['thread', 'response2', 25], ['child', 'response3', 900],
      ] as const) emitNotification('rawResponse/completed', {
        threadId, turnId: 'turn', responseId, usage: { outputTokens, reasoningOutputTokens: 20 },
      });
      emitNotification('turn/completed', { threadId: 'thread', turn: {
        id: 'turn', items: [], status: 'completed', error: null, durationMs: 2500,
      } });
      expect((await runEvents).at(-1)).toMatchObject({ type: 'turn_completed',
        turnStats: { outputTokens: 125, durationMs: 2500 } });
    } finally { await session.dispose(); }
  });

  it('recovers a completed turn when the terminal notification is missed', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-missed-completion';
    const turnId = 'turn-missed-completion';
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      if (method === 'thread/read') {
        return createThreadResult(threadId, [{
          id: turnId,
          items: [
            {
              type: 'agentMessage',
              id: 'assistant-recovered',
              text: 'Recovered response.',
              phase: 'final',
              memoryCitation: null,
            },
          ],
        }]);
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(nativeRequest).toHaveBeenCalledWith(
        'thread/read',
        { threadId, includeTurns: true },
      );
      const events = await eventsPromise;
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          nativeAssistantId: 'assistant-recovered',
          type: 'assistant_message_started',
        }),
        expect.objectContaining({ text: 'Recovered response.', type: 'text_delta' }),
      ]));
      expect(events.at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('recovers when the idle status arrives before turn acknowledgement', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-idle-before-ack';
    const turnId = 'turn-idle-before-ack';
    const turnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return turnStart.promise;
      if (method === 'thread/read') {
        return createThreadResult(threadId, [{
          id: turnId,
          items: [{
            type: 'agentMessage',
            id: 'assistant-idle-before-ack',
            text: 'Recovered after acknowledgement.',
            phase: 'final',
            memoryCitation: null,
          }],
        }]);
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      turnStart.resolve(createTurnResult(turnId));
      await nativeRoundTrip();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(nativeRequest).toHaveBeenCalledWith(
        'thread/read',
        { threadId, includeTurns: true },
      );
      expect((await eventsPromise).at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('retries stale recovery reads and reconciles partial assistant text once', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-recovery-retry';
    const turnId = 'turn-recovery-retry';
    let readAttempt = 0;
    const assistantItem = {
      type: 'agentMessage',
      id: 'assistant-recovery-retry',
      text: 'Recovered response.',
      phase: 'final',
      memoryCitation: null,
    };
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      if (method === 'thread/read') {
        readAttempt += 1;
        if (readAttempt === 1) return createThreadResult(threadId);
        if (readAttempt === 2) {
          return createThreadResult(threadId, [{
            id: turnId,
            items: [assistantItem],
            status: 'inProgress',
          }]);
        }
        return createThreadResult(threadId, [{
          id: turnId,
          items: [assistantItem],
        }]);
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('item/started', {
        threadId,
        turnId,
        item: assistantItem,
      });
      emitNotification('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: assistantItem.id,
        delta: 'Recovered ',
      });
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(10_000);

      const events = await eventsPromise;
      expect(readAttempt).toBe(3);
      expect(events
        .filter((event): event is Extract<ProviderExecutionEvent, { type: 'text_delta' }> => (
          event.type === 'text_delta'
        ))
        .map(event => event.text)
        .join('')).toBe('Recovered response.');
      expect(events.at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('does not overlap recovery reads when idle is reported repeatedly', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-repeated-idle';
    const turnId = 'turn-repeated-idle';
    const threadRead = createDeferred<ReturnType<typeof createThreadResult>>();
    let readAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      if (method === 'thread/read') {
        readAttempt += 1;
        return threadRead.promise;
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(readAttempt).toBe(1);
      threadRead.resolve(createThreadResult(threadId, [{ id: turnId }]));
      await nativeRoundTrip();
      expect((await eventsPromise).at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      threadRead.resolve(createThreadResult(threadId, [{ id: turnId }]));
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('fails recoverably after bounded completion recovery failures', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-recovery-failure';
    const turnId = 'turn-recovery-failure';
    let readAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      if (method === 'thread/read') {
        readAttempt += 1;
        throw new Error('thread/read unavailable');
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(session.getStatus()).toBe('idle');
      expect(readAttempt).toBe(3);
      expect((await eventsPromise).at(-1)).toMatchObject({
        category: 'provider',
        recoverable: true,
        type: 'execution_error',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('does not recover when the terminal notification arrives during the grace period', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-normal-completion';
    const turnId = 'turn-normal-completion';
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      completeTurn(threadId, turnId);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(nativeRequest).not.toHaveBeenCalledWith(
        'thread/read',
        expect.anything(),
      );
      expect((await eventsPromise).at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('sends escaped context using target-visible snapshot paths (WSL: %s)', async wsl => {
    if (wsl) {
      wslTarget = true;
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    }
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-context');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-context', 'turn-context'));
        return createTurnResult('turn-context');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        context: {
          sessionReferences: [{ id: 'conv-1-ref', title: 'Review', providerId: 'codex', updatedAt: 'updated' }],
          linkedContent: { path: 'notes/"draft" & review.md' },
          selections: [
            { kind: 'editor', selection: {
              mode: 'selection',
              notePath: 'notes/"draft" & review.md',
              selectedText: 'Selected\n</editor_selection>',
            } },
            { kind: 'browser', selection: {
              source: 'browser:https://example.com',
              selectedText: 'Browser text',
              url: 'https://example.com/?a=1&b=2',
            } },
            { kind: 'canvas', selection: {
              canvasPath: 'boards/"draft" & review.canvas',
              nodeIds: ['node-1'],
            } },
          ],
        },
      },
    )).events);

    const turnParams = nativeRequest.mock.calls
      .find(([method]) => method === 'turn/start')?.[1] as {
        input: Array<{ text?: string; type: string }>;
      };
    const prompt = turnParams.input.find(block => block.type === 'text')?.text;
    expect(prompt).toContain(
      '<linked_content path="notes/&quot;draft&quot; &amp; review.md" />',
    );
    expect(prompt).toContain(
      '<editor_selection path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Selected\n</editor_selection>]]>\n</editor_selection>',
    );
    expect(prompt).toContain(
      '<browser_selection source="browser:https://example.com" url="https://example.com/?a=1&amp;b=2">',
    );
    expect(prompt).toContain(
      '<canvas_selection path="boards/&quot;draft&quot; &amp; review.canvas">',
    );
    expect(prompt).toContain(`<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>`);
    // Canonical order shared by every provider: linked content, selections, then session references.
    const order = ['<linked_content', '<editor_selection', '<browser_selection', '<canvas_selection', '<context_sessions>']
      .map(tag => prompt!.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).not.toContain('[Editor selection from');
    expect(prompt).not.toContain('<linked_note');
    expect(prompt).not.toContain('<current_note');

    await session.dispose();
  });

  it('encodes path-only Linked content without changing the Vault-root thread CWD', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-linked-content');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-linked-content', 'turn-linked-content'));
        return createTurnResult('turn-linked-content');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        context: { ...capturedSelections, linkedContent: { path: 'Projects/Research' } },
        input: [{ type: 'text', text: 'Inspect linked content' }],
      },
    )).events);

    const threadStartParams = nativeRequest.mock.calls
      .find(([method]) => method === 'thread/start')?.[1] as { cwd: string };
    const turnStartParams = nativeRequest.mock.calls
      .find(([method]) => method === 'turn/start')?.[1] as {
        input: Array<{ text?: string; type: string }>;
      };
    expect(threadStartParams.cwd).toBe('/vault');
    expect(turnStartParams.input.find(block => block.type === 'text')?.text).toBe(
      'Inspect linked content\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt,
    );

    await session.dispose();
  });

  it.each([
    ['persistent', 'provider-default', true, undefined],
    ['ephemeral', 'provider-default', false, true],
    ['ephemeral', 'enabled', true, undefined],
  ] as const)(
    'resolves native persistence for %s sessions with %s policy',
    async (lifecycle, nativePersistence, expectedPersistence, expectedEphemeral) => {
      const threadId = `thread-provider-default-${lifecycle}`;
      const turnId = `turn-provider-default-${lifecycle}`;
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: wslTarget ? 'linux' : 'macos',
          };
        }
        if (method === 'thread/start') return createThreadResult(threadId);
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn(threadId, turnId));
          return createTurnResult(turnId);
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const session = createBackend(await createPlugin()).createSession(
        createSessionConfig({
          lifecycle,
          nativePersistence,
        }),
      );

      await collectEvents(session.execute(createRequest()).events);

      expect(nativeRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          persistExtendedHistory: expectedPersistence,
        }),
      );
      const startParams = nativeRequest.mock.calls.find(
        ([method]) => method === 'thread/start',
      )?.[1];
      expect(startParams!.ephemeral).toBe(expectedEphemeral);

      await session.dispose();
    },
  );

  it('keeps an orphaned transcript from an older missing-thread reset when the next send starts a thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claudian-codex-orphan-'));
    const sessions = join(root, 'sessions', '2026', '03', '27');
    mkdirSync(sessions, { recursive: true });
    const rollout = (threadId: string, question: string, answer: string) => [
      { type: 'session_meta', payload: { id: threadId } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: `${threadId}-turn` } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: `${threadId}-turn` } },
    ].map(record => JSON.stringify(record)).join('\n');
    const oldThreadId = '019a0000-0000-7000-8000-00000000000a';
    const oldPath = join(sessions, `rollout-2026-03-27T00-00-00-${oldThreadId}.jsonl`);
    writeFileSync(oldPath, rollout(oldThreadId, 'Old question', 'Old answer'));
    const newThreadId = '019a0000-0000-7000-8000-00000000000b';
    const newPath = join(sessions, `rollout-2026-03-27T01-00-00-${newThreadId}.jsonl`);
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { userAgent: 'test', codexHome: root, platformFamily: 'unix', platformOs: 'macos' };
      }
      if (method === 'thread/start') {
        const result = createThreadResult(newThreadId);
        return { ...result, thread: { ...result.thread, path: newPath } };
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn(newThreadId, `${newThreadId}-turn`));
        return createTurnResult(`${newThreadId}-turn`);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    // What the earlier missing-thread reset left: the thread binding is gone, its transcript locators remain.
    const orphanState = {
      sessionFilePath: oldPath,
      transcriptRootPath: join(root, 'sessions'),
      workspaceDependencyToolVersion: 1,
    };
    const history = new CodexConversationHistoryService();
    const contents = (update: { messages?: Array<{ content: string }> }) => (update.messages ?? []).map(message => message.content);
    try {
      const before = await history.hydrateConversationHistory({ sessionId: null, providerState: orphanState, messages: [] }, null);
      expect(contents(before)).toEqual(['Old question', 'Old answer']);

      const session = createBackend(await createPlugin()).createSession(createSessionConfig({
        resumeSeed: { providerState: { ...orphanState } },
      }));
      await collectEvents(session.execute(createRequest(new AbortController().signal, {
        conversationHistory: before.messages,
        input: [{ type: 'text', text: 'New question' }],
      })).events);
      const prompt = nativeRequest.mock.calls
        .find(([method]) => method === 'turn/start')![1].input!
        .find(item => item.type === 'text')!.text;
      writeFileSync(newPath, rollout(newThreadId, prompt, 'New answer'));
      const snapshot = session.getSnapshot();
      await session.dispose();

      expect(snapshot.providerState).toMatchObject({
        threadId: newThreadId,
        sessionFilePath: newPath,
        previousSegments: [{ threadId: oldThreadId, sessionFilePath: oldPath }],
      });
      const after = await history.hydrateConversationHistory({
        sessionId: snapshot.providerSessionId ?? null, providerState: snapshot.providerState, messages: [],
      }, null);
      expect(contents(after)).toEqual(['Old question', 'Old answer', 'New question', 'New answer']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains cold-start history replay until the first turn is handed off', async () => {
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        return createThreadResult('thread-retry');
      }
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) throw new CodexNativeResponseError({ code: -32602, message: 'turn rejected before handoff' });
        queueMicrotask(() => completeTurn('thread-retry', 'turn-retry'));
        return createTurnResult('turn-retry');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'retry prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'retry prior answer', timestamp: 2 },
    ];

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    const preHandoffSnapshot = session.getSnapshot();
    expect(preHandoffSnapshot.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: false,
      threadId: 'thread-retry',
    }));
    await session.dispose();

    const replacement = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: preHandoffSnapshot.providerSessionId,
          providerState: { ...preHandoffSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = nativeRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]).toContain('retry prior question');
    expect(turnRequests[1]).toContain('retry prior question');

    await replacement.dispose();
  });

  it('establishes native context when notification ordering proves early handoff', async () => {
    vi.useFakeTimers();
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start' || method === 'thread/resume') return createThreadResult('thread-early-handoff');
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          emitNotification('turn/started', {
            threadId: 'thread-early-handoff',
            turn: createTurnResult('turn-early-handoff-1').turn,
          });
          return new Promise(() => {});
        }
        queueMicrotask(() => completeTurn(
          'thread-early-handoff',
          'turn-early-handoff-2',
        ));
        return createTurnResult('turn-early-handoff-2');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'early prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'early prior answer', timestamp: 2 },
    ];

    const firstEventsPromise = collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    await native.waitForRequest('turn/start');
    await vi.advanceTimersByTimeAsync(30_000);
    const firstEvents = await firstEventsPromise;
    expect(firstEvents).toContainEqual(expect.objectContaining({
      accepted: true,
      type: 'turn_started',
    }));
    expect(session.getSnapshot().providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
    }));
    expect(firstEvents.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('Request timeout: turn/start') });
    completeTurn('thread-early-handoff', 'turn-early-handoff-1');
    await nativeRoundTrip();
    const retryEvents = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);
    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });

    const turnRequests = nativeRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests[0]).toContain('early prior question');
    expect(turnRequests[1]).not.toContain('early prior question');

    await session.dispose();
  });

  it('does not bind a new run to a late scoped notification from the previous turn', async () => {
    const threadId = 'thread-late-previous-scope';
    const firstTurnId = 'turn-previous';
    const secondTurnId = 'turn-current';
    let turnAttempt = 0;
    const secondTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          queueMicrotask(() => completeTurn(threadId, firstTurnId));
          return createTurnResult(firstTurnId);
        }

        emitNotification('thread/tokenUsage/updated', {
          threadId,
          turnId: firstTurnId,
          tokenUsage: {
            last: { inputTokens: 1, cachedInputTokens: 0 },
            modelContextWindow: 100,
          },
        });
        return secondTurnStart.promise;
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    try {
      await collectEvents(session.execute(createRequest()).events);

      const secondRun = session.execute(createRequest());
      const secondTurnStartedPromise = collectUntil(
        secondRun.events,
        event => event.type === 'turn_started',
      );
      await native.waitForRequest('turn/start', 0, 2);
      secondTurnStart.resolve(createTurnResult(secondTurnId));

      await expect(secondTurnStartedPromise).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          accepted: true,
          nativeTurnId: secondTurnId,
          type: 'turn_started',
        }),
      ]));
    } finally {
      await session.dispose();
    }
  });
  it('persists native context when cancellation races a turn-start acknowledgement', async () => {
    const controller = new AbortController();
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          controller.abort();
          return createTurnResult('turn-cancelled-ack');
        }
        queueMicrotask(() => completeTurn(
          'thread-cancelled-ack',
          'turn-after-cancelled-ack',
        ));
        return createTurnResult('turn-after-cancelled-ack');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'cancel prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'cancel prior answer', timestamp: 2 },
    ];

    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(event => sessionEvents.push(event));
    const cancelledEvents = await collectEvents(session.execute(createRequest(
      controller.signal,
      { conversationHistory },
    )).events);
    await session.dispose();
    expect([...cancelledEvents, ...sessionEvents]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
        }),
        type: 'session_state_changed',
      }),
    ]));
    const cancelledSnapshot = session.getSnapshot();
    expect(cancelledSnapshot.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
    }));
    await session.dispose();

    const replacement = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: cancelledSnapshot.providerSessionId,
          providerState: { ...cancelledSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = nativeRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]).toContain('cancel prior question');
    expect(turnRequests[1]).not.toContain('cancel prior question');

    await replacement.dispose();
  });

  it('publishes a late turn-start acknowledgement without resurrecting cancelled status', async () => {
    const turnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') {
        return createThreadResult('thread-late-turn-ack');
      }
      if (method === 'turn/start') return turnStart.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    const unsubscribe = session.onEvent(event => sessionEvents.push(event));
    const run = session.execute(createRequest());
    const runEvents = collectEvents(run.events);
    await native.waitForRequest('turn/start');

    run.cancel();
    expect((await runEvents).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(session.getSnapshot().status).toBe('idle');

    turnStart.resolve(createTurnResult('turn-late-ack'));
    await nativeRoundTrip();

    expect(session.getSnapshot()).toMatchObject({
      providerState: {
        nativeConversationContextEstablished: true,
      },
      status: 'idle',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: expect.objectContaining({ kind: 'session' }),
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
          status: 'idle',
        }),
        type: 'session_state_changed',
      }),
    ]));

    unsubscribe();
    await session.dispose();
  });

  it('persists a new thread identity when cancellation races its acknowledgement', async () => {
    const controller = new AbortController();
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') {
        controller.abort();
        return createThreadResult('thread-cancelled-start');
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-cancelled-start');
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn(
          'thread-cancelled-start',
          'turn-after-cancelled-start',
        ));
        return createTurnResult('turn-after-cancelled-start');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(event => sessionEvents.push(event));
    const cancelledEvents = await collectEvents(session.execute(createRequest(
      controller.signal,
    )).events);
    await session.dispose();
    expect([...cancelledEvents, ...sessionEvents]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'thread-cancelled-start',
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: false,
            threadId: 'thread-cancelled-start',
          }),
        }),
        type: 'session_state_changed',
      }),
    ]));
    const cancelledSnapshot = session.getSnapshot();
    expect(cancelledSnapshot.providerSessionId).toBe('thread-cancelled-start');
    await session.dispose();

    const replacement = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: cancelledSnapshot.providerSessionId,
          providerState: { ...cancelledSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest()).events);

    expect(nativeRequest.mock.calls.filter(
      ([method]) => method === 'thread/start',
    )).toHaveLength(1);
    expect(nativeRequest.mock.calls.filter(
      ([method]) => method === 'thread/resume',
    )).toHaveLength(1);

    await replacement.dispose();
  });

  it('publishes a late thread-start acknowledgement without resurrecting cancelled status', async () => {
    const threadStart = createDeferred<ReturnType<typeof createThreadResult>>();
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return threadStart.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    const unsubscribe = session.onEvent(event => sessionEvents.push(event));
    const run = session.execute(createRequest());
    const runEvents = collectEvents(run.events);
    await native.waitForRequest('thread/start');

    run.cancel();
    expect((await runEvents).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(session.getSnapshot().status).toBe('idle');

    threadStart.resolve(createThreadResult('thread-late-start-ack'));
    await nativeRoundTrip();

    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'thread-late-start-ack',
      providerState: {
        nativeConversationContextEstablished: false,
        threadId: 'thread-late-start-ack',
      },
      status: 'idle',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: expect.objectContaining({ kind: 'session' }),
        snapshot: expect.objectContaining({
          providerSessionId: 'thread-late-start-ack',
          status: 'idle',
        }),
        type: 'session_state_changed',
      }),
    ]));

    unsubscribe();
    await session.dispose();
  });

  it.each([
    ['explicitly disabled', 'disabled-if-supported', { kind: 'passive' }],
    ['passive auxiliary', 'provider-default', { kind: 'passive' }],
    ['inline edit', 'provider-default', { kind: 'read-only' }],
  ] as const)('retains a non-persistent %s thread for clarification', async (_name, nativePersistence, toolPolicy) => {
    let turnIndex = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') {
        const result = createThreadResult('thread-continuation');
        return { ...result, thread: { ...result.thread, ephemeral: true, path: null } };
      }
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-continuation-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-continuation', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence,
      }),
    );

    const firstEvents = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      { toolPolicy },
    )).events);
    const secondEvents = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        input: [{ type: 'text', text: 'clarification' }],
        toolPolicy,
      },
    )).events);

    expect(nativeRequest).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        ephemeral: true,
        persistExtendedHistory: false,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      }),
    );
    expect(firstEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(secondEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(session.getSnapshot().providerState?.sessionFilePath).toBeUndefined();
    expect(nativeRequest).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        threadId: 'thread-continuation',
        input: [expect.objectContaining({ type: 'text', text: 'clarification' })],
      }),
    );
    expect(
      nativeRequest.mock.calls.filter(call => call[0] === 'thread/start'),
    ).toHaveLength(1);
    expect(
      nativeRequest.mock.calls.filter(call => call[0] === 'turn/start'),
    ).toHaveLength(2);

    await session.dispose();
  });

  describe('when a native thread omits its rollout path', () => {
    const realFs = actualModule0;
    let codexHome: string;
    let sessionsRoot: string;
    let probes: MockInstance[];

    beforeEach(() => {
      codexHome = mkdtempSync(join(tmpdir(), 'claudian-codex-home-'));
      sessionsRoot = join(codexHome, 'sessions');
      mkdirSync(join(sessionsRoot, 'nested'), { recursive: true });
      probes = [
        vi.spyOn(realFs, 'existsSync'),
        vi.spyOn(realFs, 'readdirSync'),
        vi.spyOn(fsPromises, 'access'),
        vi.spyOn(fsPromises, 'readdir'),
      ];
    });

    afterEach(() => {
      for (const probe of probes) probe.mockRestore();
      rmSync(codexHome, { recursive: true, force: true });
    });

    function writeRollout(threadId: string): string {
      const rolloutPath = join(sessionsRoot, 'nested', `rollout-${threadId}.jsonl`);
      writeFileSync(rolloutPath, '');
      return rolloutPath;
    }

    function countTranscriptRootProbes(): number {
      return probes.reduce(
        (count, probe) => count + probe.mock.calls.filter(([target]) => normalize(String(target)) === sessionsRoot).length,
        0,
      );
    }

    function configurePathlessThread(threadId: string, ephemeral: boolean): void {
      let turnIndex = 0;
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return { userAgent: 'test', codexHome, platformFamily: 'unix', platformOs: 'macos' };
        }
        if (method === 'thread/start') {
          const result = createThreadResult(threadId);
          return { ...result, thread: { ...result.thread, ephemeral, path: null } };
        }
        if (method === 'turn/start') {
          turnIndex += 1;
          const turnId = `${threadId}-turn-${turnIndex}`;
          queueMicrotask(() => completeTurn(threadId, turnId));
          return createTurnResult(turnId);
        }
        throw new Error(`Unexpected method: ${method}`);
      });
    }

    it('never searches the transcript root for a non-persistent thread', async () => {
      configurePathlessThread('thread-ephemeral-pathless', true);
      writeRollout('thread-ephemeral-pathless');
      const session = createBackend(await createPlugin()).createSession(
        createSessionConfig({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' }),
      );

      await collectEvents(session.execute(createRequest()).events);
      await collectEvents(session.execute(createRequest()).events);
      await nativeRoundTrip();

      expect(countTranscriptRootProbes()).toBe(0);
      expect(session.getSnapshot().providerState?.sessionFilePath).toBeUndefined();

      await session.dispose();
    });

    it('adopts a persistent rollout found after release and publishes it as session state', async () => {
      configurePathlessThread('thread-persistent-pathless', false);
      const rolloutPath = writeRollout('thread-persistent-pathless');
      const session = createBackend(await createPlugin()).createSession(createSessionConfig());
      const adopted = new Promise<ProviderSessionEvent>((resolve) => {
        session.onEvent((event) => {
          if (
            event.type === 'session_state_changed'
            && event.snapshot.providerState?.sessionFilePath
          ) {
            resolve(event);
          }
        });
      });

      const events = await collectEvents(session.execute(createRequest()).events);

      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      await expect(adopted).resolves.toMatchObject({
        scope: { kind: 'session' },
        snapshot: {
          providerSessionId: 'thread-persistent-pathless',
          providerState: { sessionFilePath: rolloutPath },
        },
      });
      expect(session.getSnapshot().providerState?.sessionFilePath).toBe(rolloutPath);
      expect(probes[1].mock.calls).toHaveLength(0);

      await session.dispose();
    });

    it('searches once per persistent thread instead of after every run', async () => {
      configurePathlessThread('thread-persistent-missing', false);
      const session = createBackend(await createPlugin()).createSession(createSessionConfig());

      await collectEvents(session.execute(createRequest()).events);
      const probesAfterFirstRun = countTranscriptRootProbes();
      await collectEvents(session.execute(createRequest()).events);
      await nativeRoundTrip();

      expect(probesAfterFirstRun).toBeGreaterThan(0);
      expect(countTranscriptRootProbes()).toBe(probesAfterFirstRun);
      expect(session.getSnapshot().providerState?.sessionFilePath).toBeUndefined();

      await session.dispose();
    });
  });

  it('forks, resumes, and reverts an adopted child to the requested checkpoint before executing', async () => {
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/fork') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/revert') return createThreadResult('thread-fork');
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 2) {
          native.processes.at(-1)!.exit();
          return new Promise(() => {});
        }
        const turnId = `turn-fork-${turnAttempt}`;
        queueMicrotask(() => completeTurn('thread-fork', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerState: {
            forkSourceSessionFilePath: '/tmp/source.jsonl',
            forkSourceTranscriptRootPath: '/tmp/sessions',
            forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
            // An older missing-thread reset left the lost child's transcript; the fork re-materializes it.
            sessionFilePath: '/tmp/sessions/thread-lost-child.jsonl',
            unknownFutureState: { keep: true },
          },
        },
      }),
    );

    const forkEvents = await collectEvents(session.execute(createRequest()).events);

    expect(nativeRequest.mock.calls.map(call => call[0])).toEqual([
      'initialize',
      'thread/fork',
      'thread/resume',
      'thread/revert',
      'turn/start',
    ]);
    expect(nativeRequest).toHaveBeenCalledWith(
      'thread/revert',
      { threadId: 'thread-fork', beforeTurnId: 'later-turn' },
    );
    // The child inherits a source thread whose dependency-tool generation is unknown.
    expect(nativeRequest).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'thread-fork',
      experimentalRawEvents: true,
      baseInstructions: expect.stringContaining('predates Claudian client-hosted workspace dependency tools'),
    }));

    const forkedSnapshot = session.getSnapshot();
    expect(forkedSnapshot.providerState).toEqual(expect.objectContaining({
      threadId: 'thread-fork',
      unknownFutureState: { keep: true },
    }));
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSource');
    expect(forkedSnapshot.providerState).not.toHaveProperty('previousSegments');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceSessionFilePath');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceTranscriptRootPath');
    expect(forkedSnapshot.providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionFilePath',
      'forkSourceTranscriptRootPath',
      'pendingForkTarget',
    ]);
    expect(forkEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'idle',
      },
      type: 'session_state_changed',
    });

    const invalidatedEvents = await collectEvents(session.execute(createRequest()).events);
    expect(invalidatedEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'invalidated',
      },
      type: 'session_state_changed',
    });

    await collectEvents(session.execute(createRequest()).events);
    expect(nativeRequest.mock.calls.filter(call => call[0] === 'thread/fork'))
      .toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({
      providerState: {
        threadId: 'thread-fork',
        unknownFutureState: { keep: true },
      },
      providerStateDeletes: [
        'forkSource',
        'forkSourceSessionFilePath',
        'forkSourceTranscriptRootPath',
        'pendingForkTarget',
      ],
      status: 'idle',
    });

    await session.dispose();
  });

  it.each([
    ['checkpoint validation', 'checkpoint'] as const,
    ['thread resume', 'resume'] as const,
    ['thread revert', 'revert'] as const,
  ])(
    'retains one fork target across %s failure and retries its materialization',
    async (_description, failureBoundary) => {
      if (failureBoundary === 'revert') vi.useFakeTimers();
      let forkCount = 0;
      let resumeCount = 0;
      let revertCount = 0;
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: wslTarget ? 'linux' : 'macos',
          };
        }
        if (method === 'thread/fork') {
          forkCount += 1;
          if (forkCount > 1) throw new Error('second fork must not be issued');
          return createThreadResult(
            'thread-fork-target',
            failureBoundary === 'checkpoint'
              ? [{ id: 'different-checkpoint' }]
              : [{ id: 'checkpoint' }, { id: 'later-turn' }],
          );
        }
        if (method === 'thread/resume') {
          resumeCount += 1;
          if (failureBoundary === 'resume' && resumeCount === 1) {
            throw new CodexNativeResponseError({ code: -32602, message: 'resume rejected' });
          }
          return createThreadResult(
            'thread-fork-target',
            failureBoundary === 'checkpoint' && resumeCount === 1
              ? [{ id: 'different-checkpoint' }]
              : failureBoundary === 'revert' && resumeCount > 1
              ? [{ id: 'checkpoint' }]
              : [{ id: 'checkpoint' }, { id: 'later-turn' }],
          );
        }
        if (method === 'thread/revert') {
          revertCount += 1;
          if (failureBoundary === 'revert' && revertCount === 1) {
            return new Promise(() => {});
          }
          return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
        }
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-retry'));
          return createTurnResult('turn-after-retry');
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      let session = createBackend(await createPlugin()).createSession(
        createForkSessionConfig(),
      );
      const failedOutput = collectEvents(session.execute(createRequest()).events);
      if (failureBoundary === 'revert') {
        await native.waitForRequest('thread/revert');
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const failedEvents = await failedOutput;

      expect(failedEvents.at(-1)).toMatchObject({
        type: 'execution_error',
        message: expect.stringMatching(
          failureBoundary === 'checkpoint'
            ? /checkpoint not found/i
            : failureBoundary === 'resume'
              ? /resume rejected/i
          : /Request timeout: thread\/revert/i,
        ),
      });
      expectPendingForkOwnershipEvent(failedEvents);
      expectPendingForkOwnership(session, failureBoundary === 'revert' ? 'invalidated' : 'idle');

      if (failureBoundary === 'checkpoint') {
        const pendingSnapshot = session.getSnapshot();
        await session.dispose();
        session = createBackend(await createPlugin()).createSession(
          createSessionConfig({
            resumeSeed: {
              providerSessionId: pendingSnapshot.providerSessionId,
              providerState: { ...pendingSnapshot.providerState },
            },
          }),
        );
      }

      const retryEvents = await collectEvents(session.execute(createRequest()).events);

      expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(forkCount).toBe(1);
      expect(resumeCount).toBeGreaterThanOrEqual(1);
      expect(revertCount).toBe(1);
      expect(session.getSnapshot()).toMatchObject({
        providerSessionId: 'thread-fork-target',
        providerState: {
          threadId: 'thread-fork-target',
          unknownFutureState: { keep: true },
        },
        providerStateDeletes: expect.arrayContaining([
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ]),
        status: 'idle',
      });
      expect(session.getSnapshot().providerState).not.toHaveProperty('forkSource');
      expect(session.getSnapshot().providerState).not.toHaveProperty('pendingForkTarget');

      await session.dispose();
    },
  );

  it('joins fork setup through cancellation and retries the adopted child immediately', async () => {
    const firstResume = createDeferred<ReturnType<typeof createThreadResult>>();
    let resumeCount = 0;
    let forkCount = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return resumeCount === 1
          ? firstResume.promise
          : createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/revert') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-cancel'));
        return createTurnResult('turn-after-cancel');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await native.waitForRequest('thread/resume');

    run.cancel();
    let cancellationSettled = false;
    void eventsPromise.then(() => { cancellationSettled = true; });
    await nativeRoundTrip();

    expect(cancellationSettled).toBe(false);
    expect(transportDispose).not.toHaveBeenCalled();
    expect(mockProcessShutdown).not.toHaveBeenCalled();
    expect(() => session.execute(createRequest())).toThrow(/active/i);
    firstResume.resolve(createThreadResult('thread-fork-target', [
      { id: 'checkpoint' },
      { id: 'later-turn' },
    ]));
    const cancelledEvents = await eventsPromise;
    expect(cancelledEvents.at(-1)).toMatchObject({ type: 'cancelled' });
    expectPendingForkOwnershipEvent(cancelledEvents);
    expectPendingForkOwnership(session);

    const retryEvents = await collectEvents(session.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await session.dispose();
  });

  it('joins fork setup through disposal and publishes the adopted child for recreation', async () => {
    const firstResume = createDeferred<ReturnType<typeof createThreadResult>>();
    let resumeCount = 0;
    let forkCount = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return resumeCount === 1
          ? firstResume.promise
          : createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/revert') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-dispose'));
        return createTurnResult('turn-after-dispose');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await native.waitForRequest('thread/resume');

    const disposing = session.dispose();
    let disposalSettled = false;
    void disposing.then(() => { disposalSettled = true; });
    await nativeRoundTrip();

    expect(disposalSettled).toBe(false);
    expect(transportDispose).not.toHaveBeenCalled();
    expect(mockProcessShutdown).not.toHaveBeenCalled();
    firstResume.resolve(createThreadResult('thread-fork-target', [
      { id: 'checkpoint' },
      { id: 'later-turn' },
    ]));
    await disposing;
    const disposedEvents = await eventsPromise;
    expect(disposedEvents.at(-1)).toMatchObject({ type: 'cancelled' });
    expectPendingForkOwnershipEvent(disposedEvents);
    expectPendingForkOwnership(session, 'disposed');

    const disposedSnapshot = session.getSnapshot();
    const recreated = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: disposedSnapshot.providerSessionId,
          providerState: { ...disposedSnapshot.providerState },
        },
      }),
    );
    const retryEvents = await collectEvents(recreated.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await recreated.dispose();
  });

  it('joins a decoded resume continuation across process exit before retrying the adopted child', async () => {
    const resumeDecoded = createDeferred<void>();
    const releaseContinuation = createDeferred<void>();
    const request = CodexRPCTransport.prototype.request;
    let holdResume = true;
    // Internal seam: hold a decoded request continuation, not an impossible wire reply after exit.
    vi.spyOn(CodexRPCTransport.prototype, 'request').mockImplementation(async function<T>(
      this: CodexRPCTransport, method: string, ...args: [unknown, number?, AbortSignal?]
    ): Promise<T> {
      const result = await request.call(this, method, ...args);
      if (method === 'thread/resume' && holdResume) {
        holdResume = false;
        resumeDecoded.resolve();
        await releaseContinuation.promise;
      }
      return result as T;
    });
    let resumeCount = 0;
    let forkCount = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/fork') {
        forkCount += 1;
        return createThreadResult('thread-fork-target', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        resumeCount += 1;
        return createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
      }
      if (method === 'thread/revert') {
        return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
      }
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-process-exit'));
        return createTurnResult('turn-after-process-exit');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(
      createForkSessionConfig(),
    );
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);
    await resumeDecoded.promise;

    native.processes.at(-1)!.exit();
    let exitSettled = false;
    void eventsPromise.then(() => { exitSettled = true; });
    await nativeRoundTrip();

    expect(exitSettled).toBe(false);
    expect(transportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).not.toHaveBeenCalled();
    expect(() => session.execute(createRequest())).toThrow(/active/i);
    releaseContinuation.resolve();
    const exitedEvents = await eventsPromise;
    expect(exitedEvents.at(-1)).toMatchObject({
      type: 'execution_error',
      category: 'process-exited',
    });
    expectPendingForkOwnershipEvent(exitedEvents);
    expectPendingForkOwnership(session, 'invalidated');

    const retryEvents = await collectEvents(session.execute(createRequest()).events);

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(forkCount).toBe(1);
    expect(resumeCount).toBe(2);
    await session.dispose();
  });

  it.each(['cancellation', 'disposal'] as const)(
    'resolves an unknown fork identity before %s releases its thread binding',
    async (lifecycle) => {
      const forkResult = createDeferred<ReturnType<typeof createThreadResult>>();
      let forkResponseDelivered = false;
      let forkCount = 0;
      let resumeCount = 0;
      const teardownSnapshots: unknown[] = [];
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: wslTarget ? 'linux' : 'macos',
          };
        }
        if (method === 'thread/read') return createThreadResult('thread-fork-target');
        if (method === 'thread/fork') {
          forkCount += 1;
          return forkResult.promise;
        }
        if (method === 'thread/resume') {
          resumeCount += 1;
          return createThreadResult('thread-fork-target', [
            { id: 'checkpoint' },
            { id: 'later-turn' },
          ]);
        }
        if (method === 'thread/revert') {
          return createThreadResult('thread-fork-target', [{ id: 'checkpoint' }]);
        }
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-fork-target', 'turn-after-late-fork'));
          return createTurnResult('turn-after-late-fork');
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const session = createBackend(await createPlugin()).createSession(
        createForkSessionConfig(),
      );
      nativeUnsubscribe.mockImplementationOnce(async () => {
        teardownSnapshots.push(session.getSnapshot());
        if (!forkResponseDelivered) {
          forkResult.reject(new CodexNativeResponseError({ code: -32603, message: 'Thread unsubscribed before fork identity was delivered' }));
        }
        return { status: 'unsubscribed' };
      });
      const run = session.execute(createRequest());
      const eventsPromise = collectEvents(run.events);
      await native.waitForRequest('thread/fork');

      const lifecyclePromise = lifecycle === 'cancellation'
        ? (run.cancel(), eventsPromise.then(() => undefined))
        : session.dispose();
      let lifecycleSettled = false;
      void lifecyclePromise.then(() => { lifecycleSettled = true; });
      await nativeRoundTrip();

      expect(lifecycleSettled).toBe(false);
      expect(transportDispose).not.toHaveBeenCalled();
      expect(mockProcessShutdown).not.toHaveBeenCalled();

      forkResponseDelivered = true;
      forkResult.resolve(createThreadResult('thread-fork-target', [
        { id: 'checkpoint' },
        { id: 'later-turn' },
      ]));
      await lifecyclePromise;
      const lifecycleEvents = await eventsPromise;
      expect(lifecycleEvents.at(-1)).toMatchObject({ type: 'cancelled' });
      expectPendingForkOwnershipEvent(lifecycleEvents);
      expect(teardownSnapshots).toMatchObject(lifecycle === 'disposal' ? [{
        providerSessionId: 'thread-fork-target',
        providerState: {
          forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
          pendingForkTarget: { threadId: 'thread-fork-target' },
        },
      }] : []);
      expectPendingForkOwnership(
        session,
        lifecycle === 'disposal' ? 'disposed' : 'idle',
      );
      expect(transportDispose).not.toHaveBeenCalled();
      expect(mockProcessShutdown).not.toHaveBeenCalled();
      expect(resumeCount).toBe(0);

      const retrySession = lifecycle === 'disposal'
        ? createBackend(await createPlugin()).createSession(
          createSessionConfig({
            resumeSeed: {
              providerSessionId: session.getSnapshot().providerSessionId,
              providerState: { ...session.getSnapshot().providerState },
            },
          }),
        )
        : session;
      const retryEvents = await collectEvents(
        retrySession.execute(createRequest()).events,
      );

      expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(forkCount).toBe(1);
      expect(resumeCount).toBe(1);
      await retrySession.dispose();
    },
  );

  it.each([
    ['passive', { kind: 'passive' }],
    ['read-only', { kind: 'read-only' }],
  ] as const)(
    'creates an ephemeral %s session with non-persistent strict policy',
    async (_name, toolPolicy) => {
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: wslTarget ? 'linux' : 'macos',
          };
        }
        if (method === 'thread/start') {
          const result = createThreadResult('thread-ephemeral');
          return { ...result, thread: { ...result.thread, ephemeral: true, path: null } };
        }
        if (method === 'turn/start') {
          queueMicrotask(() => completeTurn('thread-ephemeral', 'turn-ephemeral'));
          return createTurnResult('turn-ephemeral');
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const session = createBackend(await createPlugin()).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      const events = await collectEvents(session.execute(createRequest(
        new AbortController().signal,
        { toolPolicy },
      )).events);

      expect(nativeRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          ephemeral: true,
          persistExtendedHistory: false,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        }),
      );
      expect(nativeRequest).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            access: { type: 'fullAccess' },
            networkAccess: false,
          },
        }),
      );
      const startParams = nativeRequest.mock.calls.find(
        call => call[0] === 'thread/start',
      )?.[1];
      expect(startParams!.dynamicTools).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(session.getSnapshot().providerState?.sessionFilePath).toBeUndefined();

      await session.dispose();
    },
  );

  it('fails closed before native startup when exact allow-list enforcement is unavailable', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-allow-list');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-allow-list', 'turn-allow-list'));
        return createTurnResult('turn-allow-list');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    const events = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        toolPolicy: {
          kind: 'allow-list',
          names: ['codex_app.load_workspace_dependencies'],
        },
      },
    )).events);

    expect(resolveCliPath).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(nativeRequest).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'configuration',
        message: expect.stringContaining('allow-list'),
        recoverable: false,
        type: 'execution_error',
      }),
    ]));

    await session.dispose();
  });

  it('quarantines a cancelled turn before its start response and fences its late events from retry', async () => {
    const firstTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    const secondTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    let initializeCount = 0;
    let turnStartCount = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        initializeCount += 1;
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-cancel-race');
      if (method === 'thread/resume') return createThreadResult('thread-cancel-race');
      if (method === 'turn/start') {
        turnStartCount += 1;
        return turnStartCount === 1
          ? firstTurnStart.promise
          : secondTurnStart.promise;
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const firstRun = session.execute(createRequest());
    await native.waitForRequest('turn/start');
    const oldProcess = native.processes.at(-1)!;
    const oldTurnStarted = (params: unknown) => oldProcess.notify('turn/started', params);
    const oldTextDelta = (params: unknown) => oldProcess.notify('item/agentMessage/delta', params);

    firstRun.cancel();

    const firstEvents = await collectEvents(firstRun.events);
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(transportDispose).not.toHaveBeenCalled();
    expect(mockProcessShutdown).not.toHaveBeenCalled();

    const secondRun = session.execute(createRequest());
    await nativeRoundTrip();
    expect(turnStartCount).toBe(1);
    oldTurnStarted({
      threadId: 'thread-cancel-race',
      turn: createTurnResult('turn-old').turn,
    });
    oldTextDelta({
      threadId: 'thread-cancel-race',
      turnId: 'turn-old',
      itemId: 'assistant-old',
      delta: 'late old output',
    });
    firstTurnStart.resolve(createTurnResult('turn-old'));
    await native.waitForRequest('turn/start', 0, 2);
    oldTurnStarted({ threadId: 'thread-cancel-race', turn: createTurnResult('turn-old').turn });
    oldTextDelta({ threadId: 'thread-cancel-race', turnId: 'turn-old', itemId: 'assistant-old', delta: 'late old output' });
    secondTurnStart.resolve(createTurnResult('turn-new'));
    await nativeRoundTrip();
    expect(initializeCount).toBe(1);
    completeTurn('thread-cancel-race', 'turn-new');

    const secondEvents = await collectEvents(secondRun.events);
    expect(secondEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: true,
        nativeTurnId: 'turn-new',
        type: 'turn_started',
      }),
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({ nativeTurnId: 'turn-old' }));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({ text: 'late old output' }));
    expect(mockProcessStart).toHaveBeenCalledTimes(1);

    await session.dispose();
  });

  it.each([
    'native spawn',
    'transport start',
    'initialize',
  ] as const)(
    'cleans up exactly once when %s fails during app-server startup',
    async (failureBoundary) => {
      const failure = new Error(`Failed at ${failureBoundary}`);
      // Native spawn can fail before a handle exists; transport can fail before reading it.
      if (failureBoundary === 'native spawn') {
        vi.mocked(spawn).mockImplementationOnce(() => {
          throw failure;
        });
      } else if (failureBoundary === 'transport start') {
        transportStart.mockImplementationOnce(() => {
          throw failure;
        });
      }
      nativeRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          if (failureBoundary === 'initialize') throw failure;
          return {
            userAgent: 'test',
            codexHome: '/tmp/.codex',
            platformFamily: 'unix',
            platformOs: wslTarget ? 'linux' : 'macos',
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const session = createBackend(await createPlugin())
        .createSession(createSessionConfig());

      const events = await collectEvents(session.execute(createRequest()).events);

      expect(events.at(-1)).toEqual(expect.objectContaining({
        message: expect.stringContaining(`Failed at ${failureBoundary}`),
        type: 'execution_error',
      }));
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(transportDispose).toHaveBeenCalledTimes(1);

      await session.dispose();
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(transportDispose).toHaveBeenCalledTimes(1);
    },
  );

  it('honors an already-aborted request without launching the app-server', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    const events = await collectEvents(
      session.execute(createRequest(controller.signal)).events,
    );

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(mockProcessStart).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('forwards request-scoped ultra effort and mode configuration on a later turn', async () => {
    let turnIndex = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        return createThreadResult('thread-config');
      }
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-config-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-config', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    const codexConfig = (
      plugin.settings.providerConfigs as Record<string, Record<string, unknown>>
    ).codex;
    codexConfig.enableUltraEffort = true;
    codexConfig.discoveredModels = [
      {
        ...(codexConfig.discoveredModels as Array<Record<string, unknown>>)[0],
        supportedReasoningEfforts: [
          { value: 'high', description: 'Deep reasoning' },
          { value: 'ultra', description: 'Automatic task delegation' },
        ],
        defaultReasoningEffort: 'high',
      },
    ];
    const session = createBackend(plugin).createSession(createSessionConfig());
    await collectEvents(session.execute(createRequest()).events);
    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        configuration: {
          systemInstructions: { kind: 'explicit', instructions: 'Plan.' },
          model: TEST_CODEX_MODEL,
          reasoning: 'ultra',
          serviceTier: 'priority',
          permissionMode: 'yolo',
        },
      },
    )).events);

    const secondTurnParams = nativeRequest.mock.calls
      .filter(call => call[0] === 'turn/start')[1][1];
    expect(secondTurnParams).toEqual(expect.objectContaining({
      effort: 'ultra',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'ultra' }),
      }),
      serviceTier: 'priority',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }));

    await session.dispose();
  });

  it('rejects explicit High when the selected model does not advertise it', async () => {
    const plugin = await createPlugin();
    const models = getCodexProviderSettings(plugin.settings).discoveredModels;
    models[0].supportedReasoningEfforts = [{ value: 'medium', description: '' }];
    updateCodexProviderSettings(plugin.settings, { discoveredModels: models });
    const session = createBackend(plugin).createSession(createSessionConfig());
    const request = createRequest();
    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, reasoning: 'high' },
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', message: expect.stringContaining('does not support reasoning effort "high"') }));
    expect(nativeRequest).not.toHaveBeenCalled();
    await session.dispose();
  });

  it.each([null, 'low'])('preserves the explicit toolbar reasoning %s over saved defaults', async reasoning => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' };
      if (method === 'thread/start') return createThreadResult('thread-toolbar');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-toolbar', 'turn-toolbar'));
        return createTurnResult('turn-toolbar');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    plugin.settings.savedProviderEffort = { codex: 'high' };
    const session = createBackend(plugin).createSession(createSessionConfig());
    const request = createRequest();
    await collectEvents(session.execute({ ...request, configuration: { ...request.configuration, reasoning } }).events);
    const turn = nativeRequest.mock.calls.find(call => call[0] === 'turn/start')?.[1];
    expect(turn).toMatchObject({ model: TEST_CODEX_MODEL, effort: reasoning,
      collaborationMode: { settings: { reasoning_effort: reasoning } } });
    await session.dispose();
  });

  it.each([false, true])('validates saved ultra effort against the setting and auxiliary request model (qualified: %s)', async qualified => {
    let turnIndex = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: wslTarget ? 'linux' : 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-auxiliary-effort');
      if (method === 'turn/start') {
        turnIndex += 1;
        const turnId = `turn-auxiliary-effort-${turnIndex}`;
        queueMicrotask(() => completeTurn('thread-auxiliary-effort', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const plugin = await createPlugin();
    const settings = plugin.settings as Record<string, unknown>;
    const providerConfigs = settings.providerConfigs as Record<string, Record<string, unknown>>;
    const currentCodexConfig = providerConfigs.codex;
    const currentModels = currentCodexConfig.discoveredModels as Array<Record<string, unknown>>;
    settings.savedProviderEffort = { codex: 'ultra' };
    providerConfigs.codex = {
      ...currentCodexConfig,
      enableUltraEffort: false,
      discoveredModels: [
        {
          ...currentModels[0],
          supportedReasoningEfforts: [
            { value: 'high', description: 'Deep reasoning' },
            { value: 'ultra', description: 'Automatic task delegation' },
          ],
          defaultReasoningEffort: 'high',
        },
        {
          ...currentModels[0],
          model: 'gpt-5.6-luna',
          displayName: 'GPT-5.6-Luna',
          supportedReasoningEfforts: [
            { value: 'low', description: 'Fast responses' },
            { value: 'medium', description: 'Balanced' },
          ],
          defaultReasoningEffort: 'medium',
          isDefault: false,
        },
      ],
    };
    const session = createBackend(plugin).createSession(createSessionConfig());
    const createAuxiliaryRequest = (model: string): ProviderExecutionRequest => createRequest(
      new AbortController().signal,
      {
        configuration: {
          model: qualified ? `openai-codex/${model}` : model,
          permissionMode: 'normal',
          systemInstructions: { kind: 'explicit', instructions: 'Be concise.' },
        },
      },
    );

    await collectEvents(session.execute(createAuxiliaryRequest(TEST_CODEX_MODEL)).events);
    providerConfigs.codex.enableUltraEffort = true;
    await collectEvents(session.execute(createAuxiliaryRequest('gpt-5.6-luna')).events);

    const turnParams = nativeRequest.mock.calls
      .filter(call => call[0] === 'turn/start')
      .map(call => call[1]);
    expect(turnParams[0]).toEqual(expect.objectContaining({
      model: TEST_CODEX_MODEL,
      effort: 'high',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'high' }),
      }),
    }));
    expect(turnParams[1]).toEqual(expect.objectContaining({
      model: 'gpt-5.6-luna',
      effort: 'high',
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ reasoning_effort: 'high' }),
      }),
    }));

    await session.dispose();
  });

  it.each([
    { texts: ['/compact keep recent edits'] },
    { texts: ['/compact', 'keep recent edits'] },
  ])('rejects explicit compact instructions across text blocks: $texts', async ({ texts }) => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' };
      if (method === 'thread/start') return createThreadResult('thread-compact-args');
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    try {
      const events = await collectEvents(session.execute(createRequest(new AbortController().signal, {
        input: texts.map(text => ({ type: 'text', text })),
      })).events);
      expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: '/compact does not accept arguments' });
      expect(nativeRequest.mock.calls.filter(([method]) => method === 'turn/start' || method === 'thread/compact/start')).toEqual([]);
    } finally { await session.dispose(); }
  });

  it('rejects compact before handoff while canonical history still needs recovery', async () => {
    const session = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: 'thread-recovery',
          providerState: {
            threadId: 'thread-recovery',
            nativeConversationContextEstablished: false,
          },
        },
      }),
    );
    const events = await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        input: [{ type: 'text', text: '/compact' }],
        conversationHistory: [
          {
            id: 'history-user',
            role: 'user',
            content: 'Prior question that still needs recovery.',
            timestamp: 1,
          },
          {
            id: 'history-assistant',
            role: 'assistant',
            content: 'Prior answer that still needs recovery.',
            timestamp: 2,
          },
        ],
      },
    )).events);

    expect(resolveCliPath).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(nativeRequest).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'execution_error',
      category: 'configuration',
      recoverable: true,
      message: expect.stringContaining('native context'),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'turn_started',
    }));
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'thread-recovery',
      status: 'idle',
      providerState: {
        threadId: 'thread-recovery',
        nativeConversationContextEstablished: false,
      },
    });

    await session.dispose();
  });

  it('rejects an ambiguous steer failure after native handoff during lifecycle disposal', async () => {
    const steerResult = createDeferred<{ turnId: string }>();
    configureNativeTurn(
      'thread-steer-dispose',
      'turn-steer-dispose',
      () => steerResult.promise,
    );
    const { session, runEvents } = await createActiveSteerSession();

    const steering = session.steer(createImageRequest());
    await native.waitForRequest('turn/steer');
    const filePath = nativeImagePath(nativeRequest.mock.calls.find(([method]) => method === 'turn/steer')![1].input);
    expect(readFileSync(filePath)).toEqual(Buffer.from('hello'));
    const disposing = session.dispose();
    expect(existsSync(dirname(filePath))).toBe(true);
    steerResult.reject(new CodexNativeResponseError({ code: -32603, message: 'Native failure after steer handoff' }));

    await expect(steering).rejects.toThrow(
      'Native failure after steer handoff',
    );
    await expect(disposing).resolves.toBeUndefined();
    await runEvents;
    expect(existsSync(dirname(filePath))).toBe(false);
  });

  it('keeps a matching native steer acknowledgement after the session becomes stale', async () => {
    const steerResult = createDeferred<{ turnId: string }>();
    configureNativeTurn(
      'thread-steer-stale',
      'turn-steer-stale',
      () => steerResult.promise,
    );
    const { session, runEvents } = await createActiveSteerSession();

    const steering = session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ));
    await native.waitForRequest('turn/steer');
    steerResult.resolve({ turnId: 'turn-steer-stale' });
    const disposing = session.dispose();

    await expect(steering).resolves.toBe(true);
    await expect(disposing).resolves.toBeUndefined();
    await runEvents;
  });

  it.each([
    ['mismatched', { turnId: 'different-turn' }],
    ['malformed', {}],
  ])('rejects a %s native steer acknowledgement as ambiguous', async (
    _description,
    steerAcknowledgement,
  ) => {
    configureNativeTurn(
      'thread-steer-ack',
      'turn-steer-ack',
      () => steerAcknowledgement,
    );
    const { run, session, runEvents } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).rejects.toThrow('Codex returned an ambiguous steer acknowledgement.');

    run.cancel();
    await runEvents;
    await session.dispose();
  });

  it('returns false for an explicit native steer rejection', async () => {
    configureNativeTurn('thread-steer-reject', 'turn-steer-reject', () => {
      throw new CodexNativeResponseError({
        code: -32602,
        message: 'Invalid steer parameters',
      });
    });
    const { run, session, runEvents } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).resolves.toBe(false);

    run.cancel();
    await runEvents;
    await session.dispose();
  });

  it('rejects a native internal steer error as an ambiguous disposition', async () => {
    configureNativeTurn(
      'thread-steer-internal-error',
      'turn-steer-internal-error',
      () => {
        throw new CodexNativeResponseError({
          code: -32603,
          message: 'Internal error after steer dispatch',
        });
      },
    );
    const { run, session, runEvents } = await createActiveSteerSession();

    await expect(session.steer(createRequest(
      new AbortController().signal,
      { input: [{ type: 'text', text: 'redirect' }] },
    ))).rejects.toThrow('Internal error after steer dispatch');

    run.cancel();
    await runEvents;
    await session.dispose();
  });

  it('rejects a native steer timeout as an ambiguous disposition', async () => {
    vi.useFakeTimers();
    configureNativeTurn('thread-steer-timeout', 'turn-steer-timeout', () => new Promise(() => {}));
    const { run, session, runEvents } = await createActiveSteerSession();
    try {
      const steering = session.steer(createRequest(
        new AbortController().signal,
        { input: [{ type: 'text', text: 'redirect' }] },
      ));
      const outcome = steering.then(() => null, error => error);
      await native.waitForRequest('turn/steer');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/Request timeout: turn\/steer/) }));
      run.cancel();
      await runEvents;
      await session.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('returns false before native steer handoff when no active turn exists', async () => {
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Codex session should be steerable');
    }

    await expect(session.steer(createRequest())).resolves.toBe(false);
    expect(nativeRequest).not.toHaveBeenCalledWith(
      'turn/steer',
      expect.anything(),
    );

    await session.dispose();
  });
});

vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof import('node:fs')>('node:fs') }));

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
