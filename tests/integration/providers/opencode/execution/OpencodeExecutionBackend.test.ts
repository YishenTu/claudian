import { EventEmitter, once } from 'node:events';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import {
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
} from '@/core/execution';
import { decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import {
  type OpencodeNativeSessionInfo,
  type OpencodeSessionKernel,
  type OpencodeSessionKernelOptions,
  OpencodeSessionMissingError,
} from '@/providers/opencode/execution/OpencodeSessionContract';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import type { OpencodePrompt } from '@/providers/opencode/runtime/buildOpencodePrompt';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const lifecycleEvents = new EventEmitter();

class FakeKernel implements OpencodeSessionKernel {
  readonly connectCalls: unknown[] = [];
  readonly openedResumeIds: Array<string | undefined> = [];
  readonly configCalls: Array<Record<string, unknown>> = [];
  readonly autoApproveCalls: boolean[] = [];
  readonly prompts: unknown[] = [];
  cancelCalls = 0;
  disposeCalls = 0;
  configError: unknown = null;
  openSessionError: unknown = null;
  onOpenSession: (() => void) | null = null;
  onConfigure: (() => void) | null = null;
  promptResult: Awaited<ReturnType<OpencodeSessionKernel['prompt']>> = { userMessageId: 'native-user' };
  private resolvePrompt: ((value: typeof this.promptResult) => void) | null = null;
  private deferredOpenSession: Deferred<OpencodeNativeSessionInfo> | null = null;
  private deferredDisposal: Deferred<void> | null = null;
  sessionInfo: OpencodeNativeSessionInfo = {
    sessionId: 'native-session',
    databasePath: '/native/opencode.db',
    models: [{
      rawId: 'anthropic/claude', providerID: 'anthropic', id: 'claude', label: 'anthropic/Claude',
      variants: ['low', 'high'], contextWindow: 0,
    }],
  };

  readonly hasNativeWork = false;

  constructor(readonly options: OpencodeSessionKernelOptions) {}

  async whenIdle(): Promise<void> {}

  async steer(): Promise<boolean> {
    return false;
  }

  async connect(options: unknown): Promise<void> {
    this.connectCalls.push(options);
  }

  async openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo> {
    this.openedResumeIds.push(resumeSessionId);
    lifecycleEvents.emit('changed');
    this.onOpenSession?.();
    if (this.openSessionError) throw this.openSessionError;
    if (this.deferredOpenSession) return this.deferredOpenSession.promise;
    return this.sessionInfo;
  }

  async setAgent(sessionId: string, agent: string): Promise<void> {
    this.configure({ sessionId, agent });
  }

  async setModel(sessionId: string, rawModelId: string, variant?: string): Promise<void> {
    this.configure({ sessionId, rawModelId, variant });
  }

  private configure(request: Record<string, unknown>): void {
    this.configCalls.push(request);
    this.onConfigure?.();
    if (this.configError) throw this.configError;
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApproveCalls.push(enabled);
  }

  async prompt(sessionId: string, input: OpencodePrompt): Promise<typeof this.promptResult> {
    this.prompts.push({ sessionId, ...input });
    return new Promise((resolve) => {
      this.resolvePrompt = resolve;
      lifecycleEvents.emit('changed');
    });
  }

  async readTurnStats(): Promise<undefined> {
    return undefined;
  }

  completePrompt(): void {
    this.resolvePrompt?.(this.promptResult);
    this.resolvePrompt = null;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.deferredDisposal?.promise;
  }

  deferDisposal(): Deferred<void> {
    const deferred = createDeferred<void>();
    this.deferredDisposal = deferred;
    return deferred;
  }

  deferOpenSession(): Deferred<OpencodeNativeSessionInfo> {
    const deferred = createDeferred<OpencodeNativeSessionInfo>();
    this.deferredOpenSession = deferred;
    return deferred;
  }

  output(text: string): void {
    this.options.onNativeOutput?.({ type: 'text_delta', text });
  }

  close(error = new Error('process closed')): void {
    this.options.onClosed(error);
  }
}

async function createPlugin() {
  return (await createProviderHostFixture({
    settings: {
      effortLevel: 'high', model: 'opencode:anthropic/claude', permissionMode: 'normal',
      providerConfigs: { opencode: {
        enabled: true, discoveredModels: [{ label: 'Claude', rawId: 'anthropic/claude' }],
        visibleModels: ['anthropic/claude'],
      } },
    },
    overrides: { getResolvedProviderCliPath: async () => '/bin/opencode' },
  })).host;
}

let plugin: Awaited<ReturnType<typeof createPlugin>>;
beforeEach(async () => { plugin = await createPlugin(); });

function createConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  const interactionPort: ProviderInteractionPort = {
    requestApproval: vi.fn(async ({ interactionId }) => ({
      interactionId,
      decision: 'allow' as const,
    })),
    askUserQuestion: vi.fn(),
    dismissInteraction: vi.fn(),
  };
  return {
    interactionPort,
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: '/vault',
    ...overrides,
  };
}

