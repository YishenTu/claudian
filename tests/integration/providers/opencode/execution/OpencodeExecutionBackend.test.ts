import { EventEmitter, once } from 'node:events';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import {
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
} from '@/core/execution';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import {
  type OpencodeNativeSessionInfo,
  type OpencodeSessionKernel,
  type OpencodeSessionKernelOptions,
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
  readonly openedResumeIds: Array<string | undefined> = [];
  readonly prompts: unknown[] = [];
  disposeCalls = 0;
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

  async connect(): Promise<void> {}

  async openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo> {
    this.openedResumeIds.push(resumeSessionId);
    lifecycleEvents.emit('changed');
    if (this.deferredOpenSession) return this.deferredOpenSession.promise;
    return this.sessionInfo;
  }

  async setAgent(): Promise<void> {}

  async setModel(): Promise<void> {}

  setAutoApprove(): void {}

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

  cancel(): void {}

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
  const serverService = new OpencodeServerService();
  const backend = new OpencodeExecutionBackend(plugin.getRuntimeHost('opencode'), {
    serverService,
    createKernel: (options) => {
      const kernel = new FakeKernel(options);
      kernels.push(kernel);
      lifecycleEvents.emit('changed');
      onKernel?.(kernel);
      return kernel;
    },
  });
  const session = backend.createSession(config);
  onTestFinished(async () => { await session.dispose(); await serverService.dispose(); });
  session.onEvent(() => lifecycleEvents.emit('changed'));
  return { backend, kernels, session, serverService };
}

// These four seams cannot be driven by a native server alone: CLI resolution is
// host-owned; late fulfilled promises and disposal completion belong to the kernel.
describe('OpencodeExecutionBackend kernel-promise boundaries', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not acquire a native server when a turn is cancelled during CLI resolution', async () => {
    const cliPath = createDeferred<string | null>();
    const host = plugin;
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
    // Observe the real availability promise; one microtask does not reach retry admission.
    const admission = vi.spyOn(harness.serverService, 'waitUntilAvailable');
    const secondRun = harness.session.execute(createRequest());
    await admission.mock.results[0].value;

    try {

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
    } finally { kernelDisposal.resolve(); }
  });
});
