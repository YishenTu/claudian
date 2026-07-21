import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCapabilities } from '@/core/providers/types';
import type { AcpSubprocessLaunchSpec } from '@/providers/acp';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import {
  GrokChatRuntime,
  type GrokRuntimeProcess,
} from '@/providers/grok/runtime/GrokChatRuntime';
import { buildGrokRuntimeEnv } from '@/providers/grok/runtime/GrokRuntimeEnvironment';
import { getHostnameKey } from '@/utils/env';

const VAULT_PATH = '/tmp/claudian-grok-runtime-vault';
const CAPABILITIES: ProviderCapabilities = {
  providerId: 'grok',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsLegacySubagentTools: false,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: false,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
};

type JsonRpcMessage = Record<string, unknown> & { id?: number; method?: string };

class FakeGrokProcess implements GrokRuntimeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: JsonRpcMessage[] = [];
  shutdownCalls = 0;
  private alive = false;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private nextServerRequestId = 10_000;
  private readonly responseWaiters = new Map<number, (result: unknown) => void>();

  constructor(
    readonly launchSpec: AcpSubprocessLaunchSpec,
    private readonly handlers: {
      cancel?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      initialize?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      load?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      newSession?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      prompt?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      setModel?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
    } = {},
  ) {
    let buffered = '';
    this.stdin.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.receive(JSON.parse(line) as JsonRpcMessage);
      }
    });
  }

  start(): void {
    this.alive = true;
  }

  isAlive(): boolean {
    return this.alive;
  }

  getStderrSnapshot(): string {
    return '';
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.alive = false;
  }

  close(error?: Error): void {
    this.alive = false;
    for (const listener of this.closeListeners) listener(error);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextServerRequestId++;
    this.send({ id, jsonrpc: '2.0', method, params });
    return new Promise(resolve => this.responseWaiters.set(id, resolve));
  }

  respond(message: JsonRpcMessage, result: unknown): void {
    this.send({ id: message.id, jsonrpc: '2.0', result });
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      this.responseWaiters.get(message.id)?.(message.result);
      this.responseWaiters.delete(message.id);
      return;
    }
    this.requests.push(message);
    if (message.method === 'session/cancel') this.handlers.cancel?.(message, this);
    if (message.id === undefined) return;

    switch (message.method) {
      case 'initialize':
        if (this.handlers.initialize) {
          this.handlers.initialize(message, this);
          return;
        }
        this.respond(message, {
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
          agentInfo: { name: 'grok', version: '0.2.106' },
          authMethods: [{ id: 'grok-login', type: 'agent' }],
          protocolVersion: 1,
        });
        return;
      case 'session/new':
        if (this.handlers.newSession) this.handlers.newSession(message, this);
        else this.respond(message, sessionResponse('session-new'));
        return;
      case 'session/load':
        if (this.handlers.load) this.handlers.load(message, this);
        else this.respond(message, sessionResponse(String(record(message.params).sessionId)));
        return;
      case 'session/set_model':
        if (this.handlers.setModel) this.handlers.setModel(message, this);
        else this.respond(message, { _meta: {} });
        return;
      case 'session/prompt':
        if (this.handlers.prompt) this.handlers.prompt(message, this);
        else this.respond(message, promptResponse());
        return;
      default:
        this.respond(message, {});
    }
  }

  private send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function sessionResponse(sessionId: string): Record<string, unknown> {
  return {
    _meta: {
      reasoningEffort: 'xhigh',
      'x.ai/sessionConfig': {
        options: [
          { category: 'mode', id: 'xhigh', label: 'Extra high', selected: true },
          { category: 'mode', id: 'minimal', label: 'Minimal', selected: false },
          { category: 'mode', id: 'high', label: 'High', selected: false },
        ],
      },
    },
    sessionId,
    models: {
      availableModels: [{
        _meta: {
          agentType: 'grok-build-plan',
          totalContextTokens: 200_000,
          supportsReasoningEffort: true,
        },
        modelId: 'grok-4.5',
        name: 'Grok 4.5',
      }],
      currentModelId: 'grok-4.5',
    },
  };
}

function promptResponse(): Record<string, unknown> {
  return {
    stopReason: 'end_turn',
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    userMessageId: 'user-live',
  };
}

function createHost(overrides: Record<string, unknown> = {}): ProviderHost {
  const settings = {
    effortLevel: 'medium',
    mediaFolder: 'attachments',
    model: 'grok/grok-4.5',
    permissionMode: 'normal',
    providerConfigs: { grok: { enabled: true } },
    systemPrompt: 'Keep answers concise.',
    userName: 'Tester',
    ...record(overrides.settings),
  };
  return {
    app: { vault: { adapter: { basePath: VAULT_PATH } } },
    manifest: { version: '1.2.3' },
    mutateSettings: jest.fn(async mutation => mutation(settings as never)),
    mutateSettingsConditionally: jest.fn(async mutation => { await mutation(settings as never); }),
    refreshModelSelectors: jest.fn(),
    ...overrides,
    settings,
  } as unknown as ProviderHost;
}

function createHarness(params: {
  handlers?: ConstructorParameters<typeof FakeGrokProcess>[1];
  host?: ProviderHost;
  lifecycle?: GrokAuxiliaryLifecycleCoordinator;
  sessionDirectory?: string | null;
} = {}): {
  catalog: GrokCommandCatalog;
  host: ProviderHost;
  liveModels: jest.Mock;
  process: FakeGrokProcess;
  processes: FakeGrokProcess[];
  runtime: GrokChatRuntime;
} {
  const host = params.host ?? createHost();
  const catalog = new GrokCommandCatalog();
  const liveModels = jest.fn().mockResolvedValue({ changed: false });
  const processes: FakeGrokProcess[] = [];
  let process!: FakeGrokProcess;
  const runtime = new GrokChatRuntime(host, {
    capabilities: CAPABILITIES,
    cliResolver: { resolveFromSettings: () => '/opt/grok/bin/grok' },
    commandCatalog: catalog,
    lifecycle: params.lifecycle,
    modelCatalogCoordinator: { mergeLiveModels: liveModels },
    processFactory: (launchSpec) => {
      process = new FakeGrokProcess(launchSpec, params.handlers);
      processes.push(process);
      return process;
    },
    resolveSessionDirectory: () => params.sessionDirectory ?? null,
  });
  return { catalog, host, liveModels, get process() { return process; }, processes, runtime };
}

