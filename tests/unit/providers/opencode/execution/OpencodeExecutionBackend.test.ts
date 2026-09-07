import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
  ProviderSessionEvent,
} from '@/core/execution';
import type { SlashCommand } from '@/core/types';

const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn();
const mockTransportStart = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportOnClose = jest.fn();
const mockConnectionInitialize = jest.fn();
const mockConnectionDispose = jest.fn();
const mockPrepareLaunchArtifacts = jest.fn();

const mockAcpSubprocess = jest.fn().mockImplementation(() => ({
  stdin: {},
  stdout: {},
  onClose: jest.fn().mockReturnValue(jest.fn()),
  shutdown: mockProcessShutdown,
  start: mockProcessStart,
}));
const mockAcpJsonRpcTransport = jest.fn().mockImplementation(() => ({
  dispose: mockTransportDispose,
  onClose: mockTransportOnClose.mockReturnValue(jest.fn()),
  start: mockTransportStart,
}));
const mockAcpClientConnection = jest.fn().mockImplementation(() => ({
  dispose: mockConnectionDispose,
  initialize: mockConnectionInitialize,
}));

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: mockAcpClientConnection,
    AcpJsonRpcTransport: mockAcpJsonRpcTransport,
    AcpSubprocess: mockAcpSubprocess,
  };
});

jest.mock('@/providers/opencode/runtime/OpencodeLaunchArtifacts', () => {
  const actual = jest.requireActual(
    '@/providers/opencode/runtime/OpencodeLaunchArtifacts',
  );
  return {
    ...actual,
    prepareOpencodeLaunchArtifacts: (...args: unknown[]) => (
      mockPrepareLaunchArtifacts(...args)
    ),
  };
});

import type { AcpSessionUpdate } from '@/providers/acp';
import type { OpencodeCommandCatalog } from '@/providers/opencode/commands/OpencodeCommandCatalog';
import {
  type OpencodeAcpSessionKernel,
  type OpencodeAcpSessionKernelOptions,
  type OpencodeNativeSessionInfo,
  OpencodeSessionMissingError,
} from '@/providers/opencode/execution/OpencodeAcpSessionKernel';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';

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

class FakeKernel implements OpencodeAcpSessionKernel {
  readonly connectCalls: unknown[] = [];
  readonly openedResumeIds: Array<string | undefined> = [];
  readonly configCalls: Array<Record<string, unknown>> = [];
  readonly prompts: unknown[] = [];
  cancelCalls = 0;
  disposeCalls = 0;
  configError: unknown = null;
  openSessionError: unknown = null;
  onOpenSession: (() => void) | null = null;
  onSetConfigOption: (() => void) | null = null;
  promptResult = { userMessageId: 'native-user' };
  private resolvePrompt: ((value: typeof this.promptResult) => void) | null = null;
  private deferredOpenSession: Deferred<OpencodeNativeSessionInfo> | null = null;
  private deferredDisposal: Deferred<void> | null = null;
  sessionInfo: OpencodeNativeSessionInfo = {
    sessionId: 'native-session',
    databasePath: '/native/opencode.db',
    configOptions: [
      {
        category: 'model',
        currentValue: 'anthropic/claude',
        id: 'model',
        name: 'Model',
        options: [{ name: 'Claude', value: 'anthropic/claude' }],
        type: 'select',
      },
      {
        category: 'thought_level',
        currentValue: 'low',
        id: 'effort',
        name: 'Effort',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'High', value: 'high' },
        ],
        type: 'select',
      },
    ],
    modes: {
      availableModes: [
        { id: 'claudian-yolo', name: 'YOLO' },
        { id: 'claudian-safe', name: 'Safe' },
      ],
      currentModeId: 'claudian-yolo',
    },
    models: {
      availableModels: [{ id: 'anthropic/claude', name: 'Claude' }],
      currentModelId: 'anthropic/claude',
    },
  };

  constructor(readonly options: OpencodeAcpSessionKernelOptions) {}

  async connect(options: unknown): Promise<void> {
    this.connectCalls.push(options);
  }

  async openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo> {
    this.openedResumeIds.push(resumeSessionId);
    this.onOpenSession?.();
    if (this.openSessionError) throw this.openSessionError;
    if (this.deferredOpenSession) return this.deferredOpenSession.promise;
    return this.sessionInfo;
  }

  async setConfigOption(request: Record<string, unknown>): Promise<{
    configOptions?: OpencodeNativeSessionInfo['configOptions'];
  }> {
    this.configCalls.push(request);
    this.onSetConfigOption?.();
    if (this.configError) throw this.configError;
    return { configOptions: this.sessionInfo.configOptions };
  }

  async prompt(request: unknown): Promise<typeof this.promptResult> {
    this.prompts.push(request);
    return new Promise((resolve) => {
      this.resolvePrompt = resolve;
    });
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

  notify(update: AcpSessionUpdate, sessionId = this.sessionInfo.sessionId): void {
    this.options.onNotification({ sessionId, update });
  }

  close(error = new Error('process closed')): void {
    this.options.onClosed(error);
  }
}

