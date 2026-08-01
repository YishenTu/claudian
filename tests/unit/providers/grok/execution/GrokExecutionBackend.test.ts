const mockLoadGrokPromptIndexAfterAssistant = jest.fn();
const mockResolveGrokSessionDirectory = jest.fn();

jest.mock('@/providers/grok/history/GrokHistoryStore', () => ({
  ...jest.requireActual('@/providers/grok/history/GrokHistoryStore'),
  loadGrokPromptIndexAfterAssistant: (...args: unknown[]) => (
    mockLoadGrokPromptIndexAfterAssistant(...args)
  ),
}));
jest.mock('@/providers/grok/history/GrokHistoryPathResolver', () => ({
  ...jest.requireActual('@/providers/grok/history/GrokHistoryPathResolver'),
  resolveGrokSessionDirectory: (...args: unknown[]) => mockResolveGrokSessionDirectory(...args),
}));

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
} from '@/core/execution';
import {
  isRewindableExecutionSession,
  isSteerableExecutionSession,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  AcpLoadSessionRequest,
  AcpNewSessionRequest,
  AcpPromptRequest,
  AcpSessionModelState,
  AcpSessionNotification,
  AcpSetSessionModelRequest,
  AcpSetSessionModelResponse,
  AcpSetSessionModeRequest,
} from '@/providers/acp';
import {
  GrokExecutionBackend,
  type GrokExecutionNativeConnection,
  type GrokExecutionNativeCreateOptions,
  type GrokExecutionNativeFactory,
} from '@/providers/grok/execution/GrokExecutionBackend';
import type { GrokDiscoveredModel } from '@/providers/grok/models';
import {
  updateCurrentGrokCatalog,
  updateGrokProviderSettings,
} from '@/providers/grok/settings';

const interactionPort: ProviderInteractionPort = {
  askUserQuestion: jest.fn(),
  dismissInteraction: jest.fn(),
  requestApproval: jest.fn(),
  requestPlanDecision: jest.fn(),
};

const sessionConfig: ProviderSessionConfig = {
  interactionPort,
  lifecycle: 'persistent',
  nativePersistence: 'enabled',
  resumeSeed: {
    providerSessionId: 'session-existing',
    providerState: { sessionDirectory: '/tmp/grok-session' },
  },
  vaultWorkingDirectory: '/tmp/vault',
};

function forkSessionConfig(): ProviderSessionConfig {
  return {
    ...sessionConfig,
    resumeSeed: {
      providerState: {
        forkSource: { resumeAt: 'assistant-source', sessionId: 'session-source' },
        forkSourceSessionDirectory: '/tmp/grok-source/session-source',
        futureState: { retained: true },
      },
    },
  };
}

