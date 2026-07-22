import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCapabilities } from '@/core/providers/types';
import type { AcpSubprocessLaunchSpec } from '@/providers/acp';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { encodeGrokSessionCwd } from '@/providers/grok/history/GrokHistoryPathResolver';
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
  supportsFork: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: true,
  supportsProviderCommands: true,
  supportsRewind: true,
  supportsTurnSteer: true,
};

type JsonRpcMessage = Record<string, unknown> & { id?: number; method?: string };

class FakeGrokProcess implements GrokRuntimeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: JsonRpcMessage[] = [];
  shutdownCalls = 0;
  stderrSnapshot = '';
  private alive = false;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private nextServerRequestId = 10_000;
  private readonly responseWaiters = new Map<number, (result: unknown) => void>();

  constructor(
    readonly launchSpec: AcpSubprocessLaunchSpec,
    private readonly handlers: {
      cancel?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      commandsList?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      initialize?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      interject?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      load?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      newSession?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      prompt?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      rewindExecute?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      sessionFork?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
      setMode?: (message: JsonRpcMessage, process: FakeGrokProcess) => void;
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
    return this.stderrSnapshot;
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

  respondError(message: JsonRpcMessage, errorMessage: string): void {
    this.send({
      error: { code: -32603, message: errorMessage },
      id: message.id,
      jsonrpc: '2.0',
    });
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
      case '_x.ai/commands/list':
        if (this.handlers.commandsList) this.handlers.commandsList(message, this);
        else this.respond(message, { commands: [] });
        return;
      case '_x.ai/interject':
        if (this.handlers.interject) this.handlers.interject(message, this);
        else this.respond(message, { result: { status: 'queued' } });
        return;
      case '_x.ai/session/fork':
        if (this.handlers.sessionFork) this.handlers.sessionFork(message, this);
        else this.respond(message, {
          chatMessagesCopied: 2,
          newCwd: VAULT_PATH,
          newSessionId: 'session-forked',
          parentSessionId: 'session-new',
          planStateCopied: false,
          updatesCopied: 2,
        });
        return;
      case '_x.ai/rewind/execute':
        if (this.handlers.rewindExecute) this.handlers.rewindExecute(message, this);
        else this.respond(message, {
          clean_files: [],
          conflicts: [],
          error: null,
          mode: record(message.params).mode,
          prompt_text: null,
          reverted_files: [],
          success: record(message.params).force === true,
          target_prompt_index: record(message.params).targetPromptIndex,
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
      case 'session/set_mode':
        if (this.handlers.setMode) this.handlers.setMode(message, this);
        else this.respond(message, {});
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
  host: ProviderHost;
  liveModels: jest.Mock;
  process: FakeGrokProcess;
  processes: FakeGrokProcess[];
  runtime: GrokChatRuntime;
} {
  const host = params.host ?? createHost();
  const liveModels = jest.fn().mockResolvedValue({ changed: false });
  const processes: FakeGrokProcess[] = [];
  let process!: FakeGrokProcess;
  const runtime = new GrokChatRuntime(host, {
    capabilities: CAPABILITIES,
    cliResolver: { resolveFromSettings: () => '/opt/grok/bin/grok' },
    lifecycle: params.lifecycle,
    modelCatalogCoordinator: { mergeLiveModels: liveModels },
    processFactory: (launchSpec) => {
      process = new FakeGrokProcess(launchSpec, params.handlers);
      processes.push(process);
      return process;
    },
    resolveSessionDirectory: () => params.sessionDirectory ?? null,
  });
  return { host, liveModels, get process() { return process; }, processes, runtime };
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

function createRewindHistoryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-grok-runtime-rewind-'));
  const records = [{
    _meta: { promptIndex: 0 },
    content: { text: 'First prompt', type: 'text' },
    messageId: 'user-first',
    sessionUpdate: 'user_message_chunk',
  }, {
    content: { text: 'First answer', type: 'text' },
    messageId: 'assistant-first',
    sessionUpdate: 'agent_message_chunk',
  }, {
    prompt_id: 'assistant-first',
    sessionUpdate: 'turn_completed',
  }].map((update, index) => JSON.stringify({
    method: '_x.ai/session/update',
    params: { sessionId: 'session-existing', update },
    timestamp: 1_000 + index,
  })).join('\n');
  fs.writeFileSync(path.join(directory, 'updates.jsonl'), records, 'utf8');
  return directory;
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

  it('lists exact provider commands before a session without sending a prompt', async () => {
    const harness = createHarness({
      handlers: {
        commandsList(message, process) {
          process.respond(message, {
            commands: [{
              description: 'Run the shared skill',
              input: { hint: '[request]' },
              name: '/repo:shared-review',
            }],
          });
        },
      },
    });

    await expect(harness.runtime.discoverSupportedCommands()).resolves.toEqual([{
      argumentHint: '[request]',
      content: '',
      description: 'Run the shared skill',
      id: 'acp:repo:shared-review',
      name: 'repo:shared-review',
      source: 'sdk',
    }]);

    expect(harness.process.requests.map(request => request.method)).toEqual([
      'initialize',
      '_x.ai/commands/list',
    ]);
    expect(record(harness.process.requests[1]?.params)).toEqual({ cwd: VAULT_PATH });
    expect(harness.process.requests.some(request => request.method === 'session/new')).toBe(false);
    expect(harness.process.requests.some(request => request.method === 'session/load')).toBe(false);
    expect(harness.process.requests.some(request => request.method === 'session/prompt')).toBe(false);
  });

  it('discovers commands for a pending fork without materializing a child session', async () => {
    const harness = createHarness({
      handlers: {
        commandsList(message, process) {
          process.respond(message, { commands: [] });
        },
      },
      sessionDirectory: '/trusted/source-session',
    });
    harness.runtime.syncConversationState({
      id: 'conversation-pending-fork',
      providerState: {
        forkSource: { resumeAt: 'assistant-1', sessionId: 'source-session' },
        forkSourceSessionDirectory: '/trusted/source-session',
      },
      selectedModel: 'grok/grok-4.5',
      sessionId: null,
    });

    await expect(harness.runtime.discoverSupportedCommands()).resolves.toEqual([]);
    expect(harness.process.requests.map(request => request.method)).toEqual([
      'initialize',
      '_x.ai/commands/list',
    ]);
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

  it('starts a cold plan session with the remembered YOLO base and sets native plan mode before prompting', async () => {
    const host = createHost({
      settings: {
        permissionMode: 'plan',
        providerConfigs: {
          grok: {
            enabled: true,
            planBasePermissionMode: 'yolo',
          },
        },
      },
    });
    const harness = createHarness({ host });

    await collect(harness.runtime);

    const created = harness.process.requests.find(request => request.method === 'session/new');
    expect(record(created?.params)._meta).toEqual(expect.objectContaining({ yoloMode: true }));
    const methods = harness.process.requests.map(request => request.method);
    expect(methods.indexOf('session/set_mode')).toBeGreaterThan(methods.indexOf('session/new'));
    expect(methods.indexOf('session/set_mode')).toBeLessThan(methods.indexOf('session/prompt'));
    expect(harness.process.requests.find(request => request.method === 'session/set_mode')?.params)
      .toEqual({ modeId: 'plan', sessionId: 'session-new' });
  });

  it('sets native session mode immediately and accepts authoritative mode updates while idle', async () => {
    const modeSync = jest.fn();
    const harness = createHarness({
      handlers: {
        setMode(message, process) {
          process.respond(message, {});
          process.notify('session/update', {
            sessionId: 'session-new',
            update: { currentModeId: record(message.params).modeId, sessionUpdate: 'current_mode_update' },
          });
        },
      },
    });
    harness.runtime.setPermissionModeSyncCallback(modeSync);
    await harness.runtime.ensureReady();

    await expect(harness.runtime.setSessionMode('plan')).resolves.toBe(true);
    await tick();

    expect(harness.process.requests.find(request => request.method === 'session/set_mode')?.params)
      .toEqual({ modeId: 'plan', sessionId: 'session-new' });
    expect(modeSync).toHaveBeenCalledWith('plan');
  });

  it('defers a mode transition requested before session creation and applies it before the prompt', async () => {
    const harness = createHarness();

    await expect(harness.runtime.setSessionMode('plan')).resolves.toBe(false);
    await collect(harness.runtime);

    const methods = harness.process.requests.map(request => request.method);
    expect(methods.indexOf('session/set_mode')).toBeGreaterThan(methods.indexOf('session/new'));
    expect(methods.indexOf('session/set_mode')).toBeLessThan(methods.indexOf('session/prompt'));
    expect(harness.process.requests.find(request => request.method === 'session/set_mode')?.params)
      .toEqual({ modeId: 'plan', sessionId: 'session-new' });
  });

  it('keeps Plan over yolo notifications and restores the remembered base on native exit', async () => {
    const host = createHost({
      settings: {
        permissionMode: 'plan',
        providerConfigs: {
          grok: { enabled: true, planBasePermissionMode: 'yolo' },
        },
      },
    });
    const harness = createHarness({ host });
    const modeSync = jest.fn();
    harness.runtime.setPermissionModeSyncCallback(modeSync);
    await harness.runtime.ensureReady();

    harness.process.notify('session/update', {
      sessionId: 'session-new',
      update: { currentModeId: 'plan', sessionUpdate: 'current_mode_update' },
    });
    harness.process.notify('_x.ai/yolo_mode_changed', { yolo_mode: false });
    harness.process.notify('session/update', {
      sessionId: 'session-new',
      update: { currentModeId: 'default', sessionUpdate: 'current_mode_update' },
    });
    await tick();

    expect(modeSync.mock.calls).toEqual([['plan'], ['yolo']]);
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

  it('sends text and image ACP blocks for normal and image-only turns', async () => {
    const harness = createHarness();
    const image = {
      data: 'aGVsbG8=',
      id: 'image-1',
      mediaType: 'image/png' as const,
      name: 'sample.png',
      size: 5,
      source: 'paste' as const,
    };

    for await (const chunk of harness.runtime.query(harness.runtime.prepareTurn({
      images: [image],
      text: '',
    }))) {
      void chunk;
    }

    const prompt = harness.process.requests.find(request => request.method === 'session/prompt');
    expect(record(prompt?.params)).toEqual({
      prompt: [
        { text: '', type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
      ],
      sessionId: 'session-new',
    });
  });

  it('steers the active Grok turn through xAI interject with shared prompt blocks', async () => {
    const harness = createHarness({
      handlers: {
        interject(message, process) {
          process.notify('x.ai/session/interjection', message.params);
          process.respond(message, { result: { status: 'queued' } });
        },
        prompt() {},
      },
    });
    const query = collect(harness.runtime, 'Initial prompt');
    while (harness.processes.length === 0) await tick();
    const promptRequest = await waitForRequest(harness.process, 'session/prompt');
    const steerTurn = harness.runtime.prepareTurn({
      images: [{
        data: 'aGVsbG8=',
        id: 'image-steer',
        mediaType: 'image/webp',
        name: 'steer.webp',
        size: 5,
        source: 'drop',
      }],
      text: 'Focus on this instead.',
    });

    await expect(harness.runtime.steer(steerTurn)).resolves.toBe(true);

    const interject = harness.process.requests.find(request => request.method === '_x.ai/interject');
    expect(record(interject?.params)).toEqual({
      content: [
        { text: 'Focus on this instead.', type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/webp', type: 'image' },
      ],
      interjectionId: expect.any(String),
      sessionId: 'session-new',
      text: 'Focus on this instead.',
    });

    harness.process.notify('_x.ai/session/update', {
      sessionId: 'session-new',
      update: { sessionUpdate: 'turn_completed' },
    });
    harness.process.respond(promptRequest, promptResponse());
    await expect(query).resolves.toContainEqual({
      content: 'Focus on this instead.',
      type: 'user_message_start',
    });
  });

  it('keeps text-only Grok interjections on the legacy wire shape', async () => {
    const harness = createHarness({
      handlers: {
        interject(message, process) {
          process.notify('x.ai/session/interjection', message.params);
          process.respond(message, { result: { status: 'queued' } });
        },
        prompt() {},
      },
    });
    const query = collect(harness.runtime, 'Initial prompt');
    while (harness.processes.length === 0) await tick();
    const promptRequest = await waitForRequest(harness.process, 'session/prompt');

    await expect(harness.runtime.steer(
      harness.runtime.prepareTurn({ text: 'Text-only steer' }),
    )).resolves.toBe(true);

    expect(record(harness.process.requests.find(
      request => request.method === '_x.ai/interject',
    )?.params)).toEqual({
      interjectionId: expect.any(String),
      sessionId: 'session-new',
      text: 'Text-only steer',
    });
    harness.process.notify('_x.ai/session/update', {
      sessionId: 'session-new',
      update: { sessionUpdate: 'turn_completed' },
    });
    harness.process.respond(promptRequest, promptResponse());
    await query;
  });

  it('keeps the stream open for a late interjection fallback turn', async () => {
    const harness = createHarness({
      handlers: {
        interject() {},
        prompt() {},
      },
    });
    const query = collect(harness.runtime, 'Initial prompt');
    while (harness.processes.length === 0) await tick();
    const promptRequest = await waitForRequest(harness.process, 'session/prompt');
    const steering = harness.runtime.steer(
      harness.runtime.prepareTurn({ text: 'Late steer' }),
    );
    const interjectRequest = await waitForRequest(harness.process, '_x.ai/interject');

    harness.process.notify('_x.ai/session/update', {
      sessionId: 'session-new',
      update: { sessionUpdate: 'turn_completed' },
    });
    harness.process.respond(promptRequest, promptResponse());
    await tick();
    harness.process.notify('x.ai/session/interjection', interjectRequest.params);
    harness.process.respond(interjectRequest, { result: { status: 'queued' } });
    await expect(steering).resolves.toBe(true);
    harness.process.notify('_x.ai/session/update', {
      sessionId: 'session-new',
      update: {
        content: { text: 'Fallback response', type: 'text' },
        messageId: 'assistant-fallback',
        sessionUpdate: 'agent_message_chunk',
      },
    });
    harness.process.notify('_x.ai/session/update', {
      sessionId: 'session-new',
      update: { prompt_id: 'interject-fallback-1', sessionUpdate: 'turn_completed' },
    });

    await expect(query).resolves.toEqual(expect.arrayContaining([
      { content: 'Late steer', type: 'user_message_start' },
      { content: 'Fallback response', type: 'text' },
      { type: 'done' },
    ]));
  });

  it('rejects an interjection response that crosses the conversation generation', async () => {
    const harness = createHarness({
      handlers: {
        interject() {},
        prompt() {},
      },
    });
    const query = collect(harness.runtime, 'Initial prompt');
    while (harness.processes.length === 0) await tick();
    await waitForRequest(harness.process, 'session/prompt');

    const steering = harness.runtime.steer(
      harness.runtime.prepareTurn({ text: 'Stale steer' }),
    );
    await waitForRequest(harness.process, '_x.ai/interject');
    harness.runtime.syncConversationState({
      id: 'conversation-replacement',
      providerState: {},
      sessionId: 'replacement-session',
    });

    await expect(steering).resolves.toBe(false);
    await expect(query).resolves.toContainEqual({ type: 'done' });
    expect(harness.runtime.getSessionId()).toBe('replacement-session');
  });

  it('materializes a pending Grok fork before loading and prompting the child session', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-grok-fork-'));
    const sourceCwd = path.join(tempRoot, 'previous-vault');
    const sourceDirectory = path.join(
      tempRoot,
      'sessions',
      encodeGrokSessionCwd(sourceCwd),
      'session-fixture',
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl'),
      path.join(sourceDirectory, 'updates.jsonl'),
    );
    const harness = createHarness({
      handlers: {
        sessionFork(message, process) {
          process.respond(message, {
            chatMessagesCopied: 2,
            newCwd: VAULT_PATH,
            newModelId: 'grok-4.5',
            newSessionId: 'session-forked',
            parentSessionId: 'session-fixture',
            planStateCopied: false,
            updatesCopied: 8,
          });
        },
      },
      sessionDirectory: sourceDirectory,
    });
    harness.runtime.syncConversationState({
      id: 'conversation-fork',
      providerState: {
        forkSource: { resumeAt: 'assistant-1', sessionId: 'session-fixture' },
        forkSourceSessionDirectory: sourceDirectory,
      },
      selectedModel: 'grok/grok-4.5',
      sessionId: null,
    });

    try {
      await collect(harness.runtime, 'Continue from the fork.');

      expect(harness.process.requests.map(request => request.method)).toEqual([
        'initialize',
        '_x.ai/session/fork',
        'session/load',
        'session/set_model',
        'session/prompt',
      ]);
      expect(record(harness.process.requests[1]?.params)).toEqual({
        newCwd: VAULT_PATH,
        newModelId: 'grok-4.5',
        sourceCwd,
        sourceSessionId: 'session-fixture',
        targetPromptIndex: 1,
      });
      expect(record(harness.process.requests[2]?.params)).toMatchObject({
        sessionId: 'session-forked',
      });
      expect(harness.runtime.getSessionId()).toBe('session-forked');
      expect(harness.runtime.resolveSessionIdForFork(null)).toBe('session-forked');
      expect(harness.runtime.buildSessionUpdates({
        conversation: {
          providerId: 'grok',
          providerState: {
            forkSource: { resumeAt: 'assistant-1', sessionId: 'session-fixture' },
            forkSourceSessionDirectory: sourceDirectory,
            futureField: 'keep',
          },
          sessionId: null,
        } as never,
        sessionInvalidated: false,
      }).updates.providerState).toEqual({
        futureField: 'keep',
        sessionDirectory: sourceDirectory,
      });
    } finally {
      harness.runtime.cleanup();
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('uses Grok cwd metadata when forking a hash-directory session', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-grok-hash-fork-'));
    const sourceCwd = path.join(tempRoot, 'a'.repeat(260), 'previous-vault');
    const cwdDirectory = path.join(tempRoot, 'sessions', 'previous-vault-0123456789abcdef');
    const sourceDirectory = path.join(cwdDirectory, 'session-fixture');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(cwdDirectory, '.cwd'), sourceCwd);
    fs.copyFileSync(
      path.join(process.cwd(), 'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl'),
      path.join(sourceDirectory, 'updates.jsonl'),
    );
    const harness = createHarness({ sessionDirectory: sourceDirectory });
    harness.runtime.syncConversationState({
      id: 'conversation-hash-fork',
      providerState: {
        forkSource: { resumeAt: 'assistant-1', sessionId: 'session-fixture' },
        forkSourceSessionDirectory: sourceDirectory,
      },
      sessionId: null,
    });

    try {
      await collect(harness.runtime, 'Continue from the fork.');

      expect(record(harness.process.requests.find(
        request => request.method === '_x.ai/session/fork',
      )?.params)).toMatchObject({ sourceCwd });
    } finally {
      harness.runtime.cleanup();
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a hash-directory fork when its source cwd metadata is missing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-grok-bad-hash-fork-'));
    const sourceDirectory = path.join(
      tempRoot,
      'sessions',
      'previous-vault-0123456789abcdef',
      'session-fixture',
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl'),
      path.join(sourceDirectory, 'updates.jsonl'),
    );
    const harness = createHarness({ sessionDirectory: sourceDirectory });
    harness.runtime.syncConversationState({
      id: 'conversation-bad-hash-fork',
      providerState: {
        forkSource: { resumeAt: 'assistant-1', sessionId: 'session-fixture' },
        forkSourceSessionDirectory: sourceDirectory,
      },
      sessionId: null,
    });

    try {
      const chunks = await collect(harness.runtime, 'Continue from the fork.');

      expect(chunks).toContainEqual(expect.objectContaining({
        content: expect.stringContaining('source working directory not found'),
        type: 'error',
      }));
      expect(harness.process.requests.some(
        request => request.method === '_x.ai/session/fork',
      )).toBe(false);
    } finally {
      harness.runtime.cleanup();
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
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

  it('publishes an immutable qualified command snapshot advertised before session/new returns', async () => {
    const harness = createHarness({
      handlers: {
        newSession(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              availableCommands: [{ description: 'Review changes', name: '/local:review' }],
              sessionUpdate: 'available_commands_update',
            },
          });
          process.respond(message, sessionResponse('session-new'));
        },
      },
    });
    const snapshots: ReadonlyArray<unknown>[] = [];
    harness.runtime.onSupportedCommandsChange(commands => snapshots.push(commands));

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    await expect(harness.runtime.getSupportedCommands()).resolves.toEqual([
      expect.objectContaining({ name: 'local:review' }),
    ]);
    const advertised = snapshots.find(snapshot => snapshot.length > 0);
    expect(advertised).toEqual([expect.objectContaining({ name: 'local:review' })]);
    expect(Object.isFrozen(advertised)).toBe(true);
    expect(Object.isFrozen(advertised?.[0])).toBe(true);
    harness.runtime.cleanup();
  });

  it('does not treat a ready session as an authoritative empty command snapshot', async () => {
    const harness = createHarness();

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    expect(harness.runtime.getReadySupportedCommandsSnapshot()).toBeNull();
    harness.runtime.cleanup();
  });

  it('retains an explicitly advertised empty command snapshot as authoritative', async () => {
    const harness = createHarness({
      handlers: {
        newSession(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              availableCommands: [],
              sessionUpdate: 'available_commands_update',
            },
          });
          process.respond(message, sessionResponse('session-new'));
        },
      },
    });

    await expect(harness.runtime.ensureReady()).resolves.toBe(true);

    expect(harness.runtime.getReadySupportedCommandsSnapshot()).toEqual([]);
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
    const listener = jest.fn();
    harness.runtime.onSupportedCommandsChange(listener);

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({ itemId: 'assistant-live', type: 'assistant_message_start' });
    expect(chunks).toContainEqual({ content: 'live text', type: 'text' });
    expect(chunks).not.toContainEqual(expect.objectContaining({ content: 'replayed text' }));
    await expect(harness.runtime.getSupportedCommands()).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'review' }),
    ]);
  });

  it('retains Grok metadata event IDs when content chunks omit ACP message IDs', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify('_x.ai/session/update', {
            _meta: { eventId: 'user-event-id', promptId: 'prompt-id' },
            sessionId: 'session-new',
            update: {
              _meta: { promptIndex: 0 },
              content: { text: 'Prompt', type: 'text' },
              sessionUpdate: 'user_message_chunk',
            },
          });
          process.notify('_x.ai/session/update', {
            _meta: { eventId: 'assistant-event-id', promptId: 'prompt-id' },
            sessionId: 'session-new',
            update: {
              content: { text: 'Answer', type: 'text' },
              sessionUpdate: 'agent_message_chunk',
            },
          });
          process.respond(message, { stopReason: 'end_turn' });
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({
      content: 'Prompt',
      itemId: 'user-event-id',
      type: 'user_message_start',
    });
    expect(chunks).toContainEqual({
      itemId: 'assistant-event-id',
      type: 'assistant_message_start',
    });
    expect(harness.runtime.consumeTurnMetadata()).toMatchObject({
      assistantMessageId: 'assistant-event-id',
      userMessageId: 'user-event-id',
    });
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

  it('adapts Grok tool input for rendering while preserving the wire payload', async () => {
    const rawInput = { limit: 5, offset: 1, target_file: 'note.md' };
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              rawInput,
              sessionUpdate: 'tool_call',
              status: 'in_progress',
              title: 'read_file',
              toolCallId: 'tool-read',
            },
          });
          process.notify('session/update', {
            sessionId: 'session-new',
            update: {
              content: [{ content: { text: 'file contents', type: 'text' }, type: 'content' }],
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              toolCallId: 'tool-read',
            },
          });
          process.respond(message, promptResponse());
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual(expect.objectContaining({
      id: 'tool-read',
      input: expect.objectContaining({ file_path: 'note.md', target_file: 'note.md' }),
      name: 'Read',
      providerPayload: { rawInput, rawName: 'read_file' },
      type: 'tool_use',
    }));
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
        contextWindow: 200_000,
        contextWindowIsAuthoritative: true,
        contextTokens: 15,
        inputTokens: 12,
        percentage: 0,
      }),
    });
  });

  it('uses the selected model metadata as the context denominator without a usage update', async () => {
    const harness = createHarness({
      handlers: {
        prompt(message, process) {
          process.respond(message, {
            stopReason: 'end_turn',
            usage: { inputTokens: 40_000, outputTokens: 10_000, totalTokens: 50_000 },
          });
        },
      },
    });

    const chunks = await collect(harness.runtime);

    expect(chunks).toContainEqual({
      sessionId: 'session-new',
      type: 'usage',
      usage: expect.objectContaining({
        contextWindow: 200_000,
        contextWindowIsAuthoritative: true,
        contextTokens: 50_000,
        model: 'grok/grok-4.5',
        percentage: 25,
      }),
    });
  });

  it('routes defensive permissions and xAI question/plan/yolo extensions through turn-owned UI', async () => {
    const approval = jest.fn().mockResolvedValue('allow');
    const ask = jest.fn().mockResolvedValue({ 'Choose?': 'Yes' });
    const exitPlan = jest.fn().mockResolvedValue({
      type: 'feedback',
      text: 'Add rollback steps',
    });
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
    harness.runtime.setExitPlanModeCallback(exitPlan);
    harness.runtime.setPermissionModeSyncCallback(modeSync);

    await collect(harness.runtime);

    expect(extensionResults).toEqual([
      { answers: { 'Choose?': ['Yes'] }, outcome: 'accepted' },
      { feedback: 'Add rollback steps', outcome: 'cancelled' },
      { outcome: { optionId: 'allow-now', outcome: 'selected' } },
    ]);
    expect(approval).toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
    expect(exitPlan).toHaveBeenCalled();
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

  it('classifies stderr-only API-key failures without exposing the credential', async () => {
    const harness = createHarness({ handlers: { prompt() {} } });
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    await tick();
    harness.process.stderrSnapshot = 'invalid API key XAI_API_KEY=stderr-secret';

    harness.process.close(new Error('transport closed'));

    await expect(first).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ content: expect.stringMatching(/env_key/i), type: 'error' }),
    });
    expect(JSON.stringify(await first)).not.toContain('stderr-secret');
  });

  it('classifies stderr-only expired login diagnostics as Grok authentication errors', async () => {
    const harness = createHarness({ handlers: { prompt() {} } });
    const iterator = harness.runtime.query(harness.runtime.prepareTurn({ text: 'Wait' }));
    const first = iterator.next();
    await tick();
    harness.process.stderrSnapshot = 'authentication token expired';

    harness.process.close(new Error('transport closed'));

    await expect(first).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ content: expect.stringMatching(/grok login/i), type: 'error' }),
    });
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

  it('previews and executes native rewind on a cold persisted session', async () => {
    const sessionDirectory = createRewindHistoryDirectory();
    try {
      const harness = createHarness({
        handlers: {
          rewindExecute(message, process) {
            const params = record(message.params);
            if (params.force === false) {
              process.respond(message, {
                clean_files: ['notes/clean.md'],
                conflicts: [{
                  conflict_type: 'modified_externally',
                  path: 'notes/conflicted.md',
                }],
                error: 'External modifications detected. Confirm to revert anyway.',
                mode: 'all',
                prompt_text: null,
                reverted_files: [],
                success: false,
                target_prompt_index: 1,
              });
              return;
            }
            process.respond(message, {
              clean_files: [],
              conflicts: [],
              error: null,
              mode: 'all',
              prompt_text: 'Second prompt',
              reverted_files: ['notes/clean.md', 'notes/conflicted.md'],
              success: true,
              target_prompt_index: 1,
            });
          },
        },
        sessionDirectory,
      });
      harness.runtime.syncConversationState({
        id: 'conversation-existing',
        providerState: { sessionDirectory },
        selectedModel: 'grok/grok-4.5',
        sessionId: 'session-existing',
      });

      await expect(harness.runtime.previewRewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      )).resolves.toEqual({
        canRewind: true,
        conflicts: [{
          conflictType: 'modified_externally',
          path: 'notes/conflicted.md',
        }],
        filesChanged: ['notes/clean.md', 'notes/conflicted.md'],
      });
      expect(harness.process.requests.map(request => request.method)).toEqual([
        'initialize',
        'session/load',
        '_x.ai/rewind/execute',
      ]);
      expect(record(harness.process.requests[2]?.params)).toEqual({
        force: false,
        mode: 'all',
        sessionId: 'session-existing',
        targetPromptIndex: 1,
      });

      await expect(harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      )).resolves.toEqual({
        canRewind: true,
        filesChanged: ['notes/clean.md', 'notes/conflicted.md'],
        sessionStrategy: 'preserve-provider-session',
      });
      expect(record(harness.process.requests[3]?.params)).toEqual({
        force: true,
        mode: 'all',
        sessionId: 'session-existing',
        targetPromptIndex: 1,
      });
      expect(harness.runtime.getSessionId()).toBe('session-existing');
    } finally {
      fs.rmSync(sessionDirectory, { force: true, recursive: true });
    }
  });

  it('rewinds before the first prompt without clearing the native session', async () => {
    const harness = createHarness({
      handlers: {
        rewindExecute(message, process) {
          process.respond(message, {
            clean_files: [],
            conflicts: [],
            error: null,
            mode: 'conversation_only',
            prompt_text: 'First prompt',
            reverted_files: [],
            success: true,
            target_prompt_index: 0,
          });
        },
      },
    });
    harness.runtime.syncConversationState({
      id: 'conversation-existing',
      providerState: {},
      selectedModel: 'grok/grok-4.5',
      sessionId: 'session-existing',
    });

    await expect(harness.runtime.rewind(
      'user-first',
      undefined,
      'conversation',
    )).resolves.toEqual({
      canRewind: true,
      filesChanged: [],
      sessionStrategy: 'preserve-provider-session',
    });
    expect(record(harness.process.requests.at(-1)?.params)).toEqual({
      force: true,
      mode: 'conversation_only',
      sessionId: 'session-existing',
      targetPromptIndex: 0,
    });
    expect(harness.runtime.getSessionId()).toBe('session-existing');
  });

  it('rejects a rewind response that crosses conversation generations', async () => {
    const sessionDirectory = createRewindHistoryDirectory();
    try {
      const harness = createHarness({
        handlers: { rewindExecute() {} },
        sessionDirectory,
      });
      harness.runtime.syncConversationState({
        id: 'conversation-existing',
        providerState: { sessionDirectory },
        selectedModel: 'grok/grok-4.5',
        sessionId: 'session-existing',
      });
      const rewind = harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      );
      while (harness.processes.length === 0) await tick();
      const request = await waitForRequest(harness.process, '_x.ai/rewind/execute');
      const process = harness.process;

      harness.runtime.syncConversationState({
        id: 'conversation-other',
        providerState: {},
        selectedModel: 'grok/grok-4.5',
        sessionId: 'session-other',
      });
      process.respond(request, {
        clean_files: [],
        conflicts: [],
        error: null,
        mode: 'all',
        prompt_text: 'Second prompt',
        reverted_files: [],
        success: true,
        target_prompt_index: 1,
      });

      await expect(rewind).resolves.toEqual({
        canRewind: false,
        error: 'The Grok conversation changed while rewinding.',
      });
      expect(harness.runtime.getSessionId()).toBe('session-other');
    } finally {
      fs.rmSync(sessionDirectory, { force: true, recursive: true });
    }
  });

  it('rejects turns and duplicate rewinds while native rewind is in flight', async () => {
    const sessionDirectory = createRewindHistoryDirectory();
    try {
      const harness = createHarness({
        handlers: { rewindExecute() {} },
        sessionDirectory,
      });
      harness.runtime.syncConversationState({
        id: 'conversation-existing',
        providerState: { sessionDirectory },
        selectedModel: 'grok/grok-4.5',
        sessionId: 'session-existing',
      });

      const rewind = harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      );
      while (harness.processes.length === 0) await tick();
      const request = await waitForRequest(harness.process, '_x.ai/rewind/execute');

      await expect(harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      )).resolves.toEqual({
        canRewind: false,
        error: 'A Grok rewind is already in progress.',
      });
      await expect(collect(harness.runtime)).resolves.toEqual([
        { type: 'error', content: 'Cannot send a Grok turn while rewind is in progress.' },
        { type: 'done' },
      ]);

      harness.process.respond(request, {
        clean_files: [],
        conflicts: [],
        error: null,
        mode: 'all',
        prompt_text: 'Second prompt',
        reverted_files: [],
        success: true,
        target_prompt_index: 1,
      });
      await expect(rewind).resolves.toMatchObject({ canRewind: true });
    } finally {
      fs.rmSync(sessionDirectory, { force: true, recursive: true });
    }
  });

  it('releases the runtime rewind lock when the native request fails', async () => {
    const sessionDirectory = createRewindHistoryDirectory();
    let rewindRequestCount = 0;
    try {
      const harness = createHarness({
        handlers: {
          rewindExecute(message, process) {
            rewindRequestCount += 1;
            if (rewindRequestCount === 1) {
              process.respondError(message, 'rewind timed out');
              return;
            }
            process.respond(message, {
              clean_files: [],
              conflicts: [],
              error: null,
              mode: 'all',
              prompt_text: 'Second prompt',
              reverted_files: [],
              success: true,
              target_prompt_index: 1,
            });
          },
        },
        sessionDirectory,
      });
      harness.runtime.syncConversationState({
        id: 'conversation-existing',
        providerState: { sessionDirectory },
        selectedModel: 'grok/grok-4.5',
        sessionId: 'session-existing',
      });

      await expect(harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      )).resolves.toMatchObject({ canRewind: false });
      await expect(harness.runtime.rewind(
        'user-second',
        'assistant-first',
        'code-and-conversation',
      )).resolves.toMatchObject({ canRewind: true });
    } finally {
      fs.rmSync(sessionDirectory, { force: true, recursive: true });
    }
  });

  it('preserves provider state and adds only a validated directory hint', async () => {
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
    await expect(harness.runtime.steer?.(harness.runtime.prepareTurn({ text: 'No' }))).resolves.toBe(false);
    expect(harness.runtime.resolveSessionIdForFork(null)).toBe('session-new');
  });
});