function createPlugin(): any {
  return {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
      },
    },
    getResolvedProviderCliPath: jest.fn(async () => '/bin/opencode'),
    manifest: { version: 'test' },
    mutateSettings: jest.fn(async (mutation) => mutation(plugin.settings)),
    notifyProviderChatOptionsChanged: jest.fn(),
    settings: {
      effortLevel: 'high',
      model: 'opencode:anthropic/claude',
      permissionMode: 'normal',
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: 'claudian-yolo', name: 'YOLO' },
            { id: 'claudian-safe', name: 'Safe' },
          ],
          discoveredModels: [
            { label: 'Claude', rawId: 'anthropic/claude' },
          ],
          visibleModels: ['anthropic/claude'],
        },
      },
    },
  };
}

const plugin = createPlugin();

function createConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  const interactionPort: ProviderInteractionPort = {
    requestApproval: jest.fn(async ({ interactionId }) => ({
      interactionId,
      decision: 'allow' as const,
    })),
    askUserQuestion: jest.fn(),
    requestPlanDecision: jest.fn(),
    dismissInteraction: jest.fn(),
  };
  return {
    interactionPort,
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/vault',
    ...overrides,
  };
}

function createRequest(overrides: Partial<ProviderExecutionRequest> = {}): ProviderExecutionRequest {
  return {
    configuration: {
      systemInstructions: { kind: 'provider-default' },
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
  for (
    let attempt = 0;
    attempt < 20 && kernel.prompts.length < count;
    attempt += 1
  ) {
    await Promise.resolve();
  }
  expect(kernel.prompts).toHaveLength(count);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

function createHarness(config = createConfig()) {
  const kernels: FakeKernel[] = [];
  const commandCatalog = {
    setCommandSnapshot: jest.fn(),
  } as unknown as OpencodeCommandCatalog;
  const backend = new OpencodeExecutionBackend(plugin, {
    commandCatalog,
    createKernel: (options) => {
      const kernel = new FakeKernel(options);
      kernels.push(kernel);
      return kernel;
    },
  });
  const session = backend.createSession(config);
  return { backend, commandCatalog, kernels, session };
}

describe('OpencodeExecutionBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessShutdown.mockResolvedValue(undefined);
    mockConnectionInitialize.mockResolvedValue({});
    mockPrepareLaunchArtifacts.mockResolvedValue({
      configContent: '{}',
      configPath: '/vault/.claudian/opencode/config.json',
      databasePath: '/native/opencode.db',
      launchKey: 'launch-key',
      systemPromptPath: '/vault/.claudian/opencode/system.md',
    });
  });

  it('does not start a process when a turn is cancelled during CLI resolution', async () => {
    const cliPath = createDeferred<string | null>();
    const host = createPlugin();
    host.getResolvedProviderCliPath = jest.fn(() => cliPath.promise);
    const session = new OpencodeExecutionBackend(host).createSession(createConfig());
    const run = session.execute(createRequest());
    const events = collect(run.events);
    await waitForCondition(() => host.getResolvedProviderCliPath.mock.calls.length === 1);

    run.cancel();
    cliPath.resolve('/bin/opencode');

    await expect(events).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    expect(mockAcpSubprocess).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('does not start a process when the session is disposed during artifact preparation', async () => {
    const artifacts = createDeferred<{
      configContent: string;
      configPath: string;
      databasePath: string | null;
      launchKey: string;
      systemPromptPath: string;
    }>();
    mockPrepareLaunchArtifacts.mockReturnValueOnce(artifacts.promise);
    const host = createPlugin();
    const session = new OpencodeExecutionBackend(host).createSession(createConfig());
    const run = session.execute(createRequest());
    const events = collect(run.events);
    await waitForCondition(() => mockPrepareLaunchArtifacts.mock.calls.length === 1);

    const disposal = session.dispose();
    artifacts.resolve({
      configContent: '{}',
      configPath: '/vault/.claudian/opencode/config.json',
      databasePath: '/native/opencode.db',
      launchKey: 'launch-key',
      systemPromptPath: '/vault/.claudian/opencode/system.md',
    });

    await disposal;
    await expect(events).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    expect(mockAcpSubprocess).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
  });

  it('closes a partially connected process and transport when disposed during initialize', async () => {
    const initialize = createDeferred<Record<string, never>>();
    mockConnectionInitialize.mockReturnValueOnce(initialize.promise);
    const host = createPlugin();
    const session = new OpencodeExecutionBackend(host).createSession(createConfig());
    const run = session.execute(createRequest());
    const events = collect(run.events);
    await waitForCondition(() => mockConnectionInitialize.mock.calls.length === 1);

    const disposal = session.dispose();
    initialize.resolve({});

    await disposal;
    await expect(events).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    expect(mockConnectionDispose).toHaveBeenCalledTimes(1);
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['process start', 'process-start', 0, 0],
    ['transport construction', 'transport-construction', 0, 0],
    ['connection construction', 'connection-construction', 1, 0],
    ['transport start', 'transport-start', 1, 1],
  ] as const)(
    'closes all acquired resources when %s fails',
    async (_label, failureBoundary, expectedTransportDisposals, expectedConnectionDisposals) => {
      const failure = new Error(`Failed at ${failureBoundary}`);
      if (failureBoundary === 'process-start') {
        mockProcessStart.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (failureBoundary === 'transport-construction') {
        mockAcpJsonRpcTransport.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (failureBoundary === 'connection-construction') {
        mockAcpClientConnection.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        mockTransportStart.mockImplementationOnce(() => {
          throw failure;
        });
      }

      const host = createPlugin();
      const session = new OpencodeExecutionBackend(host).createSession(createConfig());
      const events = await collect(session.execute(createRequest()).events);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'execution_error' }),
      ]));
      expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
      expect(mockTransportDispose).toHaveBeenCalledTimes(
        expectedTransportDisposals,
      );
      expect(mockConnectionDispose).toHaveBeenCalledTimes(
        expectedConnectionDisposals,
      );
      await session.dispose();
    },
  );

  it('is cheap and binds the persisted database/session only when execution starts', async () => {
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'resume-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }));

    expect(harness.kernels).toHaveLength(0);
    const run = harness.session.execute(createRequest());
    const kernel = harness.kernels[0];
    await waitForPrompt(kernel);
    kernel.notify({
      content: { type: 'text', text: 'response' },
      sessionUpdate: 'agent_message_chunk',
    });
    kernel.completePrompt();
    const events = await collect(run.events);

    expect(kernel.options.databasePath).toBe('/persisted/opencode.db');
    expect(kernel.openedResumeIds).toEqual(['resume-session']);
    expect(events.map(({ type }) => type)).toEqual([
      'session_state_changed',
      'turn_started',
      'assistant_message_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.slice(0, 4).map(({ scope }) => scope.sequence)).toEqual([
      1,
      2,
      3,
      4,
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
    await waitForPrompt(harness.kernels[0]);

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

  it('encodes path-only Linked content without changing the Vault-root kernel CWD', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      context: { linkedContent: { path: 'Projects/Research' } },
      input: [{ text: 'Inspect linked content', type: 'text' }],
    }));
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].options.config.vaultWorkingDirectory).toBe('/vault');
    expect(harness.kernels[0].prompts[0]).toEqual({
      prompt: [{
        text: 'Inspect linked content\n\n<linked_content path="Projects/Research" />',
        type: 'text',
      }],
      sessionId: 'native-session',
    });
    expect(JSON.stringify(harness.kernels[0].prompts[0])).not.toMatch(
      /<(?:linked_note|current_note)\b/,
    );
  });

  it('bootstraps canonical history when no native session exists', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      conversationHistory: [
        { id: 'u1', role: 'user', content: 'prior', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2 },
      ],
    }));
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { type: 'text', text: 'ok' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(JSON.stringify(harness.kernels[0].prompts[0])).toContain('prior');
    expect(JSON.stringify(harness.kernels[0].prompts[0])).toContain('answer');
  });

  it('does not replay canonical history into a resumed native session', async () => {
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'resume-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }));
    const run = harness.session.execute(createRequest({
      conversationHistory: [
        { content: 'do-not-replay', id: 'u1', role: 'user', timestamp: 1 },
      ],
    }));
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { text: 'ok', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(JSON.stringify(harness.kernels[0].prompts[0])).not.toContain(
      'do-not-replay',
    );
  });

  it('classifies only explicit matching load failures as missing sessions', async () => {
    const generic = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'valid-session',
        providerState: { databasePath: '/persisted/opencode.db' },
      },
    }));
    const genericRun = generic.session.execute(createRequest());
    generic.kernels[0].openSessionError = new Error('Authentication expired');

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
    }));
    const missingRun = missing.session.execute(createRequest());
    missing.kernels[0].openSessionError = new OpencodeSessionMissingError(
      'missing-session',
      new Error('Session not found'),
    );

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
    first.kernels[0].configError = new Error('Configuration failed');
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
    await waitForPrompt(replacement.kernels[0]);
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
    await waitForPrompt(replacement.kernels[0], 2);
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
    }));
    const run = harness.session.execute(createRequest());
    const kernel = harness.kernels[0];
    kernel.sessionInfo = {
      ...kernel.sessionInfo,
      sessionId: 'resume-session',
    };
    kernel.onOpenSession = () => {
      kernel.notify({
        availableCommands: [{ name: 'review' }],
        sessionUpdate: 'available_commands_update',
      }, 'resume-session');
      kernel.notify({
        content: { text: 'historic-load-output', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      }, 'resume-session');
    };
    kernel.onSetConfigOption = () => {
      kernel.notify({
        content: { text: 'historic-config-output', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      }, 'resume-session');
    };

    await waitForPrompt(kernel);
    kernel.notify({
      content: { text: 'live-output', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    }, 'resume-session');
    kernel.completePrompt();
    const events = await collect(run.events);

    expect(harness.commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'review' }),
    ]);
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

  it('reconnects when connect-scoped profile or instructions change', async () => {
    const harness = createHarness();
    const execute = async (
      instructions: string,
      toolPolicy: ProviderExecutionRequest['toolPolicy'],
      expectedKernelCount: number,
    ): Promise<void> => {
      const base = createRequest();
      const run = harness.session.execute(createRequest({
        configuration: {
          ...base.configuration,
          systemInstructions: { instructions, kind: 'explicit' },
        },
        toolPolicy,
      }));
      await waitForCondition(() => harness.kernels.length === expectedKernelCount);
      const kernel = harness.kernels[expectedKernelCount - 1];
      await waitForPrompt(kernel);
      kernel.completePrompt();
      await collect(run.events);
    };

    await execute('instructions-a', { kind: 'provider-default' }, 1);
    await execute('instructions-b', { kind: 'provider-default' }, 2);
    await execute('instructions-b', { kind: 'read-only' }, 3);

    expect(harness.kernels.map(kernel => kernel.connectCalls[0])).toEqual([
      expect.objectContaining({
        profile: 'managed',
        systemInstructions: { instructions: 'instructions-a', kind: 'explicit' },
      }),
      expect.objectContaining({
        profile: 'managed',
        systemInstructions: { instructions: 'instructions-b', kind: 'explicit' },
      }),
      expect.objectContaining({
        profile: 'readonly',
        systemInstructions: { instructions: 'instructions-b', kind: 'explicit' },
      }),
    ]);
    expect(harness.kernels.slice(1).map(kernel => kernel.openedResumeIds)).toEqual([
      ['native-session'],
      ['native-session'],
    ]);
  });

  it('reconnects when provider-default dynamic system sections change', async () => {
    const harness = createHarness();
    const execute = async (
      dynamicSections: readonly string[],
      expectedKernelCount: number,
      expectedPromptCount: number,
    ): Promise<void> => {
      const base = createRequest();
      const run = harness.session.execute(createRequest({
        configuration: {
          ...base.configuration,
          systemInstructions: {
            dynamicSections,
            kind: 'provider-default',
          },
        },
      }));
      await waitForCondition(() => harness.kernels.length === expectedKernelCount);
      const kernel = harness.kernels[expectedKernelCount - 1];
      await waitForPrompt(kernel, expectedPromptCount);
      kernel.completePrompt();
      await collect(run.events);
    };

    await execute(['dynamic-a'], 1, 1);
    await execute(['dynamic-a'], 1, 2);
    await execute(['dynamic-b'], 2, 1);

    expect(harness.kernels.map(kernel => kernel.connectCalls[0])).toEqual([
      expect.objectContaining({
        systemInstructions: {
          dynamicSections: ['dynamic-a'],
          kind: 'provider-default',
        },
      }),
      expect.objectContaining({
        systemInstructions: {
          dynamicSections: ['dynamic-b'],
          kind: 'provider-default',
        },
      }),
    ]);
  });

  it.each([
    ['ephemeral', 'provider-default', undefined, ':memory:'],
    ['persistent', 'provider-default', '/persisted/opencode.db', '/persisted/opencode.db'],
    ['ephemeral', 'enabled', '/persisted/opencode.db', '/persisted/opencode.db'],
  ] as const)(
    'resolves %s %s persistence to %s',
    async (lifecycle, nativePersistence, persistedDatabasePath, expectedDatabasePath) => {
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
      await waitForPrompt(harness.kernels[0]);
      harness.kernels[0].completePrompt();
      await collect(run.events);

      expect(harness.kernels[0].options.databasePath).toBe(expectedDatabasePath);
      await harness.session.dispose();
    },
  );

  it('reuses a healthy native process and session across requested turns', async () => {
    const harness = createHarness();
    const first = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { text: 'one', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(first.events);

    const second = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0], 2);
    harness.kernels[0].notify({
      content: { text: 'two', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(second.events);

    expect(harness.kernels).toHaveLength(1);
    expect(harness.kernels[0].openedResumeIds).toEqual([undefined]);
  });

  it.each([
    ['passive', 'passive'],
    ['read-only', 'readonly'],
    ['provider-default', 'managed'],
    ['unrestricted', 'managed'],
  ] as const)('maps %s tool policy to the %s managed profile', async (kind, profile) => {
    const harness = createHarness(createConfig({
      lifecycle: kind === 'provider-default' ? 'persistent' : 'ephemeral',
      nativePersistence: kind === 'provider-default'
        ? 'enabled'
        : 'disabled-if-supported',
    }));
    const run = harness.session.execute(createRequest({
      toolPolicy: { kind },
    }));
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { type: 'text', text: 'ok' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].connectCalls[0]).toMatchObject({ profile });
    expect(harness.kernels[0].options.databasePath).toBe(
      kind === 'provider-default' ? undefined : ':memory:',
    );
  });

  it('fails an arbitrary tool allow-list closed without enabling unnamed read tools', async () => {
    const harness = createHarness(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
    }));
    const run = harness.session.execute(createRequest({
      toolPolicy: { kind: 'allow-list', names: ['custom-approved-tool'] },
    }));
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { text: 'ok', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].connectCalls[0]).toMatchObject({
      profile: 'passive',
    });
    expect(harness.kernels[0].connectCalls[0]).not.toMatchObject({
      profile: 'readonly',
    });
  });

  it('applies model, thought level, and managed mode through ACP configuration', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      content: { type: 'text', text: 'ok' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(harness.kernels[0].configCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ configId: 'model', value: 'anthropic/claude' }),
      expect.objectContaining({ configId: 'effort', value: 'high' }),
      expect.objectContaining({ configId: 'mode', value: 'claudian-safe' }),
    ]));
  });

  it('publishes immutable command snapshots outside the execution-session API', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);
    const commands: SlashCommand[] = [
      { id: 'acp:review', name: 'review', content: '' },
    ];
    harness.kernels[0].notify({
      availableCommands: [{ name: 'review' }],
      sessionUpdate: 'available_commands_update',
    });
    harness.kernels[0].completePrompt();
    harness.kernels[0].notify({
      content: { type: 'text', text: 'ok' },
      sessionUpdate: 'agent_message_chunk',
    });
    await collect(run.events);

    expect(harness.commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([
      expect.objectContaining(commands[0]),
    ]);
    expect('getSupportedCommands' in harness.session).toBe(false);
  });

  it('applies OpenCode tool presentation to live ACP events', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);

    harness.kernels[0].notify({
      kind: 'edit',
      rawInput: {
        filePath: '/vault/notes/today.md',
        newString: 'after',
        oldString: 'before',
      },
      sessionUpdate: 'tool_call',
      status: 'in_progress',
      title: 'edit',
      toolCallId: 'tool-edit',
    });
    harness.kernels[0].notify({
      kind: 'edit',
      rawOutput: {
        metadata: { filepath: '/vault/notes/today.md' },
        output: 'Updated file',
      },
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      title: 'notes/today.md',
      toolCallId: 'tool-edit',
    });
    harness.kernels[0].completePrompt();

    const events = await collect(run.events);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        input: {
          file_path: '/vault/notes/today.md',
          new_string: 'after',
          old_string: 'before',
        },
        name: 'Edit',
        toolCallId: 'tool-edit',
        type: 'tool_started',
      }),
      expect.objectContaining({
        content: expect.stringContaining('Updated file'),
        isError: false,
        toolCallId: 'tool-edit',
        toolUseResult: { filePath: '/vault/notes/today.md' },
        type: 'tool_completed',
      }),
    ]));
  });

  it('publishes provider mode changes through the session event channel', async () => {
    const harness = createHarness();
    const modes: unknown[] = [];
    harness.session.onEvent((event) => modes.push(event));
    const run = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);
    harness.kernels[0].notify({
      currentModeId: 'claudian-safe',
      sessionUpdate: 'current_mode_update',
    });
    harness.kernels[0].notify({
      content: { text: 'ok', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[0].completePrompt();
    await collect(run.events);

    expect(modes).toEqual([
      expect.objectContaining({
        mode: 'normal',
        scope: expect.objectContaining({ kind: 'session', sequence: 1 }),
        type: 'mode_changed',
      }),
    ]);
  });

  it('cancels, invalidates, fences late events, and resumes lazily on a fresh kernel', async () => {
    const harness = createHarness();
    const first = harness.session.execute(createRequest());
    const firstKernel = harness.kernels[0];
    await waitForPrompt(firstKernel);

    first.cancel();
    const firstEvents = await collect(first.events);
    firstKernel.notify({
      content: { type: 'text', text: 'late' },
      sessionUpdate: 'agent_message_chunk',
    });

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
    await waitForPrompt(harness.kernels[1]);
    expect(harness.kernels).toHaveLength(2);
    harness.kernels[1].notify({
      content: { type: 'text', text: 'again' },
      sessionUpdate: 'agent_message_chunk',
    });
    harness.kernels[1].completePrompt();
    await expect(collect(second.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text_delta', text: 'again' }),
    ]));
  });

  it('publishes a late native-session ownership ack after cancellation', async () => {
    const harness = createHarness();
    const sessionEvents: ProviderSessionEvent[] = [];
    harness.session.onEvent((event) => {
      sessionEvents.push(event);
    });
    const run = harness.session.execute(createRequest());
    const kernel = harness.kernels[0];
    const nativeSession = kernel.deferOpenSession();
    await waitForCondition(() => kernel.openedResumeIds.length === 1);

    run.cancel();
    await collect(run.events);
    nativeSession.resolve(kernel.sessionInfo);
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
    const kernel = harness.kernels[0];
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
    const kernel = harness.kernels[0];
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
    const firstKernel = harness.kernels[0];
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
    await waitForPrompt(harness.kernels[1]);
    harness.kernels[1].completePrompt();
    await expect(collect(secondRun.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(firstKernel.disposeCalls).toBe(1);
  });

  it('normalizes process death as a terminal error and disposes idempotently', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    await waitForPrompt(harness.kernels[0]);
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
    await waitForPrompt(harness.kernels[0]);
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