function executionRequest(text = 'hello'): ProviderExecutionRequest {
  return {
    configuration: {
      mode: 'plan',
      model: 'grok/grok-4',
      reasoning: 'high',
      systemInstructions: { kind: 'explicit', instructions: 'Be exact.' },
    },
    input: [{ text, type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
}

function grok45Request(reasoning: string): ProviderExecutionRequest {
  const request = executionRequest();
  return {
    ...request,
    configuration: {
      ...request.configuration,
      model: 'grok/grok-4.5',
      reasoning,
    },
  };
}

function createGrok45Host(): ProviderHost {
  return {
    settings: {
      model: 'grok/grok-4.5',
      providerConfigs: {
        grok: {
          enabled: true,
          preferredReasoningByModel: {},
        },
      },
      savedProviderModel: { grok: 'grok/grok-4.5' },
    },
  } as unknown as ProviderHost;
}

function persistGrok45Catalog(
  host: ProviderHost,
  models: GrokDiscoveredModel[] = [{
    displayName: 'Grok 4.5',
    rawId: 'grok-4.5',
    reasoningMetadataResolved: true,
    reasoningEfforts: [
      { label: 'High', value: 'high' },
      { label: 'Medium', value: 'medium' },
      { label: 'Low', value: 'low' },
    ],
    supportsReasoning: true,
  }],
): void {
  updateCurrentGrokCatalog(host.settings, {
    defaultModelId: 'grok-4.5',
    fingerprint: 'catalog-fixture',
    models,
    refreshedAt: 1,
  });
}

function featurePermissionRequest(
  permissionMode: 'normal' | 'plan' | 'yolo',
  explicitMode?: string,
): ProviderExecutionRequest {
  const base = executionRequest(permissionMode);
  return {
    ...base,
    configuration: {
      ...(explicitMode !== undefined ? { mode: explicitMode } : {}),
      model: base.configuration.model,
      permissionMode,
      reasoning: base.configuration.reasoning,
      systemInstructions: base.configuration.systemInstructions,
    },
  };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

class FakeNativeConnection implements GrokExecutionNativeConnection {
  readonly loadRequests: AcpLoadSessionRequest[] = [];
  readonly modeRequests: AcpSetSessionModeRequest[] = [];
  readonly modelRequests: AcpSetSessionModelRequest[] = [];
  readonly newRequests: AcpNewSessionRequest[] = [];
  readonly promptRequests: AcpPromptRequest[] = [];
  cancelCalls = 0;
  forkCalls: unknown[] = [];
  initializeCalls = 0;
  interjectCalls: unknown[] = [];
  rewindCalls: unknown[] = [];
  shutdownCalls = 0;
  loadResponse: Awaited<ReturnType<GrokExecutionNativeConnection['loadSession']>> | null = null;
  loadImplementation: (
    request: AcpLoadSessionRequest,
  ) => ReturnType<GrokExecutionNativeConnection['loadSession']> = async request => (
    this.loadResponse ?? { sessionId: request.sessionId }
  );
  private notification: ((value: AcpSessionNotification, source: 'extension' | 'standard') => void)
    | null = null;
  private retainedNotification: ((
    value: AcpSessionNotification,
    source: 'extension' | 'standard',
  ) => void) | null = null;
  private modelsChanged: ((models: AcpSessionModelState) => void) | null = null;
  private retainedModelsChanged: ((models: AcpSessionModelState) => void) | null = null;
  initializeImplementation: () => Promise<void> = async () => {};
  forkImplementation: (request: {
    newCwd: string;
    sourceSessionId: string;
  }) => Promise<{
    newCwd: string;
    newSessionId: string;
    parentSessionId: string;
  }> = async (request) => ({
    newCwd: request.newCwd,
    newSessionId: 'session-forked',
    parentSessionId: request.sourceSessionId,
  });
  interjectImplementation: () => Promise<void> = async () => {};
  modelImplementation: (
    request: AcpSetSessionModelRequest,
  ) => Promise<AcpSetSessionModelResponse> = async () => ({});
  promptImplementation: () => Promise<{ stopReason: string }> = async () => ({
    stopReason: 'end_turn',
  });
  shutdownImplementation: () => Promise<void> = async () => {};

  cancel(): void {
    this.cancelCalls += 1;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await this.initializeImplementation();
  }

  isAlive(): boolean {
    return true;
  }

  async listCommands(): Promise<[]> {
    return [];
  }

  async fork(request: unknown): Promise<{
    newCwd: string;
    newSessionId: string;
    parentSessionId: string;
  }> {
    this.forkCalls.push(request);
    const source = request as { newCwd: string; sourceSessionId: string };
    return this.forkImplementation(source);
  }

  async interject(request: unknown): Promise<void> {
    this.interjectCalls.push(request);
    await this.interjectImplementation();
  }

  async loadSession(
    request: AcpLoadSessionRequest,
  ): ReturnType<GrokExecutionNativeConnection['loadSession']> {
    this.loadRequests.push(request);
    return this.loadImplementation(request);
  }

  async newSession(request: AcpNewSessionRequest): Promise<{ sessionId: string }> {
    this.newRequests.push(request);
    return { sessionId: 'session-new' };
  }

  onNotification(
    listener: (value: AcpSessionNotification, source: 'extension' | 'standard') => void,
  ): () => void {
    this.notification = listener;
    this.retainedNotification = listener;
    return () => { this.notification = null; };
  }

  onModelsChanged(listener: (models: AcpSessionModelState) => void): () => void {
    this.modelsChanged = listener;
    this.retainedModelsChanged = listener;
    return () => { this.modelsChanged = null; };
  }

  async prompt(request: AcpPromptRequest): Promise<{ stopReason: string }> {
    this.promptRequests.push(request);
    return this.promptImplementation();
  }

  async rewind(request: unknown): Promise<{
    cleanFiles: string[];
    conflicts: [];
    error: null;
    revertedFiles: string[];
    success: boolean;
  }> {
    this.rewindCalls.push(request);
    return {
      cleanFiles: ['note.md'],
      conflicts: [],
      error: null,
      revertedFiles: [],
      success: true,
    };
  }

  async setMode(request: AcpSetSessionModeRequest): Promise<void> {
    this.modeRequests.push(request);
  }

  async setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse> {
    this.modelRequests.push(request);
    return this.modelImplementation(request);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    await this.shutdownImplementation();
  }

  emit(update: Record<string, unknown>, source: 'extension' | 'standard' = 'standard'): void {
    this.notification?.({
      sessionId: 'session-existing',
      update,
    } as unknown as AcpSessionNotification, source);
  }

  emitRetained(
    update: Record<string, unknown>,
    source: 'extension' | 'standard' = 'standard',
  ): void {
    this.retainedNotification?.({
      sessionId: 'session-existing',
      update,
    } as unknown as AcpSessionNotification, source);
  }

  emitModelsChanged(models: AcpSessionModelState): void {
    this.modelsChanged?.(models);
  }

  emitRetainedModelsChanged(models: AcpSessionModelState): void {
    this.retainedModelsChanged?.(models);
  }
}

describe('GrokExecutionBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadGrokPromptIndexAfterAssistant.mockResolvedValue(3);
    mockResolveGrokSessionDirectory.mockImplementation(
      (_hint: unknown, sessionId: string | undefined) => (
        sessionId ? `/trusted/grok/sessions/${sessionId}` : null
      ),
    );
  });

  it('loads the fixed native session, configures model/mode, and streams correlated ACP output', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = async () => {
      native.emit({
        content: { text: 'answer', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { stopReason: 'end_turn' };
    };
    const nativeFactory: GrokExecutionNativeFactory = { create: jest.fn(() => native) };
    const backend = new GrokExecutionBackend({ settings: {} } as ProviderHost, { nativeFactory });
    const session = backend.createSession(sessionConfig);

    const run = session.execute(executionRequest());
    const events = await collect(run.events);

    expect(native.loadRequests).toHaveLength(1);
    expect(native.modelRequests[0]).toEqual({
      modelId: 'grok-4',
      sessionId: 'session-existing',
    });
    expect(native.modeRequests[0]).toEqual({ modeId: 'plan', sessionId: 'session-existing' });
    expect(native.promptRequests[0]).toMatchObject({
      prompt: [{ text: 'hello', type: 'text' }],
      sessionId: 'session-existing',
    });
    expect(events.map(event => event.type)).toEqual([
      'session_state_changed',
      'session_state_changed',
      'turn_started',
      'assistant_message_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.every(event => event.scope.executionId === run.executionId)).toBe(true);
    expect(events.map(event => event.scope.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.filter(event => event.type === 'session_state_changed')).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'idle',
        }),
      }),
    ]);
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-existing',
      status: 'idle',
    });
  });

  it('drops an unsupported reasoning effort after cold-session model discovery', async () => {
    const native = new FakeNativeConnection();
    native.loadResponse = {
      models: {
        availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5' }],
        currentModelId: 'grok-4.5',
      },
      sessionId: 'session-existing',
    };
    const host = createGrok45Host();
    const mergeLiveModels = jest.fn(async (models: GrokDiscoveredModel[]) => {
      persistGrok45Catalog(host, models);
      return { changed: true };
    });
    const session = new GrokExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    await collect(session.execute(grok45Request('max')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(native.modelRequests).toEqual([{
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('omits the requested reasoning effort when the selected model metadata is unknown', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      createGrok45Host(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute(grok45Request('max')).events);

    expect(native.modelRequests).toEqual([{
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('accepts a future effort value advertised by live session metadata', async () => {
    const native = new FakeNativeConnection();
    native.loadResponse = {
      _meta: {
        reasoningEffort: 'max',
        'x.ai/sessionConfig': {
          options: [
            { category: 'mode', id: 'high', label: 'High', selected: false },
            { category: 'mode', id: 'max', label: 'Maximum', selected: true },
          ],
        },
      },
      models: {
        availableModels: [{
          _meta: { supportsReasoningEffort: true },
          modelId: 'grok-4.5',
          name: 'Grok 4.5',
        }],
        currentModelId: 'grok-4.5',
      },
      sessionId: 'session-existing',
    };
    const host = createGrok45Host();
    const mergeLiveModels = jest.fn(async (models: GrokDiscoveredModel[]) => {
      persistGrok45Catalog(host, models);
      return { changed: true };
    });
    const session = new GrokExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    await collect(session.execute(grok45Request('max')).events);

    expect(native.modelRequests).toEqual([{
      _meta: { reasoningEffort: 'max' },
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
    expect(mergeLiveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        defaultReasoningEffort: 'max',
        reasoningEfforts: expect.arrayContaining([
          expect.objectContaining({ value: 'max' }),
        ]),
        reasoningMetadataResolved: true,
      }),
    ], 'grok-4.5', expect.any(String));
  });

  it('persists authoritative metadata returned by model selection', async () => {
    const native = new FakeNativeConnection();
    native.modelImplementation = async () => ({
      _meta: {
        model: {
          reasoningEffort: 'max',
          supportsReasoningEffort: true,
          'x.ai/sessionConfig': {
            options: [
              { category: 'mode', id: 'high', label: 'High', selected: false },
              { category: 'mode', id: 'max', label: 'Maximum', selected: true },
            ],
          },
        },
      },
    });
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    const mergeLiveModels = jest.fn();
    const session = new GrokExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    await collect(session.execute(grok45Request('low')).events);

    expect(mergeLiveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        defaultReasoningEffort: 'max',
        rawId: 'grok-4.5',
        reasoningMetadataResolved: true,
      }),
    ], undefined, expect.any(String));
  });

  it('continues the turn when selected-model metadata persistence fails', async () => {
    const native = new FakeNativeConnection();
    native.modelImplementation = async () => ({
      _meta: {
        model: {
          reasoningEffort: 'high',
          supportsReasoningEffort: true,
          'x.ai/sessionConfig': {
            options: [
              { category: 'mode', id: 'high', label: 'High', selected: true },
            ],
          },
        },
      },
    });
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    const mergeLiveModels = jest.fn(async () => {
      throw new Error('settings persistence failed');
    });
    const session = new GrokExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    const events = await collect(session.execute(grok45Request('high')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(native.promptRequests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  });

  it('continues the turn when session-model metadata persistence fails', async () => {
    const native = new FakeNativeConnection();
    native.loadResponse = {
      models: {
        availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5' }],
        currentModelId: 'grok-4.5',
      },
      sessionId: 'session-existing',
    };
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    const mergeLiveModels = jest.fn(async () => {
      throw new Error('settings persistence failed');
    });
    const session = new GrokExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    const events = await collect(session.execute(grok45Request('high')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(native.promptRequests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  });

  it('persists live model updates and fences notifications from a quarantined native', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    const mergeLiveModels = jest.fn(async () => ({ changed: true }));
    const session = new GrokExecutionBackend(createGrok45Host(), {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    const run = session.execute(grok45Request('max'));
    while (native.promptRequests.length === 0) await Promise.resolve();
    const models: AcpSessionModelState = {
      availableModels: [{
        _meta: {
          reasoningEffort: 'max',
          supportsReasoningEffort: true,
          'x.ai/sessionConfig': {
            options: [
              { category: 'mode', id: 'high', label: 'High', selected: false },
              { category: 'mode', id: 'max', label: 'Maximum', selected: true },
            ],
          },
        },
        modelId: 'grok-4.5',
        name: 'Grok 4.5',
      }],
      currentModelId: 'grok-4.5',
    };

    native.emitModelsChanged(models);
    await drainMicrotasks();
    expect(mergeLiveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        defaultReasoningEffort: 'max',
        rawId: 'grok-4.5',
        reasoningMetadataResolved: true,
      }),
    ], 'grok-4.5', expect.any(String));

    run.cancel();
    await collect(run.events);
    native.emitRetainedModelsChanged(models);
    await drainMicrotasks();
    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
  });

  it('uses a valid per-model preference when the requested reasoning effort is unsupported', async () => {
    const native = new FakeNativeConnection();
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    updateGrokProviderSettings(host.settings, {
      preferredReasoningByModel: { 'grok-4.5': 'low' },
    });
    const session = new GrokExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute(grok45Request('max')).events);

    expect(native.modelRequests).toEqual([{
      _meta: { reasoningEffort: 'low' },
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('omits a saved per-model preference when the request has no projected effort', async () => {
    const native = new FakeNativeConnection();
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    updateGrokProviderSettings(host.settings, {
      preferredReasoningByModel: { 'grok-4.5': 'low' },
    });
    const request = grok45Request('high');
    const { reasoning: _reasoning, ...configuration } = request.configuration;
    const session = new GrokExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute({ ...request, configuration }).events);

    expect(native.modelRequests).toEqual([{
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('keeps a requested reasoning effort the selected model advertises', async () => {
    const native = new FakeNativeConnection();
    const host = createGrok45Host();
    persistGrok45Catalog(host);
    const session = new GrokExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute(grok45Request('low')).events);

    expect(native.modelRequests).toEqual([{
      _meta: { reasoningEffort: 'low' },
      modelId: 'grok-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('loads once per native connection and quarantines session replay from live output', async () => {
    const native = new FakeNativeConnection();
    native.loadImplementation = async request => {
      native.emit({
        content: { text: 'historical replay', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { sessionId: request.sessionId };
    };
    native.promptImplementation = async () => {
      native.emit({
        content: { text: 'live answer', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const firstEvents = await collect(session.execute(executionRequest('first')).events);
    const secondEvents = await collect(session.execute(executionRequest('second')).events);

    expect(native.loadRequests).toHaveLength(1);
    expect(firstEvents.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'live answer' }),
    ]);
    expect(secondEvents.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'live answer' }),
    ]);
  });

  it('keeps one loaded connection for dynamic model and mode changes', async () => {
    const native = new FakeNativeConnection();
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => native),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(sessionConfig);
    const firstRequest = executionRequest('first');
    const secondRequest: ProviderExecutionRequest = {
      ...executionRequest('second'),
      configuration: {
        ...firstRequest.configuration,
        mode: 'default',
        model: 'grok/grok-3',
      },
    };

    await collect(session.execute(firstRequest).events);
    await collect(session.execute(secondRequest).events);

    expect(nativeFactory.create).toHaveBeenCalledTimes(1);
    expect(native.loadRequests).toHaveLength(1);
    expect(native.modelRequests.map(request => request.modelId)).toEqual([
      'grok-4',
      'grok-3',
    ]);
    expect(native.modeRequests.map(request => request.modeId)).toEqual([
      'plan',
      'default',
    ]);
  });

  it('reconnects and loads once when load-scoped session metadata changes', async () => {
    const firstNative = new FakeNativeConnection();
    const secondNative = new FakeNativeConnection();
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(firstNative)
        .mockReturnValueOnce(secondNative),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(sessionConfig);
    const firstRequest = executionRequest('first');
    const secondRequest: ProviderExecutionRequest = {
      ...executionRequest('second'),
      configuration: {
        ...firstRequest.configuration,
        systemInstructions: { kind: 'explicit', instructions: 'Use the replacement policy.' },
      },
    };

    await collect(session.execute(firstRequest).events);
    await collect(session.execute(secondRequest).events);

    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(firstNative.loadRequests).toHaveLength(1);
    expect(firstNative.shutdownCalls).toBe(1);
    expect(secondNative.loadRequests).toEqual([
      expect.objectContaining({
        _meta: expect.objectContaining({
          systemPromptOverride: 'Use the replacement policy.',
        }),
        sessionId: 'session-existing',
      }),
    ]);
  });

  it('bootstraps canonical history only when creating a new native session', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const request = {
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'prior question', id: 'user-prior', role: 'user' as const, timestamp: 1 },
        { content: 'prior answer', id: 'assistant-prior', role: 'assistant' as const, timestamp: 2 },
      ],
    };

    await collect(session.execute(request).events);
    await collect(session.execute(request).events);

    expect(native.newRequests).toHaveLength(1);
    expect(native.promptRequests[0]?.prompt).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('prior question'),
        type: 'text',
      }),
    ]);
    expect(JSON.stringify(native.promptRequests[0]?.prompt)).toContain('prior answer');
    expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior question');
    expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior answer');
  });

  it('persists pending cold-history replay across execution-session recreation', async () => {
    const firstNative = new FakeNativeConnection();
    firstNative.modelImplementation = async () => {
      throw new Error('model configuration failed before prompt handoff');
    };
    const backend = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => firstNative } },
    );
    const firstSession = backend.createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const request = {
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'durable prior', id: 'user-prior', role: 'user' as const, timestamp: 1 },
      ],
    };

    await collect(firstSession.execute(request).events);
    const pendingSnapshot = firstSession.getSnapshot();

    expect(pendingSnapshot).toMatchObject({
      providerSessionId: 'session-new',
      providerState: { nativeConversationContextEstablished: false },
    });
    await firstSession.dispose();

    const secondNative = new FakeNativeConnection();
    const secondSession = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => secondNative } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: {
        providerSessionId: pendingSnapshot.providerSessionId,
        providerState: pendingSnapshot.providerState,
      },
    });

    await collect(secondSession.execute(request).events);

    expect(JSON.stringify(secondNative.promptRequests[0]?.prompt)).toContain('durable prior');
    expect(secondSession.getSnapshot()).toMatchObject({
      providerState: { nativeConversationContextEstablished: true },
    });
  });

  it('does not bootstrap canonical history when loading native context', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute({
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'native-owned prior', id: 'user-prior', role: 'user', timestamp: 1 },
      ],
    }).events);

    expect(JSON.stringify(native.promptRequests[0]?.prompt)).not.toContain('native-owned prior');
  });

  it.each(['normal', 'yolo'] as const)(
    'exits native Plan mode for a persistent feature-shaped %s request',
    async (permissionMode) => {
      const native = new FakeNativeConnection();
      const session = new GrokExecutionBackend(
        { settings: {} } as ProviderHost,
        { nativeFactory: { create: () => native } },
      ).createSession(sessionConfig);

      await collect(session.execute(featurePermissionRequest('normal', 'plan')).events);
      await collect(session.execute(featurePermissionRequest(permissionMode)).events);

      expect(native.modeRequests).toEqual([
        { modeId: 'plan', sessionId: 'session-existing' },
        { modeId: 'default', sessionId: 'session-existing' },
      ]);
      expect(native.loadRequests).toHaveLength(permissionMode === 'yolo' ? 2 : 1);
      expect(native.loadRequests.at(-1)?._meta).toMatchObject({
        yoloMode: permissionMode === 'yolo',
      });
    },
  );

  it('enters native Plan mode from permission selection when explicit mode is absent', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute(featurePermissionRequest('plan')).events);

    expect(native.modeRequests).toEqual([
      { modeId: 'plan', sessionId: 'session-existing' },
    ]);
  });

  it('emits newly established native session state before terminal completion', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });

    const events = await collect(session.execute(executionRequest()).events);
    const stateEvents = events.filter(event => event.type === 'session_state_changed');

    expect(native.newRequests).toHaveLength(1);
    expect(stateEvents).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          status: 'idle',
        }),
      }),
    ]);
    expect(stateEvents[0]).not.toHaveProperty('snapshot.providerSessionId');
    expect(events.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-new',
        status: 'idle',
      }),
      type: 'session_state_changed',
    });
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  it('cancels a pre-aborted request without starting native work', async () => {
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => new FakeNativeConnection()),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const abortController = new AbortController();
    abortController.abort();

    const run = session.execute({
      ...executionRequest(),
      signal: abortController.signal,
    });
    expect(nativeFactory.create).not.toHaveBeenCalled();
    const events = await collect(run.events);

    expect(nativeFactory.create).not.toHaveBeenCalled();
    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'aborted', type: 'cancelled' }),
    ]);
  });

  it('quarantines cancellation and replaces the native process before the next turn', async () => {
    const first = new FakeNativeConnection();
    const second = new FakeNativeConnection();
    first.promptImplementation = () => new Promise(() => {});
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(sessionConfig);

    const firstRun = session.execute(executionRequest('first'));
    while (first.promptRequests.length === 0) await Promise.resolve();
    firstRun.cancel();
    const firstEvents = await collect(firstRun.events);
    const secondEvents = await collect(session.execute(executionRequest('second')).events);

    expect(first.cancelCalls).toBe(1);
    expect(first.shutdownCalls).toBe(1);
    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(firstEvents.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({
          reason: 'cancelled',
          recoverable: true,
        }),
        providerSessionId: 'session-existing',
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(secondEvents.at(-1)?.type).toBe('turn_completed');
  });

  it('quarantines native output as soon as cancellation begins', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    run.cancel();
    native.emit({
      content: { text: 'late during cancel delivery', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    const events = await collect(run.events);

    expect(events.some(event => event.type === 'text_delta')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      reason: 'cancelled',
      type: 'cancelled',
    });
  });

  it('emits only cancelled when quarantine shutdown rejects the pending native prompt', async () => {
    const native = new FakeNativeConnection();
    let rejectPrompt: ((reason: Error) => void) | undefined;
    native.promptImplementation = () => new Promise((_resolve, reject) => {
      rejectPrompt = reject;
    });
    native.shutdownImplementation = async () => {
      native.emit({
        content: { text: 'late during quarantine', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      rejectPrompt?.(new Error('transport closed while prompting'));
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    run.cancel();
    const events = await collect(run.events);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'cancelled', type: 'cancelled' }),
    ]);
    expect(native.cancelCalls).toBe(1);
    expect(native.shutdownCalls).toBe(1);
    expect(events.some(event => event.type === 'text_delta')).toBe(false);
  });

  it('fences startup rejection caused by cancellation shutdown', async () => {
    const native = new FakeNativeConnection();
    let rejectInitialize: ((reason: Error) => void) | undefined;
    native.initializeImplementation = () => new Promise((_resolve, reject) => {
      rejectInitialize = reject;
    });
    native.shutdownImplementation = async () => {
      rejectInitialize?.(new Error('transport closed while initializing'));
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (!rejectInitialize) await Promise.resolve();

    run.cancel();
    const events = await collect(run.events);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'cancelled', type: 'cancelled' }),
    ]);
    expect(native.shutdownCalls).toBe(1);
  });

  it('cleans failed initialization before retrying with a fresh native generation', async () => {
    const failedNative = new FakeNativeConnection();
    const retryNative = new FakeNativeConnection();
    const failedCleanup = createDeferred<void>();
    const retryPrompt = createDeferred<{ stopReason: string }>();
    failedNative.initializeImplementation = async () => {
      throw new Error('authentication handshake failed');
    };
    failedNative.shutdownImplementation = async () => {
      await failedCleanup.promise;
      throw new Error('failed native cleanup also failed');
    };
    retryNative.promptImplementation = () => retryPrompt.promise;
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(failedNative)
        .mockReturnValueOnce(retryNative),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(sessionConfig);

    let firstRunSettled = false;
    const firstEventsPromise = collect(session.execute(executionRequest('first')).events)
      .then(events => {
        firstRunSettled = true;
        return events;
      });
    await drainMicrotasks();

    expect(failedNative.isAlive()).toBe(true);
    expect(failedNative.shutdownCalls).toBe(1);
    expect(firstRunSettled).toBe(false);

    failedCleanup.resolve();
    const firstEvents = await firstEventsPromise;
    expect(firstEvents.at(-1)).toMatchObject({
      message: 'authentication handshake failed',
      type: 'execution_error',
    });
    expect(failedNative.shutdownCalls).toBe(1);

    const retryEventsPromise = collect(session.execute(executionRequest('retry')).events);
    while (retryNative.promptRequests.length === 0) await Promise.resolve();
    failedNative.emitRetained({
      content: { text: 'stale failed native output', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    retryPrompt.resolve({ stopReason: 'end_turn' });
    const retryEvents = await retryEventsPromise;

    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(failedNative.initializeCalls).toBe(1);
    expect(retryNative.initializeCalls).toBe(1);
    expect(retryEvents.some(event => (
      event.type === 'text_delta' && event.text.includes('stale failed native output')
    ))).toBe(false);

    await session.dispose();
    expect(failedNative.shutdownCalls).toBe(1);
    expect(retryNative.shutdownCalls).toBe(1);
  });

  it.each(['cancel', 'dispose'] as const)(
    'joins failed initialization cleanup when %s races teardown',
    async (teardown) => {
      const native = new FakeNativeConnection();
      const initialize = createDeferred<void>();
      const cleanup = createDeferred<void>();
      native.initializeImplementation = () => initialize.promise;
      native.shutdownImplementation = () => cleanup.promise;
      const session = new GrokExecutionBackend(
        { settings: {} } as ProviderHost,
        { nativeFactory: { create: () => native } },
      ).createSession(sessionConfig);
      const run = session.execute(executionRequest());
      const eventsPromise = collect(run.events);
      while (native.initializeCalls === 0) await Promise.resolve();

      initialize.reject(new Error('initialize rejected before teardown'));
      await drainMicrotasks();
      expect(native.shutdownCalls).toBe(1);

      let teardownSettled = false;
      const teardownPromise = (teardown === 'cancel'
        ? (run.cancel(), eventsPromise.then(() => undefined))
        : session.dispose()).then(() => {
        teardownSettled = true;
      });
      await drainMicrotasks();

      expect(teardownSettled).toBe(false);
      expect(native.shutdownCalls).toBe(1);

      cleanup.resolve();
      await teardownPromise;
      const events = await eventsPromise;

      expect(native.shutdownCalls).toBe(1);
      expect(events.filter(event => (
        event.type === 'cancelled'
        || event.type === 'execution_error'
        || event.type === 'turn_completed'
      ))).toEqual([
        expect.objectContaining({
          ...(teardown === 'cancel'
            ? { reason: 'cancelled', type: 'cancelled' }
            : { reason: 'session-disposed', type: 'cancelled' }),
        }),
      ]);
      await session.dispose();
    },
  );

  it('drains disposal and fences notifications and prompt rejection after disposal begins', async () => {
    const native = new FakeNativeConnection();
    let rejectPrompt: ((reason: Error) => void) | undefined;
    native.promptImplementation = () => new Promise((_resolve, reject) => {
      rejectPrompt = reject;
    });
    native.shutdownImplementation = async () => {
      rejectPrompt?.(new Error('transport closed while disposing'));
      throw new Error('process shutdown failed after transport disposal');
    };
    const sessionEvents = jest.fn();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    session.onEvent(sessionEvents);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    const disposing = session.dispose();
    native.emit({
      content: { text: 'late', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    await expect(disposing).resolves.toBeUndefined();
    const events = await collect(run.events);

    expect(native.shutdownCalls).toBe(1);
    expect(events.some(event => event.type === 'text_delta')).toBe(false);
    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'session-disposed', type: 'cancelled' }),
    ]);
    expect(sessionEvents).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe('disposed');
  });

  it('deduplicates mirrored Grok notifications and publishes commands', async () => {
    const native = new FakeNativeConnection();
    const setCommandSnapshot = jest.fn();
    native.promptImplementation = async () => {
      const update = {
        content: { text: 'once', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      };
      native.emit(update, 'standard');
      native.emit(update, 'extension');
      native.emit({
        availableCommands: [{
          description: 'Review changes',
          input: { hint: '[path]' },
          name: 'review',
        }],
        sessionUpdate: 'available_commands_update',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        commandCatalog: { setCommandSnapshot },
        nativeFactory: { create: () => native },
      },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.filter(event => event.type === 'text_delta')).toHaveLength(1);
    expect(setCommandSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'review' }),
    ]);
  });

  it('normalizes live Grok tool names, inputs, results, and provider payloads like replay', async () => {
    const native = new FakeNativeConnection();
    const rawInput = { target_file: 'README.md' };
    const rawOutput = { bytes: 12 };
    native.promptImplementation = async () => {
      native.emit({
        rawInput,
        sessionUpdate: 'tool_call',
        title: 'read_file',
        toolCallId: 'tool-read',
      });
      native.emit({
        rawOutput,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tool-read',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      input: {
        file_path: 'README.md',
        target_file: 'README.md',
      },
      name: 'Read',
      providerPayload: {
        rawInput,
        rawName: 'read_file',
      },
      toolCallId: 'tool-read',
      type: 'tool_started',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      toolCallId: 'tool-read',
      toolUseResult: expect.objectContaining({
        providerPayload: {
          rawInput,
          rawName: 'read_file',
          rawOutput,
        },
      }),
      type: 'tool_completed',
    }));
  });

  it('preserves native overwrite diffs in live Grok tool results', async () => {
    const native = new FakeNativeConnection();
    const rawInput = { content: 'new text', file_path: 'src/write.ts' };
    const rawOutput = { type: 'WriteResult' };
    native.promptImplementation = async () => {
      native.emit({
        rawInput,
        sessionUpdate: 'tool_call',
        title: 'write',
        toolCallId: 'tool-write',
      });
      native.emit({
        content: [{
          newText: 'new text',
          oldText: 'old text',
          path: 'src/write.ts',
          type: 'diff',
        }],
        rawOutput,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tool-write',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      toolCallId: 'tool-write',
      toolUseResult: {
        filePath: 'src/write.ts',
        newText: 'new text',
        oldText: 'old text',
        providerPayload: {
          rawInput,
          rawName: 'write',
          rawOutput,
        },
      },
      type: 'tool_completed',
    }));
  });

  it('uses native interjection and rewind without creating an unrelated session', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        nativeFactory: { create: () => native },
        resolvePromptIndex: async () => 3,
      },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    if (!isSteerableExecutionSession(session) || !isRewindableExecutionSession(session)) {
      throw new Error('Expected Grok execution capabilities.');
    }

    await expect(session.steer(executionRequest('redirect'))).resolves.toBe(true);
    run.cancel();
    await collect(run.events);
    await expect(session.previewRewind('user-1', 'assistant-1')).resolves.toMatchObject({
      canRewind: true,
    });

    expect(native.interjectCalls).toHaveLength(1);
    expect(native.rewindCalls).toHaveLength(1);
    expect(native.newRequests).toHaveLength(0);
  });

  it('rejects an ambiguous native interjection failure after handoff', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    native.interjectImplementation = async () => {
      throw new Error('transport closed after interjection was written');
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Expected Grok steer capability.');
    }

    await expect(session.steer(executionRequest('redirect')))
      .rejects.toThrow('transport closed after interjection was written');

    expect(native.interjectCalls).toHaveLength(1);
    run.cancel();
    await collect(run.events);
  });

  it('rejects when lifecycle disposal closes a handed-off interjection', async () => {
    const native = new FakeNativeConnection();
    let rejectInterject: ((reason: Error) => void) | undefined;
    native.promptImplementation = () => new Promise(() => {});
    native.interjectImplementation = () => new Promise((_resolve, reject) => {
      rejectInterject = reject;
    });
    native.shutdownImplementation = async () => {
      rejectInterject?.(new Error('transport closed during lifecycle disposal'));
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Expected Grok steer capability.');
    }

    const steering = session.steer(executionRequest('redirect'));
    while (!rejectInterject) await Promise.resolve();
    const disposing = session.dispose();

    await expect(steering).rejects.toThrow('transport closed during lifecycle disposal');
    await expect(disposing).resolves.toBeUndefined();
    await collect(run.events);
    expect(native.interjectCalls).toHaveLength(1);
  });

  it('keeps native acceptance when the session becomes stale after interjection handoff', async () => {
    const native = new FakeNativeConnection();
    let resolveInterject: (() => void) | undefined;
    native.promptImplementation = () => new Promise(() => {});
    native.interjectImplementation = () => new Promise(resolve => {
      resolveInterject = resolve;
    });
    native.shutdownImplementation = async () => {
      resolveInterject?.();
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Expected Grok steer capability.');
    }

    const steering = session.steer(executionRequest('redirect'));
    while (!resolveInterject) await Promise.resolve();
    const disposing = session.dispose();

    await expect(steering).resolves.toBe(true);
    await expect(disposing).resolves.toBeUndefined();
    await collect(run.events);
    expect(native.interjectCalls).toHaveLength(1);
  });

  it('returns false before handoff when steering is unavailable or already aborted', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Expected Grok steer capability.');
    }

    await expect(session.steer(executionRequest('before turn'))).resolves.toBe(false);

    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    const abortController = new AbortController();
    abortController.abort();
    await expect(session.steer({
      ...executionRequest('aborted redirect'),
      signal: abortController.signal,
    })).resolves.toBe(false);

    expect(native.interjectCalls).toHaveLength(0);
    run.cancel();
    await expect(session.steer(executionRequest('redirect after cancellation')))
      .resolves.toBe(false);
    expect(native.interjectCalls).toHaveLength(0);
    await collect(run.events);
  });

  it('resolves fresh-session rewind through the current target session by default', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });

    await collect(session.execute(executionRequest()).events);
    if (!isRewindableExecutionSession(session)) {
      throw new Error('Expected Grok rewind capability.');
    }
    await expect(session.previewRewind('user-1', 'assistant-fresh'))
      .resolves.toMatchObject({ canRewind: true });
    await expect(session.rewind('user-1', 'assistant-fresh'))
      .resolves.toMatchObject({ canRewind: true });

    expect(session.getSnapshot().providerState).toEqual({
      nativeConversationContextEstablished: true,
      sessionDirectory: '/trusted/grok/sessions/session-new',
    });
    expect(mockLoadGrokPromptIndexAfterAssistant).toHaveBeenNthCalledWith(
      1,
      '/trusted/grok/sessions/session-new',
      'session-new',
      'assistant-fresh',
    );
    expect(mockLoadGrokPromptIndexAfterAssistant).toHaveBeenNthCalledWith(
      2,
      '/trusted/grok/sessions/session-new',
      'session-new',
      'assistant-fresh',
    );
    expect(native.rewindCalls).toEqual([
      expect.objectContaining({ force: false, sessionId: 'session-new' }),
      expect.objectContaining({ force: true, sessionId: 'session-new' }),
    ]);
  });

  it('forks from provider-owned checkpoint metadata instead of loading the source', async () => {
    const native = new FakeNativeConnection();
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        nativeFactory: { create: () => native },
      },
    ).createSession(forkSessionConfig());

    const events = await collect(session.execute(executionRequest()).events);

    expect(native.forkCalls).toEqual([
      expect.objectContaining({
        sourceSessionId: 'session-source',
        targetPromptIndex: 3,
      }),
    ]);
    expect(native.loadRequests).toHaveLength(0);
    expect(native.newRequests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionDirectory',
        ],
        providerSessionId: 'session-forked',
        status: 'executing',
      }),
      type: 'session_state_changed',
    }));
    expect(events.filter(event => event.type === 'session_state_changed').at(-1))
      .toMatchObject({
        snapshot: {
          providerStateDeletes: [
            'forkSource',
            'forkSourceSessionDirectory',
          ],
          providerSessionId: 'session-forked',
          status: 'idle',
        },
      });
    expect(session.getSnapshot().providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionDirectory',
    ]);
    expect(session.getSnapshot().providerStateDeletes).not.toContain('futureState');
    expect(session.getSnapshot().providerSessionId).toBe('session-forked');
    expect(session.getSnapshot().providerState).toEqual({
      sessionDirectory: '/trusted/grok/sessions/session-forked',
    });

    if (!isRewindableExecutionSession(session)) {
      throw new Error('Expected Grok rewind capability.');
    }
    await expect(session.previewRewind('user-target', 'assistant-target'))
      .resolves.toMatchObject({ canRewind: true });
    await expect(session.rewind('user-target', 'assistant-target'))
      .resolves.toMatchObject({ canRewind: true });
    expect(mockLoadGrokPromptIndexAfterAssistant.mock.calls).toEqual([
      ['/tmp/grok-source/session-source', 'session-source', 'assistant-source'],
      ['/trusted/grok/sessions/session-forked', 'session-forked', 'assistant-target'],
      ['/trusted/grok/sessions/session-forked', 'session-forked', 'assistant-target'],
    ]);

    native.promptImplementation = async () => {
      throw new Error('transport closed after fork');
    };
    const invalidatedEvents = await collect(session.execute(executionRequest('retry')).events);
    expect(invalidatedEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionDirectory',
        ],
        providerSessionId: 'session-forked',
        status: 'invalidated',
      },
      type: 'session_state_changed',
    });
    expect(native.forkCalls).toHaveLength(1);
  });

  it('adopts a deferred fork before cancellation quiesces and reloads that child on retry', async () => {
    const first = new FakeNativeConnection();
    const second = new FakeNativeConnection();
    const fork = createDeferred<{
      newCwd: string;
      newSessionId: string;
      parentSessionId: string;
    }>();
    first.forkImplementation = () => fork.promise;
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(forkSessionConfig());

    const run = session.execute(executionRequest('fork then cancel'));
    const eventsPromise = collect(run.events);
    while (first.forkCalls.length === 0) await Promise.resolve();

    run.cancel();
    let cancellationSettled = false;
    void eventsPromise.then(() => { cancellationSettled = true; });
    await drainMicrotasks();

    expect(cancellationSettled).toBe(false);
    expect(first.shutdownCalls).toBe(0);

    fork.resolve({
      newCwd: '/tmp/vault',
      newSessionId: 'session-forked-late',
      parentSessionId: 'session-source',
    });
    const events = await eventsPromise;

    expect(first.forkCalls).toHaveLength(1);
    expect(first.cancelCalls).toBe(1);
    expect(first.shutdownCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-forked-late',
        providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'],
      }),
      type: 'session_state_changed',
    }));

    const retryEvents = await collect(session.execute(executionRequest('retry child')).events);
    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(second.forkCalls).toHaveLength(0);
    expect(second.loadRequests).toEqual([
      expect.objectContaining({ sessionId: 'session-forked-late' }),
    ]);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-forked-late',
      providerState: {
        sessionDirectory: '/trusted/grok/sessions/session-forked-late',
      },
      providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'],
    });
    expect(session.getSnapshot().providerStateDeletes).not.toContain('futureState');
  });

  it('joins a deferred fork during disposal and retains the exact child ownership snapshot', async () => {
    const native = new FakeNativeConnection();
    const fork = createDeferred<{
      newCwd: string;
      newSessionId: string;
      parentSessionId: string;
    }>();
    native.forkImplementation = () => fork.promise;
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(forkSessionConfig());
    const eventsPromise = collect(session.execute(executionRequest('fork then dispose')).events);
    while (native.forkCalls.length === 0) await Promise.resolve();

    let disposalSettled = false;
    const disposal = session.dispose().then(() => { disposalSettled = true; });
    await drainMicrotasks();

    expect(disposalSettled).toBe(false);
    expect(native.shutdownCalls).toBe(0);

    fork.resolve({
      newCwd: '/tmp/vault',
      newSessionId: 'session-forked-before-dispose',
      parentSessionId: 'session-source',
    });
    await disposal;
    const events = await eventsPromise;

    expect(native.forkCalls).toHaveLength(1);
    expect(native.cancelCalls).toBe(1);
    expect(native.shutdownCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-forked-before-dispose',
        providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'],
      }),
      type: 'session_state_changed',
    }));
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-forked-before-dispose',
      providerState: {
        sessionDirectory: '/trusted/grok/sessions/session-forked-before-dispose',
      },
      providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'],
      status: 'disposed',
    });
    expect(session.getSnapshot().providerStateDeletes).not.toContain('futureState');
  });

  it('retains a known fork child even when parent validation fails and never reforks', async () => {
    const native = new FakeNativeConnection();
    native.forkImplementation = async (request) => ({
      newCwd: request.newCwd,
      newSessionId: 'session-forked-unexpected-parent',
      parentSessionId: 'unexpected-parent',
    });
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(forkSessionConfig());

    const failedEvents = await collect(session.execute(executionRequest('fork')).events);

    expect(failedEvents.at(-1)).toMatchObject({
      message: 'Grok returned a fork for an unexpected parent session.',
      type: 'execution_error',
    });
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-forked-unexpected-parent',
      providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'],
      status: 'invalidated',
    });

    await collect(session.execute(executionRequest('retry')).events);

    expect(native.forkCalls).toHaveLength(1);
    expect(native.loadRequests).toEqual([
      expect.objectContaining({ sessionId: 'session-forked-unexpected-parent' }),
    ]);
  });

  it('publishes live model metadata and rejects passive auxiliary permissions', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    native.loadResponse = {
      models: {
        availableModels: [{ modelId: 'grok-4', name: 'Grok 4' }],
        currentModelId: 'grok-4',
      },
      sessionId: 'session-existing',
    };
    const mergeLiveModels = jest.fn();
    let nativeOptions: GrokExecutionNativeCreateOptions | undefined;
    const request = {
      ...executionRequest(),
      toolPolicy: { kind: 'passive' as const },
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        modelCatalogCoordinator: { mergeLiveModels },
        nativeFactory: {
          create: options => {
            nativeOptions = options;
            return native;
          },
        },
      },
    ).createSession(sessionConfig);
    const run = session.execute(request);
    while (native.promptRequests.length === 0) await Promise.resolve();

    await expect(nativeOptions?.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      sessionId: 'session-existing',
      toolCall: { title: 'write', toolCallId: 'tool-1' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(interactionPort.requestApproval).not.toHaveBeenCalled();
    expect(mergeLiveModels).toHaveBeenCalledWith(
      [expect.objectContaining({ rawId: 'grok-4' })],
      'grok-4',
      expect.any(String),
    );
    const systemPromptOverride = String(
      native.loadRequests[0]?._meta?.systemPromptOverride,
    );
    expect(systemPromptOverride).toContain('Be exact.');
    expect(systemPromptOverride).toContain('Do not use any tools');
    run.cancel();
    await collect(run.events);
  });

  it('fails read-only permission requests closed without claiming a native read-only profile', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    let nativeOptions: GrokExecutionNativeCreateOptions | undefined;
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        nativeFactory: {
          create: options => {
            nativeOptions = options;
            return native;
          },
        },
      },
    ).createSession(sessionConfig);
    const run = session.execute({
      ...executionRequest(),
      toolPolicy: { kind: 'read-only' },
    });
    while (native.promptRequests.length === 0) await Promise.resolve();

    await expect(nativeOptions?.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      sessionId: 'session-existing',
      toolCall: { title: 'read_file', toolCallId: 'tool-read' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(native.loadRequests[0]?._meta).toEqual(expect.objectContaining({
      systemPromptOverride: 'Be exact.',
    }));
    expect(native.loadRequests[0]?._meta).not.toHaveProperty('toolProfile');
    expect(interactionPort.requestApproval).not.toHaveBeenCalled();
    run.cancel();
    await collect(run.events);
  });

  it('routes Grok question extensions through stable interaction identities', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => new Promise(() => {});
    let nativeOptions: GrokExecutionNativeCreateOptions | undefined;
    jest.mocked(interactionPort.askUserQuestion).mockImplementation(async request => ({
      answers: { target: 'src' },
      interactionId: request.interactionId,
    }));
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      {
        nativeFactory: {
          create: options => {
            nativeOptions = options;
            return native;
          },
        },
      },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    await expect(nativeOptions?.requestExtension('x.ai/ask_user_question', {
      mode: 'default',
      questions: [{
        id: 'target',
        multiSelect: false,
        options: [{ id: 'src', label: 'Source' }],
        question: 'Which area?',
      }],
      sessionId: 'session-existing',
      toolCallId: 'tool-question',
    })).resolves.toEqual({
      answers: { 'Which area?': ['Source'] },
      outcome: 'accepted',
    });
    expect(interactionPort.askUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: expect.stringContaining(':question:'),
        sessionInstanceId: session.sessionInstanceId,
        turnId: run.turnId,
      }),
      expect.any(AbortSignal),
    );
    run.cancel();
    await collect(run.events);
  });

  it('fails closed before native startup when exact allow-list enforcement is unavailable', async () => {
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => new FakeNativeConnection()),
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory },
    ).createSession(sessionConfig);
    const request: ProviderExecutionRequest = {
      ...executionRequest(),
      toolPolicy: { kind: 'allow-list', names: ['read_file'] },
    };

    const events = await collect(session.execute(request).events);

    expect(nativeFactory.create).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          status: 'executing',
        }),
        type: 'session_state_changed',
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          invalidation: expect.objectContaining({
            reason: 'configuration-changed',
            recoverable: false,
          }),
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
      expect.objectContaining({
        category: 'configuration',
        message: expect.stringContaining('allow-list'),
        recoverable: false,
        type: 'execution_error',
      }),
    ]);
    expect(session.getSnapshot()).toMatchObject({
      invalidation: {
        reason: 'configuration-changed',
        recoverable: false,
      },
      status: 'invalidated',
    });
  });

  it('emits invalidated provider state before a terminal execution failure', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = async () => {
      throw new Error('transport closed while prompting');
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({
          reason: 'transport-closed',
          recoverable: true,
        }),
        providerSessionId: 'session-existing',
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      type: 'execution_error',
    });
  });

  it('identifies the stale native session when load reports it missing', async () => {
    const native = new FakeNativeConnection();
    native.loadImplementation = async () => {
      throw new Error('session not found');
    };
    const session = new GrokExecutionBackend(
      { settings: {} } as ProviderHost,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'session-existing',
      type: 'execution_error',
    });
  });
});