async function collect(
  runtime: GrokChatRuntime,
  text = 'Hello',
  model?: string,
): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of runtime.query(
    runtime.prepareTurn({ text }),
    undefined,
    model ? { model } : undefined,
  )) chunks.push(chunk);
  return chunks;
}

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

async function waitForRequest(process: FakeGrokProcess, method: string): Promise<JsonRpcMessage> {
  while (true) {
    const request = process.requests.find(candidate => candidate.method === method);
    if (request) return request;
    await tick();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe('GrokChatRuntime', () => {
  it('waits behind a provider transition before reading settings or spawning', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const host = createHost({
      settings: { providerConfigs: { grok: { enabled: true, environmentVariables: 'PROFILE=old' } } },
    });
    const harness = createHarness({ host, lifecycle });
    const transition = await lifecycle.beginEnvironmentChange();

    const query = collect(harness.runtime);
    await tick();
    expect(harness.processes).toHaveLength(0);
    (host.settings.providerConfigs.grok as Record<string, unknown>).environmentVariables = 'PROFILE=new';
    await transition.release();
    await query;

    expect(harness.processes).toHaveLength(1);
    expect(harness.process.launchSpec.env.PROFILE).toBe('new');
  });

  it('cancels a query waiting behind a provider transition without spawning', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({ lifecycle });
    const transition = await lifecycle.beginEnvironmentChange();
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'cancel' }));
    const pending = iterator.next();
    await tick();

    harness.runtime.cancel();
    await expect(pending).resolves.toEqual({ done: false, value: { type: 'done' } });
    expect(harness.processes).toHaveLength(0);
    await transition.release();
  });

  it('quiesces and shuts down a query admitted immediately before transition closure', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({
      lifecycle,
      handlers: { prompt() {} },
    });
    const query = collect(harness.runtime);
    while (harness.processes.length === 0) await tick();
    await waitForRequest(harness.process, 'session/prompt');

    const transition = await lifecycle.beginEnvironmentChange();
    await query;

    expect(harness.process.shutdownCalls).toBe(1);
    await transition.release();
  });

  it('can force readiness for a blank runtime without creating a native session', async () => {
    const harness = createHarness({ host: createHost({ settings: { model: 'grok/grok-4.5' } }) });

    await expect(harness.runtime.ensureReady({
      allowSessionCreation: false,
      force: true,
    })).resolves.toBe(true);

    expect(harness.process.requests.map(request => request.method)).toEqual(['initialize']);
    expect(harness.runtime.getSessionId()).toBeNull();
  });

  it('registers owner readiness during a held transition for future quiescence', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({
      host: createHost({ settings: { model: 'grok/grok-4.5' } }),
      lifecycle,
    });
    const currentTransition = await lifecycle.beginEnvironmentChange();

    await expect(harness.runtime.ensureReady({
      allowSessionCreation: false,
      force: true,
      providerTransitionOwner: true,
    })).resolves.toBe(true);

    expect(harness.process.requests.map(request => request.method)).toEqual(['initialize']);
    expect(harness.runtime.getSessionId()).toBeNull();
    expect(harness.process.shutdownCalls).toBe(0);
    await currentTransition.release();

    const nextTransition = await lifecycle.beginEnvironmentChange();
    expect(harness.process.shutdownCalls).toBe(1);
    await nextTransition.release();
  });

  it('does not re-register readiness after cleanup while waiting behind a transition', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({ lifecycle });
    const currentTransition = await lifecycle.beginEnvironmentChange();
    const quiesce = jest.spyOn(harness.runtime, 'quiesceForEnvironmentChange');

    const readiness = harness.runtime.ensureReady();
    await tick();
    harness.runtime.cleanup();
    await currentTransition.release();

    await expect(readiness).resolves.toBe(false);
    const nextTransition = await lifecycle.beginEnvironmentChange();
    expect(quiesce).not.toHaveBeenCalled();
    await nextTransition.release();
  });

  it('settles a query when cleanup occurs while transition admission is blocked', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({ lifecycle });
    const transition = await lifecycle.beginEnvironmentChange();
    const query = collect(harness.runtime);
    await tick();

    harness.runtime.cleanup();
    const outcome = await Promise.race([
      query.then(chunks => ({ chunks, settled: true })),
      new Promise<{ settled: false }>(resolve => {
        setTimeout(() => resolve({ settled: false }), 100);
      }),
    ]);
    await transition.release();

    expect(outcome).toEqual({ chunks: [{ type: 'done' }], settled: true });
    expect(harness.processes).toHaveLength(0);
  });

  it('launches the resolved CLI exactly, initializes once, never authenticates, and creates with effective metadata', async () => {
    const harness = createHarness();

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    expect(harness.process.launchSpec).toMatchObject({
      args: ['agent', '--no-leader', 'stdio'],
      command: '/opt/grok/bin/grok',
      cwd: VAULT_PATH,
    });
    expect(harness.process.launchSpec.env).toEqual(
      buildGrokRuntimeEnv(harness.host.settings, '/opt/grok/bin/grok'),
    );
    expect(harness.process.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
    expect(harness.process.requests.some(request => request.method === 'authenticate')).toBe(false);
    expect(record(harness.process.requests.find(request => request.method === 'session/new')?.params)).toMatchObject({
      cwd: VAULT_PATH,
      mcpServers: [],
      _meta: {
        modelId: 'grok-4.5',
        systemPromptOverride: expect.stringContaining('Keep answers concise.'),
        yoloMode: false,
      },
    });
    expect(harness.liveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        agentType: 'grok-build-plan',
        contextWindow: 200_000,
        defaultReasoningEffort: 'xhigh',
        rawId: 'grok-4.5',
        reasoningEfforts: [
          expect.objectContaining({ value: 'minimal' }),
          expect.objectContaining({ value: 'high' }),
          expect.objectContaining({ value: 'xhigh' }),
        ],
      }),
    ], undefined, expect.any(String));
  });

  it('applies top-level session reasoning metadata only to the current model', async () => {
    const response = sessionResponse('session-new');
    const models = record(response.models);
    models.availableModels = [
      ...(models.availableModels as unknown[]),
      {
        _meta: { agentType: 'grok-build', supportsReasoningEffort: false },
        modelId: 'other-model',
        name: 'Other model',
      },
    ];
    const harness = createHarness({
      handlers: {
        newSession(message, process) {
          process.respond(message, response);
        },
      },
    });

    await harness.runtime.ensureReady();

    expect(harness.liveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        defaultReasoningEffort: 'xhigh',
        rawId: 'grok-4.5',
        reasoningEfforts: expect.arrayContaining([
          expect.objectContaining({ value: 'minimal' }),
          expect.objectContaining({ value: 'xhigh' }),
        ]),
      }),
      expect.objectContaining({
        rawId: 'other-model',
        reasoningEfforts: [],
        supportsReasoning: false,
      }),
    ], undefined, expect.any(String));
    expect(record(harness.liveModels.mock.calls[0][0][1])).not.toHaveProperty(
      'defaultReasoningEffort',
    );
  });

  it.each([
    ['yolo', true],
    ['plan', false],
    ['unexpected', false],
  ])('loads with identical session metadata and maps %s to yoloMode=%s', async (mode, yoloMode) => {
    const host = createHost({ settings: { permissionMode: mode } });
    const harness = createHarness({ host });
    harness.runtime.syncConversationState({ providerState: {}, sessionId: 'saved-session' });

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    const load = harness.process.requests.find(request => request.method === 'session/load');
    expect(record(load?.params)).toMatchObject({
      sessionId: 'saved-session',
      _meta: expect.objectContaining({ yoloMode }),
    });
  });

  it('sets an explicit model and effort once per changed tuple', async () => {
    const harness = createHarness();

    await collect(harness.runtime, 'First');
    await collect(harness.runtime, 'Second');

    const setModel = harness.process.requests.filter(request => request.method === 'session/set_model');
    expect(setModel).toHaveLength(1);
    expect(setModel[0].params).toEqual({
      sessionId: 'session-new',
      modelId: 'grok-4.5',
      _meta: { reasoningEffort: 'medium' },
    });
  });

  it('rejects a turn when no explicit enabled model is selected', async () => {
    const host = createHost({
      settings: {
        model: '',
        providerConfigs: {
          grok: {
            catalogsByHost: {
              [getHostnameKey()]: {
                defaultModelId: 'catalog-default',
                fingerprint: 'catalog-fixture',
                models: [],
                refreshedAt: 1,
              },
            },
            enabled: true,
          },
        },
      },
    });
    const harness = createHarness({ host });

    const chunks = await collect(harness.runtime);

    expect(chunks).toEqual([
      expect.objectContaining({ content: expect.stringContaining('No Grok model is selected'), type: 'error' }),
      { type: 'done' },
    ]);
    expect(harness.process.requests.filter(request => request.method === 'session/new'))
      .toEqual([]);
    expect(harness.process.requests.filter(request => request.method === 'session/set_model'))
      .toEqual([]);
  });

  it('does not retarget a turn waiting for transition admission after conversation changes', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const harness = createHarness({ lifecycle });
    const transition = await lifecycle.beginEnvironmentChange();
    const switching = collect(harness.runtime, 'Old conversation prompt');
    await tick();

    harness.runtime.syncConversationState({
      id: 'other-conversation',
      providerState: {},
      sessionId: 'saved-other',
    });
    await transition.release();

    await expect(switching).resolves.toEqual([
      expect.objectContaining({ content: expect.stringMatching(/conversation changed/i), type: 'error' }),
      { type: 'done' },
    ]);
    expect(harness.processes.flatMap(process => process.requests)
      .filter(request => request.method === 'session/prompt')).toHaveLength(0);
    expect(harness.runtime.getSessionId()).toBe('saved-other');
  });

  it('reports an incompatible agent type without resetting the session', async () => {
    const harness = createHarness({
      handlers: {
        setModel(message, process) {
          process.stdout.write(`${JSON.stringify({
            error: { code: -32000, message: 'agentType is incompatible with this session' },
            id: message.id,
            jsonrpc: '2.0',
          })}\n`);
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'error',
        content: expect.stringMatching(/start a new conversation/i),
      }),
      { type: 'done' },
    ]);
    expect(harness.runtime.getSessionId()).toBe('session-new');
    expect(harness.runtime.consumeSessionInvalidation()).toBe(false);
  });

  it.each([
    ['new', null],
    ['load', 'saved-session'],
  ])('clears readiness when session/%s fails while retaining a saved binding', async (operation, sessionId) => {
    const fail = (message: JsonRpcMessage, process: FakeGrokProcess) => {
      process.stdout.write(`${JSON.stringify({
        error: { code: -32000, message: 'session unavailable' },
        id: message.id,
        jsonrpc: '2.0',
      })}\n`);
    };
    const harness = createHarness({
      handlers: operation === 'load' ? { load: fail } : { newSession: fail },
    });
    if (sessionId) {
      harness.runtime.syncConversationState({ providerState: {}, sessionId });
    }

    await expect(harness.runtime.ensureReady()).resolves.toBe(false);

    expect(harness.runtime.isReady()).toBe(false);
    expect(harness.runtime.getSessionId()).toBe(sessionId);
    expect(harness.runtime.consumeSessionInvalidation()).toBe(false);
  });

  it.each([
    ['a missing session id', { models: sessionResponse('session-new').models }],
    ['malformed model metadata', {
      models: {
        availableModels: [{ name: 'Broken model' }],
        currentModelId: 'broken-model',
      },
      sessionId: 'session-new',
    }],
  ])('does not bind a new session with %s and retries creation', async (_case, malformedResponse) => {
    let attempts = 0;
    const harness = createHarness({
      handlers: {
        newSession(message, process) {
          attempts += 1;
          process.respond(message, attempts === 1
            ? malformedResponse
            : sessionResponse('session-new'));
        },
      },
    });

    await expect(harness.runtime.ensureReady()).resolves.toBe(false);
    expect(harness.runtime.getSessionId()).toBeNull();

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);
    expect(harness.runtime.getSessionId()).toBe('session-new');
    expect(harness.process.requests.filter(request => request.method === 'session/new')).toHaveLength(2);
  });

  it.each([
    ['a mismatched session id', sessionResponse('different-session')],
    ['malformed model metadata', {
      models: {
        availableModels: [{ name: 'Broken model' }],
        currentModelId: 'broken-model',
      },
      sessionId: 'saved-session',
    }],
  ])('retains and retries a saved session after loading %s', async (_case, malformedResponse) => {
    let attempts = 0;
    const harness = createHarness({
      handlers: {
        load(message, process) {
          attempts += 1;
          process.respond(message, attempts === 1
            ? malformedResponse
            : sessionResponse('saved-session'));
        },
      },
    });
    harness.runtime.syncConversationState({ providerState: {}, sessionId: 'saved-session' });

    await expect(harness.runtime.ensureReady()).resolves.toBe(false);
    expect(harness.runtime.getSessionId()).toBe('saved-session');

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);
    expect(harness.runtime.getSessionId()).toBe('saved-session');
    expect(harness.process.requests.filter(request => request.method === 'session/load')).toHaveLength(2);
  });

  it('retains the requested binding when the real session/load response omits sessionId', async () => {
    const harness = createHarness({
      handlers: {
        load(message, process) {
          const response = sessionResponse('saved-session');
          delete response.sessionId;
          process.respond(message, response);
        },
      },
    });
    harness.runtime.syncConversationState({ providerState: {}, sessionId: 'saved-session' });

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);
    expect(harness.runtime.getSessionId()).toBe('saved-session');
  });

  it('accepts the installed Grok load response shape that omits sessionId', async () => {
    const response = sessionResponse('saved-session');
    delete response.sessionId;
    const harness = createHarness({
      handlers: {
        load(message, process) {
          process.respond(message, response);
        },
      },
    });
    harness.runtime.syncConversationState({ providerState: {}, sessionId: 'saved-session' });

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);
    expect(harness.runtime.getSessionId()).toBe('saved-session');
    expect(harness.process.requests.filter(request => request.method === 'session/load')).toHaveLength(1);
  });

  it('replays matching command metadata advertised before session/new returns', async () => {
    const harness = createHarness({
      handlers: {
        newSession(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              availableCommands: [{ description: 'Review changes', name: '/review' }],
              sessionUpdate: 'available_commands_update',
            },
          });
          process.respond(message, sessionResponse('session-new'));
        },
      },
    });

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    await expect(harness.runtime.getSupportedCommands()).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
    await expect(harness.catalog.listDropdownEntries({ includeBuiltIns: true })).resolves.toEqual([
      expect.objectContaining({ name: 'review', providerId: 'grok' }),
    ]);
    harness.runtime.cleanup();
  });

  it('suppresses load replay content while retaining metadata and streams live extension updates', async () => {
    const harness = createHarness({
      handlers: {
        load(message, process) {
          process.notify('_x.ai/session/update', {
            sessionId: 'saved-session',
            update: {
              content: { text: 'replayed text', type: 'text' },
              messageId: 'replay-message',
              sessionUpdate: 'agent_message_chunk',
            },
          });
          process.notify('session/update', {
            sessionId: 'saved-session',
            update: {
              availableCommands: [{ description: 'Review changes', name: '/review' }],
              sessionUpdate: 'available_commands_update',
            },
          });
          process.respond(message, sessionResponse('saved-session'));
        },
        prompt(message, process) {
          process.notify('x.ai/session/update', {
            sessionId: 'saved-session',
            update: {
              content: { text: 'live text', type: 'text' },
              messageId: 'assistant-live',
              sessionUpdate: 'agent_message_chunk',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });
    harness.runtime.syncConversationState({ providerState: {}, sessionId: 'saved-session' });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({ itemId: 'assistant-live', type: 'assistant_message_start' });
    expect(chunks).toContainEqual({ content: 'live text', type: 'text' });
    expect(chunks).not.toContainEqual(expect.objectContaining({ content: 'replayed text' }));
    await expect(harness.runtime.getSupportedCommands()).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
    await expect(harness.catalog.listDropdownEntries({ includeBuiltIns: true })).resolves.toEqual([
      expect.objectContaining({ name: 'review', providerId: 'grok' }),
    ]);
  });

  it.each([
    'x.ai/models/update',
    '_x.ai/models/update',
  ])('merges machine-wide model metadata from %s without a session id', async (method) => {
    const harness = createHarness();
    await harness.runtime.ensureReady();
    harness.liveModels.mockClear();

    harness.process.notify(method, {
      availableModels: [{
        _meta: {
          agentType: 'grok-build',
          reasoningEffort: 'xhigh',
          supportsReasoningEffort: true,
          totalContextTokens: 256_000,
          'x.ai/sessionConfig': {
            options: [
              { category: 'mode', id: 'xhigh', label: 'Extra high', selected: true },
              { category: 'mode', id: 'minimal', label: 'Minimal', selected: false },
              { category: 'mode', id: 'high', label: 'High', selected: false },
            ],
          },
        },
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
      }],
      currentModelId: 'grok-4.6',
    });
    await tick();

    expect(harness.liveModels).toHaveBeenCalledWith([
      expect.objectContaining({
        agentType: 'grok-build',
        contextWindow: 256_000,
        defaultReasoningEffort: 'xhigh',
        rawId: 'grok-4.6',
        reasoningEfforts: [
          expect.objectContaining({ value: 'minimal' }),
          expect.objectContaining({ value: 'high' }),
          expect.objectContaining({ value: 'xhigh' }),
        ],
      }),
    ], 'grok-4.6', expect.any(String));
    expect(harness.runtime.getAuxiliaryModel()).toBe('grok/grok-4.5');
    harness.runtime.cleanup();
  });

  it('streams thought, normalized tools, usage, and terminal prompt totals', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          const updates = [
            { content: { text: 'thinking', type: 'text' }, sessionUpdate: 'agent_thought_chunk' },
            {
              rawInput: { command: 'pwd' },
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              title: 'run_terminal_command',
              toolCallId: 'tool-1',
            },
            {
              rawOutput: { output: VAULT_PATH },
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              toolCallId: 'tool-1',
            },
            { sessionUpdate: 'usage_update', size: 200_000, used: 12 },
          ];
          for (const update of updates) {
            process.notify('session/update', { sessionId: 'session-new', update });
          }
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({ content: 'thinking', type: 'thinking' });
    expect(chunks).toContainEqual(expect.objectContaining({
      id: 'tool-1', name: 'Bash', type: 'tool_use',
    }));
    expect(chunks).toContainEqual(expect.objectContaining({ id: 'tool-1', type: 'tool_result' }));
    expect(chunks.filter(chunk => record(chunk).type === 'usage').at(-1)).toEqual(
      expect.objectContaining({
        type: 'usage',
        usage: expect.objectContaining({ contextTokens: 6, inputTokens: 4 }),
      }),
    );
  });

  it('refines a live generic tool name when a recognized raw title arrives later', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawInput: { command: 'pwd' },
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              toolCallId: 'tool-refined',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              sessionUpdate: 'tool_call_update',
              status: 'in_progress',
              title: 'run_terminal_command',
              toolCallId: 'tool-refined',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              content: [{ content: { text: 'Command completed', type: 'text' }, type: 'content' }],
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              toolCallId: 'tool-refined',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);
    const toolUses = chunks.filter(chunk => (
      record(chunk).type === 'tool_use' && record(chunk).id === 'tool-refined'
    ));

    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({
      input: { command: 'pwd' },
      name: 'tool',
      providerPayload: { rawInput: { command: 'pwd' }, rawName: 'tool' },
      type: 'tool_use',
    });
    expect(toolUses[1]).toMatchObject({
      input: { command: 'pwd' },
      name: 'Bash',
      providerPayload: {
        rawInput: { command: 'pwd' },
        rawName: 'run_terminal_command',
      },
      type: 'tool_use',
    });
    expect(chunks).toContainEqual(expect.objectContaining({
      content: 'Command completed',
      id: 'tool-refined',
      type: 'tool_result',
    }));
  });

  it('refines a live kind fallback to an unknown late raw title losslessly', async () => {
    const rawInput = { opaque: ['future'] };
    const rawOutput = { future: { bytes: [1, 2, 3] } };
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              kind: 'execute',
              rawInput,
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              toolCallId: 'tool-future-title',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawOutput,
              sessionUpdate: 'tool_call_update',
              status: 'in_progress',
              title: 'future_tool',
              toolCallId: 'tool-future-title',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              content: [{ content: { text: 'Concise future result', type: 'text' }, type: 'content' }],
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              toolCallId: 'tool-future-title',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);
    const toolUses = chunks.filter(chunk => (
      record(chunk).type === 'tool_use' && record(chunk).id === 'tool-future-title'
    ));
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({
      input: rawInput,
      name: 'execute',
      providerPayload: { rawInput, rawName: 'execute' },
      type: 'tool_use',
    });
    expect(toolUses[1]).toMatchObject({
      input: rawInput,
      name: 'future_tool',
      providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
      type: 'tool_use',
    });
    expect(chunks).toContainEqual(expect.objectContaining({
      content: 'Concise future result',
      id: 'tool-future-title',
      toolUseResult: {
        providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
      },
      type: 'tool_result',
    }));
  });

  it('suppresses only adjacent standard and extension mirrors for text and tools', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          const notify = (method: string, update: Record<string, unknown>): void => {
            process.notify(method, { sessionId: 'session-new', update });
          };
          const text = (content: string) => ({
            content: { text: content, type: 'text' },
            messageId: `assistant-${content}`,
            sessionUpdate: 'agent_message_chunk',
          });
          const mirroredText = text('[A]');
          notify('session/update', mirroredText);
          notify('_x.ai/session/update', mirroredText);
          notify('session/update', text('[R]'));
          notify('session/update', text('[R]'));
          notify('session/update', text('[X]'));
          notify('_x.ai/session/update', { sessionUpdate: 'future_intervening_update' });
          notify('_x.ai/session/update', text('[X]'));
          notify('session/update', mirroredText);

          const toolCall = {
            rawInput: { path: 'note.md' },
            sessionUpdate: 'tool_call',
            status: 'in_progress',
            title: 'read_file',
            toolCallId: 'tool-mirror',
          };
          const toolResult = {
            rawOutput: { content: 'sanitized' },
            sessionUpdate: 'tool_call_update',
            status: 'completed',
            toolCallId: 'tool-mirror',
          };
          notify('session/update', toolCall);
          notify('_x.ai/session/update', toolCall);
          notify('session/update', toolResult);
          notify('_x.ai/session/update', toolResult);
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);
    expect(chunks.filter(chunk => record(chunk).type === 'text').map(chunk => record(chunk).content))
      .toEqual(['[A]', '[R]', '[R]', '[X]', '[X]', '[A]']);
    const toolUses = chunks.filter(chunk => (
      record(chunk).type === 'tool_use' && record(chunk).id === 'tool-mirror'
    ));
    expect(toolUses).toHaveLength(2);
    expect(new Set(toolUses.map(chunk => record(chunk).id))).toEqual(new Set(['tool-mirror']));
    expect(chunks.filter(chunk => (
      record(chunk).type === 'tool_result' && record(chunk).id === 'tool-mirror'
    ))).toHaveLength(1);
  });

  it('preserves unknown raw tool payloads without replacing concise live content', async () => {
    const rawInput = ['opaque', { nested: true }];
    const rawOutput = { future: { bytes: [1, 2, 3] } };
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawInput,
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              title: 'future_tool',
              toolCallId: 'tool-future',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              content: [{
                content: { text: 'Concise result', type: 'text' },
                type: 'content',
              }],
              rawInput,
              rawOutput,
              sessionUpdate: 'tool_call_update',
              status: 'in_progress',
              toolCallId: 'tool-future',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              toolCallId: 'tool-future',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);
    const toolUse = chunks.find(chunk => record(chunk).type === 'tool_use');
    const toolResult = chunks.find(chunk => record(chunk).type === 'tool_result');

    expect(toolUse).toMatchObject({
      id: 'tool-future',
      input: {},
      name: 'future_tool',
      providerPayload: {
        rawInput,
        rawName: 'future_tool',
      },
      type: 'tool_use',
    });
    expect(toolResult).toMatchObject({
      content: 'Concise result',
      id: 'tool-future',
      type: 'tool_result',
      toolUseResult: {
        providerPayload: {
          rawInput,
          rawName: 'future_tool',
          rawOutput,
        },
      },
    });
    expect(record(toolResult).content).not.toContain('bytes');
  });

  it('preserves an incomplete live tool payload when the process exits before tool_result', async () => {
    const rawInput = ['opaque', { nested: true }];
    const rawOutput = { partial: { bytes: [1, 2, 3] } };
    const harness = createHarness({
      handlers: {
        async prompt(_message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawInput,
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              title: 'future_tool',
              toolCallId: 'tool-incomplete',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawOutput,
              sessionUpdate: 'tool_call_update',
              status: 'in_progress',
              toolCallId: 'tool-incomplete',
            },
          });
          await tick();
          process.close(new Error('process exited before tool completion'));
        },
      },
    });

    const chunks = await collect(harness.runtime);
    const toolUses = chunks.filter(chunk => record(chunk).type === 'tool_use');
    expect(toolUses.at(-1)).toMatchObject({
      id: 'tool-incomplete',
      input: {},
      name: 'future_tool',
      providerPayload: { rawInput, rawName: 'future_tool', rawOutput },
      type: 'tool_use',
    });
    expect(chunks).not.toContainEqual(expect.objectContaining({
      id: 'tool-incomplete',
      type: 'tool_result',
    }));

    const savedConversation = JSON.parse(JSON.stringify({
      messages: [{
        role: 'assistant',
        toolCalls: toolUses.map(chunk => ({
          id: record(chunk).id,
          input: record(chunk).input,
          name: record(chunk).name,
          providerPayload: record(chunk).providerPayload,
          status: 'running',
        })),
      }],
      providerId: 'grok',
    }));
    expect(savedConversation.messages[0].toolCalls.at(-1).providerPayload).toEqual({
      rawInput,
      rawName: 'future_tool',
      rawOutput,
    });
  });

  it('emits usage from the installed Grok turn_completed runtime fixture', async () => {
    const fixture = record(JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'tests/fixtures/providers/grok/runtime/turn-completed.json',
    ), 'utf8')));
    const wrapper = record(fixture.params);
    const params = record(wrapper.params);
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify(String(fixture.method), {
            method: 'x.ai/other_extension',
            params: {
              sessionId: 'session-new',
              update: {
                sessionUpdate: 'turn_completed',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            },
          });
          process.notify(String(fixture.method), {
            ...wrapper,
            params: {
              ...params,
              sessionId: 'session-new',
            },
          });
          process.respond(message, {
            stopReason: 'end_turn',
            userMessageId: 'user-live',
          });
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({
      sessionId: 'session-new',
      type: 'usage',
      usage: expect.objectContaining({
        cacheReadInputTokens: 1280,
        contextTokens: 10377,
        inputTokens: 10327,
      }),
    });
    expect(chunks).not.toContainEqual(expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 1 }),
    }));
  });

  it('emits usage from installed Grok prompt response metadata', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.respond(message, {
            _meta: {
              cachedReadTokens: 4,
              inputTokens: 12,
              outputTokens: 3,
              reasoningTokens: 2,
              totalTokens: 15,
            },
            stopReason: 'end_turn',
          });
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({
      sessionId: 'session-new',
      type: 'usage',
      usage: expect.objectContaining({
        cacheReadInputTokens: 4,
        contextTokens: 15,
        inputTokens: 12,
      }),
    });
  });

  it('routes defensive permissions and xAI question/plan/yolo extensions through turn-owned UI', async () => {
    const approval = jest.fn().mockResolvedValue('allow');
    const ask = jest.fn().mockResolvedValue({ 'Choose?': 'Yes' });
    const notice = jest.fn();
    const modeSync = jest.fn();
    const extensionResults: unknown[] = [];
    const harness = createHarness({
      handlers: {
        async prompt(message, process) {
          extensionResults.push(await process.request('_x.ai/ask_user_question', {
            mode: 'default',
            questions: [{ options: [{ label: 'Yes' }], question: 'Choose?' }],
            sessionId: 'session-new',
            toolCallId: 'question-1',
          }));
          extensionResults.push(await process.request('_x.ai/exit_plan_mode', {
            planContent: 'sanitized',
            sessionId: 'session-new',
            toolCallId: 'plan-1',
          }));
          extensionResults.push(await process.request('session/request_permission', {
            options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' }],
            sessionId: 'session-new',
            toolCall: { rawInput: { command: 'pwd' }, title: 'run_terminal_command', toolCallId: 'tool-1' },
          }));
          process.notify('_x.ai/yolo_mode_changed', { yolo_mode: true });
          process.respond(message, promptResponse());
        },
      },
    });
    harness.runtime.setApprovalCallback(approval);
    harness.runtime.setAskUserQuestionCallback(ask);
    harness.runtime.setPermissionModeSyncCallback(modeSync);
    harness.runtime.setUnsupportedPlanModeNoticeCallback(notice);

    await collect(harness.runtime);

    expect(extensionResults).toEqual([
      { answers: { 'Choose?': ['Yes'] }, outcome: 'accepted' },
      { outcome: 'abandoned' },
      { outcome: { optionId: 'allow-now', outcome: 'selected' } },
    ]);
    expect(approval).toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
    expect(notice).toHaveBeenCalled();
    expect(modeSync).toHaveBeenCalledWith('yolo');
  });

  it('cancels once, aborts and dismisses pending UI, and settles without provider acknowledgement', async () => {
    const dismisser = jest.fn();
    const approval = jest.fn(() => new Promise<never>(() => {}));
    let permissionResult: unknown;
    const harness = createHarness({
      handlers: {
        async prompt(_message, process) {
          permissionResult = await process.request('session/request_permission', {
            options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' }],
            sessionId: 'session-new',
            toolCall: { rawInput: {}, title: 'read_file', toolCallId: 'tool-pending' },
          });
        },
      },
    });
    harness.runtime.setApprovalCallback(approval);
    harness.runtime.setApprovalDismisser(dismisser);
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    while (approval.mock.calls.length === 0) await tick();

    harness.runtime.cancel();
    harness.runtime.cancel();

    await expect(first).resolves.toEqual({ done: false, value: { type: 'done' } });
    expect(harness.process.requests.filter(request => request.method === 'session/cancel')).toHaveLength(1);
    await tick();
    expect(permissionResult).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(dismisser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['readiness', 'initialize'],
    ['session creation', 'session/new'],
    ['session load', 'session/load'],
    ['model selection', 'session/set_model'],
  ])('latches cancellation during %s before any prompt can start', async (phase, method) => {
    let blocked = false;
    const respondInitialize = (message: JsonRpcMessage, process: FakeGrokProcess) => {
      process.respond(message, {
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        agentInfo: { name: 'grok', version: '0.2.106' },
        authMethods: [{ id: 'grok-login', type: 'agent' }],
        protocolVersion: 1,
      });
    };
    const shouldBlock = (candidate: string): boolean => {
      if (method !== candidate || blocked) return false;
      blocked = true;
      return true;
    };
    const harness = createHarness({
      handlers: {
        initialize(message, process) {
          if (!shouldBlock('initialize')) respondInitialize(message, process);
        },
        load(message, process) {
          if (!shouldBlock('session/load')) {
            process.respond(message, sessionResponse(String(record(message.params).sessionId)));
          }
        },
        newSession(message, process) {
          if (!shouldBlock('session/new')) process.respond(message, sessionResponse('session-new'));
        },
        prompt(message, process) {
          process.respond(message, promptResponse());
        },
        setModel(message, process) {
          if (!shouldBlock('session/set_model')) process.respond(message, { _meta: {} });
        },
      },
    });
    if (phase === 'session load') {
      harness.runtime.syncConversationState({
        id: 'conversation-load',
        providerState: {},
        sessionId: 'session-saved',
      });
    }
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Cancel early' }));
    const first = iterator.next();
    while (harness.processes.length === 0) await tick();
    await waitForRequest(harness.process, method);

    harness.runtime.cancel();
    harness.runtime.cancel();
    const followUp = collect(harness.runtime, 'Follow up');

    await expect(first).resolves.toEqual({ done: false, value: { type: 'done' } });
    await expect(followUp).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'usage' }),
      { type: 'done' },
    ]));
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes[0].requests.filter(request => request.method === 'session/prompt'))
      .toHaveLength(0);
    expect(harness.processes[0].requests.filter(request => request.method === 'session/cancel'))
      .toHaveLength(0);
    expect(harness.processes[1].requests.filter(request => request.method === 'session/prompt'))
      .toHaveLength(1);
  });

  it.each([
    ['after the first chunk', true],
    ['while the first prompt chunk is pending', false],
  ])('recycles the native turn when the iterator closes %s', async (_case, emitChunk) => {
    let firstPrompt = true;
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          if (firstPrompt) {
            firstPrompt = false;
            if (emitChunk) {
              process.notify('_x.ai/session/update', {
                sessionId: 'session-new',
                update: {
                  content: { text: 'partial old turn', type: 'text' },
                  messageId: 'old-partial',
                  sessionUpdate: 'agent_message_chunk',
                },
              });
            }
            return;
          }
          process.notify('_x.ai/session/update', {
            sessionId: 'session-new',
            update: {
              content: { text: 'fresh follow-up', type: 'text' },
              messageId: 'fresh-follow-up',
              sessionUpdate: 'agent_message_chunk',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Close early' }));
    const pendingChunk = iterator.next();
    while (harness.processes.length === 0) await tick();
    await waitForRequest(harness.process, 'session/prompt');
    let firstChunk: IteratorResult<unknown> | undefined;
    if (emitChunk) {
      firstChunk = await pendingChunk;
    }

    const closed = iterator.return(undefined);
    const followUp = collect(harness.runtime, 'Follow up');

    if (!emitChunk) {
      firstChunk = await pendingChunk;
    }
    expect(firstChunk).toEqual(emitChunk
      ? { done: false, value: { itemId: 'old-partial', type: 'assistant_message_start' } }
      : { done: false, value: { type: 'done' } });
    await expect(closed).resolves.toEqual({ done: true, value: undefined });
    await expect(followUp).resolves.toEqual(expect.arrayContaining([
      { content: 'fresh follow-up', type: 'text' },
      { type: 'done' },
    ]));
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes[0].requests.filter(request => request.method === 'session/cancel'))
      .toHaveLength(1);
    expect(harness.processes[0].shutdownCalls).toBe(1);
    expect(harness.processes[1].requests.map(request => request.method)).toEqual([
      'initialize',
      'session/load',
      'session/set_model',
      'session/prompt',
    ]);
  });

  it('recycles a cancelled turn before an immediate follow-up and quarantines late traffic', async () => {
    const approval = jest.fn().mockResolvedValue('allow');
    let cancelledProcess: FakeGrokProcess | null = null;
    const sendLateTraffic = (process: FakeGrokProcess, suffix: string) => {
      process.notify('_x.ai/session/update', {
        sessionId: 'session-new',
        update: {
          content: { text: `late old turn ${suffix}`, type: 'text' },
          messageId: `late-${suffix}`,
          sessionUpdate: 'agent_message_chunk',
        },
      });
      void process.request('session/request_permission', {
        options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'late-allow' }],
        sessionId: 'session-new',
        toolCall: { rawInput: {}, title: 'read_file', toolCallId: `late-${suffix}` },
      });
    };
    const harness = createHarness({
      handlers: {
        cancel(_message, process) {
          sendLateTraffic(process, 'during-cancel');
        },
        prompt(message, process) {
          if (!cancelledProcess) {
            cancelledProcess = process;
            return;
          }
          sendLateTraffic(cancelledProcess, 'after-follow-up-start');
          process.notify('_x.ai/session/update', {
            sessionId: 'session-new',
            update: {
              content: { text: 'fresh follow-up', type: 'text' },
              messageId: 'fresh-follow-up',
              sessionUpdate: 'agent_message_chunk',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });
    harness.runtime.setApprovalCallback(approval);
    const first = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const firstChunk = first.next();
    while (!cancelledProcess) await tick();

    harness.runtime.cancel();
    const followUp = collect(harness.runtime, 'Follow up');

    await expect(firstChunk).resolves.toEqual({ done: false, value: { type: 'done' } });
    await expect(followUp).resolves.toEqual(expect.arrayContaining([
      { content: 'fresh follow-up', type: 'text' },
      { type: 'done' },
    ]));
    const followUpChunks = await followUp;
    expect(followUpChunks).not.toContainEqual(expect.objectContaining({
      content: expect.stringContaining('late old turn'),
    }));
    expect(approval).not.toHaveBeenCalled();
    expect(harness.runtime.getSessionId()).toBe('session-new');
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes[0].requests.filter(request => request.method === 'session/cancel'))
      .toHaveLength(1);
    expect(harness.processes[1].requests.map(request => request.method)).toEqual([
      'initialize',
      'session/load',
      'session/set_model',
      'session/prompt',
    ]);
  });

  it('forces recycle when cancel delivery remains backpressured', async () => {
    let firstPrompt = true;
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          if (firstPrompt) {
            firstPrompt = false;
            return;
          }
          process.respond(message, promptResponse());
        },
      },
    });
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    while (
      harness.processes.length === 0
      || harness.process.requests.filter(request => request.method === 'session/prompt').length === 0
    ) {
      await tick();
    }

    harness.process.stdin.write = jest.fn(() => false) as unknown as typeof harness.process.stdin.write;
    harness.runtime.cancel();
    const followUp = collect(harness.runtime, 'Follow up');
    const outcome = await Promise.race([
      followUp,
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 1_000)),
    ]);

    await expect(first).resolves.toEqual({ done: false, value: { type: 'done' } });
    expect(outcome).not.toBe('timed-out');
    expect(outcome).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'usage' }),
      { type: 'done' },
    ]));
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes[0].shutdownCalls).toBe(1);
  });

  it('cancels the old native turn and pending UI when the bound conversation changes', async () => {
    const dismisser = jest.fn();
    const approval = jest.fn(() => new Promise<never>(() => {}));
    let permissionResult: unknown;
    const harness = createHarness({
      handlers: {
        async prompt(_message, process) {
          permissionResult = await process.request('session/request_permission', {
            options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' }],
            sessionId: 'session-new',
            toolCall: { rawInput: {}, title: 'read_file', toolCallId: 'tool-pending' },
          });
        },
      },
    });
    harness.runtime.setApprovalCallback(approval);
    harness.runtime.setApprovalDismisser(dismisser);
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    while (approval.mock.calls.length === 0) await tick();

    harness.runtime.syncConversationState({
      id: 'other-conversation',
      providerState: {},
      sessionId: 'saved-other',
    });

    await expect(first).resolves.toEqual({ done: false, value: { type: 'done' } });
    expect(harness.process.requests.filter(request => request.method === 'session/cancel'))
      .toEqual([
        expect.objectContaining({ params: { sessionId: 'session-new' } }),
      ]);
    await tick();
    expect(permissionResult).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(dismisser).toHaveBeenCalledTimes(1);
    harness.runtime.cleanup();
  });

  it('settles process death, includes redacted actionable diagnostics, and cleans up only once', async () => {
    const harness = createHarness({ handlers: { prompt() {} } });
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    await tick();

    harness.process.close(new Error('authentication token expired'));

    await expect(first).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ content: expect.stringMatching(/grok login/i), type: 'error' }),
    });
    harness.runtime.cleanup();
    harness.runtime.cleanup();
    await tick();
    expect(harness.process.shutdownCalls).toBe(1);
  });

  it('classifies API-key authentication failures as BYOK configuration errors', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.stdout.write(`${JSON.stringify({
            error: { code: -32000, message: 'authentication failed: invalid API key' },
            id: message.id,
            jsonrpc: '2.0',
          })}\n`);
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual(expect.objectContaining({
      content: expect.stringMatching(/env_key/i),
      type: 'error',
    }));
    expect(chunks).not.toContainEqual(expect.objectContaining({
      content: expect.stringMatching(/grok login/i),
    }));
  });

  it.each([
    ['key-value', 'request failed: token=key-value-secret'],
    ['query', 'request failed: https://example.test?password=query-secret&model=custom'],
    ['JSON', 'request failed: {"Secret":"json-secret","model":"custom"}'],
    ['case-insensitive', 'request failed: RUNTIME_TOKEN=case-secret'],
  ])('redacts %s credential assignments from provider errors', async (_case, message) => {
    const secret = message.match(/(?:=|:")([^&"}]+)(?:[&"}]|$)/)?.[1];
    expect(secret).toBeDefined();
    const harness = createHarness({
      handlers: {
        prompt(request, process) {
          process.stdout.write(`${JSON.stringify({
            error: { code: -32000, message },
            id: request.id,
            jsonrpc: '2.0',
          })}\n`);
        },
      },
    });

    const chunks = await collect(harness.runtime);
    const errorContent = String(record(chunks.find(chunk => record(chunk).type === 'error')).content);

    expect(errorContent).toContain('<redacted>');
    expect(errorContent).not.toContain(secret);
  });

  it('preserves provider state, adds only a validated directory hint, and returns unsupported operations', async () => {
    const harness = createHarness({ sessionDirectory: '/trusted/sessions/session-new' });
    await harness.runtime.ensureReady();

    expect(harness.runtime.buildSessionUpdates({
      conversation: {
        providerId: 'grok',
        providerState: { futureField: 'keep', sessionDirectory: '/untrusted/session-new' },
        sessionId: null,
      } as never,
      sessionInvalidated: false,
    })).toEqual({
      updates: {
        providerState: {
          futureField: 'keep',
          sessionDirectory: '/trusted/sessions/session-new',
        },
        sessionId: 'session-new',
      },
    });
    await expect(harness.runtime.rewind('user', 'assistant')).resolves.toEqual({ canRewind: false });
    await expect(harness.runtime.steer?.(harness.runtime.prepareTurn({ text: 'No' }))).resolves.toBe(false);
    expect(harness.runtime.resolveSessionIdForFork(null)).toBeNull();
  });
});