function createRequest(overrides: Partial<ProviderExecutionRequest> = {}): ProviderExecutionRequest {
  return {
    configuration: {
      systemInstructions: { kind: 'main-agent' as const, instructions: 'Main Agent prompt.' },
      model: 'opencode:anthropic/claude',
      reasoning: 'high',
      permissionMode: 'normal',
    },
    conversationHistory: [],
    input: [{ type: 'text', text: 'hello' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const values: ProviderExecutionEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

async function waitForPrompt(kernel: FakeKernel, count = 1): Promise<void> {
  await waitForCondition(() => kernel.prompts.length >= count);
  expect(kernel.prompts).toHaveLength(count);
}

async function kernelAt(kernels: FakeKernel[], index = 0): Promise<FakeKernel> {
  await waitForCondition(() => kernels.length > index);
  return kernels[index];
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const signal = AbortSignal.timeout(1_000);
  while (!condition()) await once(lifecycleEvents, 'changed', { signal });
}

/** `onKernel` configures each kernel before the session connects it. */
function createHarness(config = createConfig(), onKernel?: (kernel: FakeKernel) => void) {
  const kernels: FakeKernel[] = [];
  const backend = new OpencodeExecutionBackend(plugin.getRuntimeHost('opencode'), {
    serverService: new OpencodeServerService(),
    createKernel: (options) => {
      const kernel = new FakeKernel(options);
      kernels.push(kernel);
      lifecycleEvents.emit('changed');
      onKernel?.(kernel);
      return kernel;
    },
  });
  const session = backend.createSession(config);
  session.onEvent(() => lifecycleEvents.emit('changed'));
  return { backend, kernels, session };
}

describe('OpencodeExecutionBackend', () => {
  it('rejects an unavailable selected model before native startup with a configuration error', async () => {
    const { session, kernels } = createHarness();
    const selected = plugin.settings.providerConfigs.opencode!.visibleModels;
    plugin.settings.providerConfigs.opencode!.visibleModels = [];
    const events = await collect(session.execute(createRequest()).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', category: 'configuration' }));
    expect(events.some(event => event.type === 'turn_started' && event.accepted)).toBe(false);
    expect(kernels).toEqual([]);
    plugin.settings.providerConfigs.opencode!.visibleModels = selected;
    await session.dispose();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not acquire a native server when a turn is cancelled during CLI resolution', async () => {
    const cliPath = createDeferred<string | null>();
    const host = await createPlugin();
    host.getResolvedProviderCliPath = vi.fn(() => { lifecycleEvents.emit('changed'); return cliPath.promise; });
    const serverService = new OpencodeServerService();
    const acquire = vi.spyOn(serverService, 'acquire');
    const session = new OpencodeExecutionBackend(host.getRuntimeHost('opencode'), { serverService }).createSession(createConfig());
    const run = session.execute(createRequest());
    const events = collect(run.events);
    await waitForCondition(() => vi.mocked(host.getResolvedProviderCliPath).mock.calls.length === 1);

    run.cancel();
    cliPath.resolve('/bin/opencode');

    await expect(events).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    expect(acquire).not.toHaveBeenCalled();
    await session.dispose();
    await serverService.dispose();
  });

  it('reports provider cancellation', async () => {
    const harness = createHarness(createConfig(), kernel => {
      kernel.promptResult = { stopReason: 'cancelled' };
    });
    const run = harness.session.execute(createRequest());
    const kernel = await kernelAt(harness.kernels);
    await waitForPrompt(kernel);
    kernel.completePrompt();
    const events = await collect(run.events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'cancelled', reason: 'provider-cancelled' }));
    await harness.session.dispose();
  });

  it('is cheap and binds the persisted database/session only when execution starts', async () => {
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'resume-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }));

    expect(harness.kernels).toHaveLength(0);
    const run = harness.session.execute(createRequest());
    const kernel = await kernelAt(harness.kernels);
    await waitForPrompt(kernel);
    kernel.output('response');
    kernel.completePrompt();
    const events = await collect(run.events);

    expect(kernel.options.databasePath).toBe('/persisted/opencode.db');
    expect(kernel.openedResumeIds).toEqual(['resume-session']);
    expect(events.map(({ type }) => type)).toEqual([
      'session_state_changed',
      'turn_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.slice(0, 3).map(({ scope }) => scope.sequence)).toEqual([
      1,
      2,
      3,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'native-session',
      providerState: { databasePath: '/native/opencode.db' },
      status: 'idle',
    });
  });

  it('emits a newly established native-session snapshot before prompt completion', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(await kernelAt(harness.kernels));

    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'native-session',
          providerState: {
            databasePath: '/native/opencode.db',
            nativeConversationContextEstablished: false,
          },
          status: 'executing',
        }),
        type: 'session_state_changed',
      }),
    });

    harness.kernels[0].completePrompt();
    await collect(run.events);
  });

  it('bootstraps canonical history after invalidation while retaining retired sessions', async () => {
    const previousSessions = [{ sessionId: 'retired-session', databasePath: '/old/opencode.db' }];
    const harness = createHarness(createConfig({
      resumeSeed: { providerState: { nativeConversationContextEstablished: false, previousSessions } },
    }));
    const run = harness.session.execute(createRequest({
      conversationHistory: [
        { id: 'u1', role: 'user', content: 'prior', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2 },
      ],
    }));
    await waitForPrompt(await kernelAt(harness.kernels));
    harness.kernels[0].output('ok');
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].openedResumeIds).toEqual([undefined]);
    const { text } = harness.kernels[0].prompts[0] as OpencodePrompt;
    expect(decodeRecoveryPrompt(text)).toEqual({ currentInput: 'hello' });
    expect(text).toContain('User: prior\n\nAssistant: answer');
    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'native-session',
      providerState: { nativeConversationContextEstablished: true, previousSessions },
    });
  });

  it('classifies only explicit matching load failures as missing sessions', async () => {
    const generic = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'valid-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }), kernel => {
      kernel.openSessionError = new Error('Authentication expired');
    });
    const genericRun = generic.session.execute(createRequest());

    await expect(collect(genericRun.events)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'provider',
          type: 'execution_error',
        }),
      ]),
    );
    expect(generic.session.getSnapshot()).toMatchObject({
      providerSessionId: 'valid-session',
    });

    const missing = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'missing-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }), kernel => {
      kernel.openSessionError = new OpencodeSessionMissingError(
        'missing-session',
        new Error('Session not found'),
      );
    });
    const missingRun = missing.session.execute(createRequest());

    await expect(collect(missingRun.events)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'provider-session-missing',
          missingProviderSessionId: 'missing-session',
          type: 'execution_error',
        }),
      ]),
    );
  });

  it('persists cold replay intent across a pre-prompt configuration failure', async () => {
    const first = createHarness();
    const firstRun = first.session.execute(createRequest());
    (await kernelAt(first.kernels)).configError = new Error('Configuration failed');
    await collect(firstRun.events);

    const failedSnapshot = first.session.getSnapshot();
    expect(failedSnapshot).toMatchObject({
      providerSessionId: 'native-session',
      providerState: {
        databasePath: '/native/opencode.db',
        nativeConversationContextEstablished: false,
      },
      status: 'invalidated',
    });
    await first.session.dispose();

    const replacement = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: failedSnapshot.providerSessionId!,
        providerState: {
          ...failedSnapshot.providerState,
          futureResumeCursor: { token: 'cursor-1' },
        },
      },
    }));
    const history = [
      { id: 'u1', role: 'user' as const, content: 'replay-once', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: 'prior-answer', timestamp: 2 },
    ];
    const recoveryRun = replacement.session.execute(createRequest({
      conversationHistory: history,
    }));
    await waitForPrompt(await kernelAt(replacement.kernels));
    expect(replacement.kernels[0].openedResumeIds).toEqual(['native-session']);
    expect(JSON.stringify(replacement.kernels[0].prompts[0])).toContain('replay-once');
    replacement.kernels[0].completePrompt();
    await collect(recoveryRun.events);

    expect(replacement.session.getSnapshot()).toMatchObject({
      providerState: {
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished: true,
      },
    });

    const continuedRun = replacement.session.execute(createRequest({
      conversationHistory: history,
    }));
    await waitForPrompt(await kernelAt(replacement.kernels), 2);
    expect(JSON.stringify(replacement.kernels[0].prompts[1])).not.toContain(
      'replay-once',
    );
    replacement.kernels[0].completePrompt();
    await collect(continuedRun.events);
  });

  it('quarantines load and configuration replay until prompt dispatch', async () => {
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'resume-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }), kernel => {
      kernel.sessionInfo = {
        ...kernel.sessionInfo,
        sessionId: 'resume-session',
      };
      kernel.onOpenSession = () => {
        kernel.output('historic-load-output');
      };
      kernel.onConfigure = () => {
        kernel.output('historic-config-output');
      };
    });
    const run = harness.session.execute(createRequest());
    const kernel = await kernelAt(harness.kernels);

    await waitForPrompt(kernel);
    kernel.output('live-output');
    kernel.completePrompt();
    const events = await collect(run.events);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'live-output', type: 'text_delta' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'historic-load-output' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'historic-config-output' }),
    ]));
  });

  it.each([
    ['ephemeral', 'provider-default', undefined],
    ['persistent', 'provider-default', '/persisted/opencode.db'],
    ['ephemeral', 'enabled', '/persisted/opencode.db'],
  ] as const)(
    'forwards %s %s persistence with the trusted database hint %s',
    async (lifecycle, nativePersistence, persistedDatabasePath) => {
      const harness = createHarness(createConfig({
        lifecycle,
        nativePersistence,
        ...(persistedDatabasePath
          ? {
              resumeSeed: {
                providerSessionId: 'resume-session',
                providerState: { databasePath: persistedDatabasePath },
              },
            }
          : {}),
      }));

      const run = harness.session.execute(createRequest());
      await waitForPrompt(await kernelAt(harness.kernels));
      harness.kernels[0].completePrompt();
      await collect(run.events);

      expect(harness.kernels[0].options.databasePath).toBe(persistedDatabasePath);
      expect(harness.kernels[0].options.config).toMatchObject({ lifecycle, nativePersistence });
      await harness.session.dispose();
    },
  );

  it.each([['normal', false], ['yolo', true]] as const)('applies model, thought level, and the native build agent with %s approvals', async (permissionMode, autoApprove) => {
    const harness = createHarness();
    const request = createRequest();
    const run = harness.session.execute({ ...request, configuration: { ...request.configuration, permissionMode } });
    await waitForPrompt(await kernelAt(harness.kernels));
    harness.kernels[0].output('ok');
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].configCalls).toEqual([
      { sessionId: 'native-session', rawModelId: 'anthropic/claude', variant: 'high' },
      { sessionId: 'native-session', agent: 'build' },
    ]);
    expect(harness.kernels[0].autoApproveCalls).toEqual([autoApprove]);
  });

  it('cancels a request whose signal aborted before execution without starting native work', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    const run = harness.session.execute(createRequest({ signal: controller.signal }));
    for (let attempt = 0; attempt < 100; attempt += 1) await Promise.resolve();

    expect(harness.kernels).toEqual([]);
    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({ reason: 'cancelled', type: 'cancelled' });
    expect(events.some(event => event.type === 'turn_started')).toBe(false);
  });

  it('cancels, invalidates, fences late events, and resumes lazily on a fresh kernel', async () => {
    const harness = createHarness();
    const first = harness.session.execute(createRequest());
    const firstKernel = await kernelAt(harness.kernels);
    await waitForPrompt(firstKernel);

    first.cancel();
    const firstEvents = await collect(first.events);
    firstKernel.output('late');

    expect(firstKernel.cancelCalls).toBe(1);
    expect(firstKernel.disposeCalls).toBe(1);
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(firstEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          invalidation: expect.objectContaining({
            reason: 'cancelled',
            recoverable: true,
          }),
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
    ]));
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'invalidated',
      invalidation: { reason: 'cancelled', recoverable: true },
    });

    const second = harness.session.execute(createRequest());
    await waitForPrompt(await kernelAt(harness.kernels, 1));
    expect(harness.kernels).toHaveLength(2);
    harness.kernels[1].output('again');
    harness.kernels[1].completePrompt();
    await expect(collect(second.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text_delta', text: 'again' }),
    ]));
  });

  it('publishes a late native-session ownership ack after cancellation', async () => {
    let nativeSession: Deferred<OpencodeNativeSessionInfo> | undefined;
    const harness = createHarness(createConfig(), kernel => { nativeSession = kernel.deferOpenSession(); });
    const sessionEvents: ProviderSessionEvent[] = [];
    harness.session.onEvent((event) => {
      sessionEvents.push(event);
    });
    const run = harness.session.execute(createRequest());
    const kernel = await kernelAt(harness.kernels);
    await waitForCondition(() => kernel.openedResumeIds.length === 1);

    run.cancel();
    await collect(run.events);
    nativeSession!.resolve(kernel.sessionInfo);
    await waitForCondition(() => (
      harness.session.getSnapshot().providerSessionId === 'native-session'
    ));

    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'native-session',
      providerState: {
        nativeConversationContextEstablished: false,
      },
      status: 'invalidated',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'native-session',
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
    ]));
  });

  it('publishes a late prompt ack as established context after cancellation', async () => {
    const harness = createHarness();
    const sessionEvents: ProviderSessionEvent[] = [];
    harness.session.onEvent((event) => {
      sessionEvents.push(event);
    });
    const run = harness.session.execute(createRequest({
      conversationHistory: [
        { content: 'cold-history', id: 'u1', role: 'user', timestamp: 1 },
      ],
    }));
    const kernel = await kernelAt(harness.kernels);
    await waitForPrompt(kernel);

    run.cancel();
    await collect(run.events);
    kernel.completePrompt();
    await waitForCondition(() => (
      harness.session.getSnapshot().providerState
        ?.nativeConversationContextEstablished === true
    ));

    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'native-session',
      providerState: {
        nativeConversationContextEstablished: true,
      },
      status: 'invalidated',
    });
    expect(sessionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
    ]));
  });

  it('awaits the cancellation kernel-disposal flight during immediate session disposal', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const kernel = await kernelAt(harness.kernels);
    await waitForPrompt(kernel);
    const kernelDisposal = kernel.deferDisposal();

    run.cancel();
    const sessionDisposal = harness.session.dispose();
    let sessionDisposed = false;
    void sessionDisposal.then(() => {
      sessionDisposed = true;
    });
    await Promise.resolve();

    expect(sessionDisposed).toBe(false);
    expect(kernel.disposeCalls).toBe(1);

    kernelDisposal.resolve();
    await sessionDisposal;
    await expect(collect(run.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    expect(kernel.disposeCalls).toBe(1);
  });

  it('awaits an old kernel-disposal flight before retrying after process close', async () => {
    const harness = createHarness();
    const firstRun = harness.session.execute(createRequest());
    const firstKernel = await kernelAt(harness.kernels);
    await waitForPrompt(firstKernel);
    firstKernel.completePrompt();
    await expect(collect(firstRun.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    const kernelDisposal = firstKernel.deferDisposal();

    firstKernel.close();
    const secondRun = harness.session.execute(createRequest());
    await Promise.resolve();

    expect(harness.kernels).toHaveLength(1);
    expect(firstKernel.disposeCalls).toBe(1);

    kernelDisposal.resolve();
    await waitForCondition(() => harness.kernels.length === 2);
    await waitForPrompt(await kernelAt(harness.kernels, 1));
    harness.kernels[1].completePrompt();
    await expect(collect(secondRun.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(firstKernel.disposeCalls).toBe(1);
  });

  it('normalizes process death as a terminal error and disposes idempotently', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(await kernelAt(harness.kernels));
    harness.kernels[0].close();

    const events = await collect(run.events);
    expect(events.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({
          reason: 'process-exited',
          recoverable: true,
        }),
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'execution_error',
      category: 'process-exited',
      recoverable: true,
    });
    await Promise.all([harness.session.dispose(), harness.session.dispose()]);
    expect(harness.kernels[0].disposeCalls).toBe(1);
    expect(() => harness.session.execute(createRequest())).toThrow(
      'OpenCode execution session is disposed',
    );
  });

  it('publishes idle process-death invalidation through the session channel', async () => {
    const harness = createHarness();
    const sessionEvents: unknown[] = [];
    harness.session.onEvent((event) => sessionEvents.push(event));
    const run = harness.session.execute(createRequest());
    await waitForPrompt(await kernelAt(harness.kernels));
    harness.kernels[0].completePrompt();
    await collect(run.events);

    harness.kernels[0].close();

    expect(sessionEvents).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          invalidation: expect.objectContaining({
            reason: 'process-exited',
            recoverable: true,
          }),
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
      expect.objectContaining({
        category: 'process-exited',
        type: 'session_error',
      }),
    ]);
  });
});
