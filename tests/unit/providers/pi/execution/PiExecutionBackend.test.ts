import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createProviderRecoveryTestHarness } from '@test/unit/features/chat/execution/ProviderRecoveryTestHarness';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderInteractionPort,
  ProviderSessionConfig,
} from '@/core/execution';
import {
  isSteerableExecutionSession,
  ProviderExecutionLifecycleRegistry,
} from '@/core/execution';
import type { Conversation } from '@/core/types';
import { createPiWorkspaceServices } from '@/providers/pi/app/PiWorkspaceServices';
import {
  PiCommandMetadataProbe,
  PiExecutionBackend,
  type PiExecutionKernel,
  type PiExecutionKernelCallbacks,
} from '@/providers/pi/execution';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';
import type { PiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpec';

class FakeKernel implements PiExecutionKernel {
  readonly requests: Array<{ payload: Record<string, unknown>; type: string }> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readonly shutdown = jest.fn(async () => undefined);
  readonly start = jest.fn();
  stderr = '';

  constructor(
    readonly launchSpec: PiLaunchSpec,
    private readonly callbacks: PiExecutionKernelCallbacks,
    private readonly responses: Map<string, unknown>,
    private readonly requestHandler?: <T>(
      type: string,
      payload: Record<string, unknown>,
      timeoutMs?: number,
      signal?: AbortSignal,
    ) => Promise<T>,
  ) {}

  emit(event: Record<string, unknown>): void {
    this.callbacks.onEvent(event);
  }

  close(error = new Error('Pi process exited')): void {
    this.callbacks.onClose(error);
  }

  emitExtensionChunk(chunk: any): void {
    this.callbacks.onExtensionChunk(chunk);
  }

  emitExtensionRequest(request: Record<string, unknown>): boolean {
    return this.callbacks.onExtensionRequest(request);
  }

  getStderrSnapshot(): string {
    return this.stderr;
  }

  async request<T>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    this.requests.push({ payload, type });
    if (this.requestHandler) {
      return this.requestHandler<T>(type, payload, timeoutMs, signal);
    }
    return this.responses.get(type) as T;
  }

  send(record: Record<string, unknown>): void {
    this.sent.push(record);
  }
}

function createHost(): any {
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    getResolvedProviderCliPath: jest.fn(async () => '/bin/pi'),
    settings: {
      effortLevel: 'off',
      mediaFolder: 'media',
      model: 'pi:anthropic/claude-sonnet-4',
      providerConfigs: {
        pi: {
          discoveredModels: [{
            encodedId: 'pi:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text', 'image'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'high'],
          }],
          enabled: true,
          toolMode: 'all',
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
      systemPrompt: '',
      userName: '',
    },
  };
}

function createConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    interactionPort: createInteractionPort(),
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/vault',
    ...overrides,
  };
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    askUserQuestion: jest.fn(),
    dismissInteraction: jest.fn(),
    requestApproval: jest.fn(),
    requestPlanDecision: jest.fn(),
  };
}

function createRequest(
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'pi:anthropic/claude-sonnet-4',
      reasoning: 'high',
      systemInstructions: { kind: 'provider-default' },
    },
    input: [{ text: 'Hello Pi', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

async function collect(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

function createDeferred(): {
  promise: Promise<undefined>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<undefined>((settle) => {
    resolve = () => settle(undefined);
  });
  return { promise, resolve };
}

function createRejectableDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: Error) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle, fail) => {
    reject = fail;
    resolve = settle;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Pi execution test condition');
}

function createConversationHistory(prefix: string) {
  return [
    { id: `${prefix}-user`, role: 'user' as const, content: `${prefix} question`, timestamp: 1 },
    { id: `${prefix}-assistant`, role: 'assistant' as const, content: `${prefix} answer`, timestamp: 2 },
  ];
}

function completeTurn(kernel: FakeKernel): void {
  kernel.emit({ type: 'agent_start' });
  kernel.emit({ type: 'agent_end' });
}

function getPromptMessages(kernel: FakeKernel): string[] {
  return kernel.requests
    .filter(({ type }) => type === 'prompt')
    .map(({ payload }) => String(payload.message));
}

function createHarness(
  config = createConfig(),
  onKernelCreated?: (kernel: FakeKernel, index: number) => void,
  requestHandler?: <T>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<T>,
  forkLifecycleOptions: Record<string, unknown> = {},
) {
  const host = createHost();
  const kernels: FakeKernel[] = [];
  const responses = new Map<string, unknown>([
    ['get_commands', {
      commands: [{ description: 'Compact context', name: 'compact', source: 'runtime' }],
    }],
    ['get_session_stats', {
      contextWindow: 200_000,
      inputTokens: 10,
      outputTokens: 5,
    }],
    ['get_state', {
      leafEntryId: 'assistant-1',
      parentSession: 'parent-session',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-1',
    }],
    ['prompt', { accepted: true }],
    ['set_model', {}],
    ['set_thinking_level', {}],
    ['steer', { accepted: true }],
  ]);
  const commandCatalog = {
    getDropdownConfig: jest.fn(),
    listDropdownEntries: jest.fn(async () => []),
    refresh: jest.fn(async () => undefined),
    setCommandSnapshot: jest.fn(),
  };
  const backend = new PiExecutionBackend(
    host,
    { commandCatalog },
    {
      createKernel: (spec, callbacks) => {
        const kernel = new FakeKernel(spec, callbacks, responses, requestHandler);
        kernels.push(kernel);
        onKernelCreated?.(kernel, kernels.length - 1);
        return kernel;
      },
      ...forkLifecycleOptions,
    },
  );
  return {
    backend,
    commandCatalog,
    config,
    host,
    kernels,
    responses,
    session: backend.createSession(config),
  };
}

describe('PiExecutionBackend', () => {
  it('uses an isolated no-session kernel for command metadata probes', async () => {
    const responses = new Map<string, unknown>([
      ['get_commands', {
        commands: [
          { name: 'skill-one', source: 'skill' },
          { name: 'skill-one', source: 'skill' },
        ],
      }],
    ]);
    let renderer: unknown = 'unset';
    let kernel: FakeKernel | null = null;
    const probe = new PiCommandMetadataProbe(
      createHost(),
      (spec, callbacks, suppliedRenderer) => {
        renderer = suppliedRenderer;
        kernel = new FakeKernel(spec, callbacks, responses);
        return kernel;
      },
    );

    await expect(probe.load('/vault')).resolves.toEqual([
      expect.objectContaining({
        id: 'pi:skill:skill-one',
        kind: 'skill',
        name: 'skill-one',
      }),
    ]);
    expect(renderer).toBeNull();
    expect(kernel!.launchSpec.args).toContain('--no-session');
    expect(kernel!.shutdown).toHaveBeenCalledTimes(1);
  });

  it('quiesces an in-flight command probe before a configured CLI transition', async () => {
    const host = createHost();
    let cliPath = '/bin/pi-a';
    let staleRequestStarted = false;
    host.getResolvedProviderCliPath.mockImplementation(async () => cliPath);
    const kernels: FakeKernel[] = [];
    const probe = new PiCommandMetadataProbe(
      host,
      (spec, callbacks) => {
        const kernel = new FakeKernel(
          spec,
          callbacks,
          new Map(),
          async <T>(
            _type: string,
            _payload: Record<string, unknown> = {},
            _timeoutMs?: number,
            signal?: AbortSignal,
          ): Promise<T> => {
            if (spec.command === '/bin/pi-b') {
              return {
                commands: [{ name: 'fresh-command', source: 'runtime' }],
              } as T;
            }
            staleRequestStarted = true;
            return await new Promise<T>((_resolve, reject) => {
              signal?.addEventListener('abort', () => {
                reject(new Error('metadata probe aborted'));
              }, { once: true });
            });
          },
        );
        kernels.push(kernel);
        return kernel;
      },
    );
    const quiesce = jest.spyOn(probe, 'quiesceForEnvironmentChange');
    const services = await createPiWorkspaceServices(host, {
      commandMetadataProbe: probe,
    });
    const context = {
      allowIsolatedMetadataCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: host,
    };

    const staleLoad = services.commandLoader!.loadCommands(context);
    await waitFor(() => staleRequestStarted);
    await host.executionLifecycleRegistry.runTransition(['pi'], async () => {
      expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);
      cliPath = '/bin/pi-b';
    });

    await expect(staleLoad).resolves.toMatchObject({ status: 'error' });
    await expect(services.commandLoader!.loadCommands(context)).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'fresh-command' })],
      status: 'ready',
    });
    expect(kernels.map(kernel => kernel.launchSpec.command)).toEqual([
      '/bin/pi-a',
      '/bin/pi-b',
    ]);
    expect(quiesce).toHaveBeenCalledTimes(2);

    await services.dispose!();
    expect(quiesce).toHaveBeenCalledTimes(3);
    await host.executionLifecycleRegistry.runTransition(['pi'], async () => undefined);
    expect(quiesce).toHaveBeenCalledTimes(3);
    await host.executionLifecycleRegistry.dispose();
  });

  it('fences command metadata started during a transition and reopens on the new CLI', async () => {
    const host = createHost();
    let cliPath = '/bin/pi-a';
    host.getResolvedProviderCliPath.mockImplementation(async () => cliPath);
    const kernels: FakeKernel[] = [];
    const probe = new PiCommandMetadataProbe(host, (spec, callbacks) => {
      const kernel = new FakeKernel(
        spec,
        callbacks,
        new Map([['get_commands', {
          commands: [{ name: `from-${spec.command}`, source: 'runtime' }],
        }]]),
      );
      kernels.push(kernel);
      return kernel;
    });
    const services = await createPiWorkspaceServices(host, {
      commandMetadataProbe: probe,
    });
    const context = {
      allowIsolatedMetadataCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: host,
    };
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const transition = host.executionLifecycleRegistry.runTransition(['pi'], async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
      cliPath = '/bin/pi-b';
    });
    await mutationEntered.promise;

    const controller = new AbortController();
    const abortedLoad = services.commandLoader!.loadCommands({
      ...context,
      signal: controller.signal,
    });
    const waitingLoad = services.commandLoader!.loadCommands(context);
    await flush();
    expect(kernels).toHaveLength(0);

    controller.abort();
    await expect(abortedLoad).rejects.toMatchObject({ name: 'AbortError' });
    expect(kernels).toHaveLength(0);

    releaseMutation.resolve();
    await transition;
    await expect(waitingLoad).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'from-/bin/pi-b' })],
      status: 'ready',
    });
    expect(kernels.map(kernel => kernel.launchSpec.command)).toEqual(['/bin/pi-b']);

    await services.dispose!();
    await host.executionLifecycleRegistry.dispose();
  });

  it('does not strand a command metadata waiter when the workspace is disposed while fenced', async () => {
    const host = createHost();
    const kernels: FakeKernel[] = [];
    const probe = new PiCommandMetadataProbe(host, (spec, callbacks) => {
      const kernel = new FakeKernel(spec, callbacks, new Map());
      kernels.push(kernel);
      return kernel;
    });
    const services = await createPiWorkspaceServices(host, {
      commandMetadataProbe: probe,
    });
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const transition = host.executionLifecycleRegistry.runTransition(['pi'], async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;

    const load = services.commandLoader!.loadCommands({
      allowIsolatedMetadataCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: host,
    });
    await flush();
    expect(kernels).toHaveLength(0);

    await services.dispose!();
    await expect(load).resolves.toMatchObject({ status: 'error' });
    expect(kernels).toHaveLength(0);

    releaseMutation.resolve();
    await transition;
    await host.executionLifecycleRegistry.dispose();
  });

  it('normalizes an acknowledged persistent turn and refreshes native state', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      input: [
        { text: 'Hello Pi', type: 'text' },
        {
          image: {
            data: 'base64-data',
            id: 'image-1',
            mediaType: 'image/png',
            name: 'diagram.png',
            size: 11,
            source: 'file',
          },
          type: 'image',
        },
      ],
    }));
    const eventsPromise = collect(run.events);
    await flush();

    const kernel = harness.kernels[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      assistantMessageEvent: { text_delta: 'Hello' },
      type: 'message_update',
    });
    kernel.emit({
      toolCall: { arguments: { path: 'note.md' }, id: 'tool-1', name: 'read' },
      type: 'tool_execution_start',
    });
    kernel.emit({
      id: 'tool-1',
      result: { content: 'note' },
      type: 'tool_execution_end',
    });
    kernel.emit({ type: 'agent_end' });

    const events = await eventsPromise;
    expect(events.map(event => event.type)).toEqual([
      'session_state_changed',
      'turn_started',
      'user_message_started',
      'assistant_message_started',
      'text_delta',
      'tool_started',
      'tool_completed',
      'usage_updated',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(kernel.requests).toContainEqual({
      payload: {
        images: [{ data: 'base64-data', mimeType: 'image/png', type: 'image' }],
        message: 'Hello Pi',
      },
      type: 'prompt',
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      providerId: 'pi',
      providerSessionId: 'pi-session-1',
      providerState: {
        leafEntryId: 'assistant-1',
        parentSession: 'parent-session',
        sessionFile: '/tmp/pi-session.jsonl',
        sessionId: 'pi-session-1',
      },
      status: 'idle',
    });
    expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();
    expect(harness.commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'pi:runtime:compact', name: 'compact' }),
    ]);
    expect(new Set(events.map(event => event.scope.sequence)).size).toBe(events.length);
  });

  it('keeps one execution open across native Pi retries and commits the recovered answer', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    let settled = false;
    void eventsPromise.then(() => {
      settled = true;
    });
    await flush();

    const kernel = harness.kernels[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      message: {
        content: [],
        errorMessage: 'OpenRouter rate limit (attempt 1)',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
    kernel.emit({ attempt: 1, type: 'auto_retry_start' });
    await flush();
    await flush();
    expect(settled).toBe(false);

    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      message: {
        content: [],
        errorMessage: 'OpenRouter rate limit (attempt 2)',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
    kernel.emit({ attempt: 2, type: 'auto_retry_start' });
    await flush();
    await flush();
    expect(settled).toBe(false);

    harness.responses.set('get_state', {
      leafEntryId: 'assistant-recovered',
      parentSession: 'parent-session',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-1',
    });
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      assistantMessageEvent: { text_delta: 'Recovered answer' },
      type: 'message_update',
    });
    kernel.emit({
      message: {
        content: [{ text: 'Recovered answer', type: 'text' }],
        role: 'assistant',
        stopReason: 'stop',
      },
      type: 'message_end',
    });
    kernel.emit({ attempt: 2, success: true, type: 'auto_retry_end' });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: false });

    const events = await eventsPromise;
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Recovered answer' }),
    ]);
    expect(events.filter(event => event.type === 'notice')).toEqual([
      expect.objectContaining({ message: 'Pi is retrying the turn.' }),
      expect.objectContaining({ message: 'Pi is retrying the turn.' }),
      expect.objectContaining({ message: 'Pi retry finished.' }),
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'execution_error',
    }));
    expect(events.at(-1)).toMatchObject({
      nativeAssistantId: 'assistant-recovered',
      nativeCheckpointId: 'assistant-recovered',
      type: 'turn_completed',
    });
  });

  it('surfaces a native Pi terminal error after a non-retrying agent end', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();

    const kernel = harness.kernels[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      message: {
        content: [],
        errorMessage: 'OpenRouter retry budget exhausted',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: false });

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      message: 'OpenRouter retry budget exhausted',
      type: 'execution_error',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'turn_completed',
    }));
  });

  it('preserves a pending native Pi error when the process exits before agent end', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();

    const kernel = harness.kernels[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      message: {
        content: [],
        errorMessage: 'OpenRouter quota exceeded',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    });
    kernel.close(new Error('Pi process exited'));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      category: 'process-exited',
      message: 'OpenRouter quota exceeded',
      type: 'execution_error',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'turn_completed',
    }));
  });

  it('can cancel while native Pi is waiting to retry and fences later events', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    let settled = false;
    void eventsPromise.then(() => {
      settled = true;
    });
    await flush();

    const kernel = harness.kernels[0];
    kernel.emit({ type: 'agent_start' });
    kernel.emit({
      message: {
        content: [],
        errorMessage: 'OpenRouter rate limit',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: true });
    kernel.emit({ attempt: 1, type: 'auto_retry_start' });
    await flush();
    await flush();
    expect(settled).toBe(false);

    run.cancel();
    kernel.emit({
      assistantMessageEvent: { text_delta: 'late recovered answer' },
      type: 'message_update',
    });
    kernel.emit({ messages: [], type: 'agent_end', willRetry: false });

    const events = await eventsPromise;
    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
    expect(events).not.toContainEqual(expect.objectContaining({
      text: 'late recovered answer',
      type: 'text_delta',
    }));
  });

  it('encodes path-only Linked content without changing the Vault-root process CWD', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      context: { linkedContent: { path: 'Projects/Research' } },
      input: [{ text: 'Inspect linked content', type: 'text' }],
    }));
    const eventsPromise = collect(run.events);
    await flush();
    completeTurn(harness.kernels[0]);
    await eventsPromise;

    expect(harness.kernels[0].launchSpec.cwd).toBe('/vault');
    expect(getPromptMessages(harness.kernels[0])).toEqual([
      'Inspect linked content\n\n<linked_content path="Projects/Research" />',
    ]);
    expect(getPromptMessages(harness.kernels[0])[0]).not.toMatch(
      /<(?:linked_note|current_note)\b/,
    );
  });

  it('launches resumed persistent sessions with their native session file', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resume-session-'));
    const sessionFile = path.join(sessionDir, 'pi-session-1.jsonl');
    await fs.writeFile(sessionFile, '{"type":"session","id":"pi-session-1"}\n');
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'pi-session-1',
        providerState: {
          customState: 'preserved',
          sessionFile,
          sessionId: 'pi-session-1',
        },
      },
      vaultWorkingDirectory: sessionDir,
    }));
    harness.responses.set('get_state', {
      leafEntryId: 'assistant-1',
      sessionFile,
      sessionId: 'pi-session-1',
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;
    const run = harness.session.execute(createRequest({
      conversationHistory: [
        { id: 'history-user', role: 'user', content: 'already native question', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'already native answer', timestamp: 2 },
      ],
    }));
    const eventsPromise = collect(run.events);
    await flush();
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;

    expect(harness.kernels[0].launchSpec.args).toContain(sessionFile);
    expect(harness.kernels[0].requests).toContainEqual({
      payload: { message: 'Hello Pi' },
      type: 'prompt',
    });
    const requestTypes = harness.kernels[0].requests.map(request => request.type);
    expect(requestTypes.indexOf('get_state')).toBeLessThan(requestTypes.indexOf('prompt'));
    expect(harness.session.getSnapshot().providerState).toMatchObject({
      customState: 'preserved',
      sessionId: 'pi-session-1',
    });
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('fails before dispatch when Pi reports a replacement for the requested session', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resume-mismatch-'));
    const requestedSessionFile = path.join(sessionDir, 'session-a.jsonl');
    const replacementSessionFile = path.join(sessionDir, 'session-b.jsonl');
    await fs.writeFile(
      requestedSessionFile,
      '{"type":"session","id":"session-a"}\n',
    );
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'session-a',
        providerState: {
          customState: 'preserved',
          sessionFile: requestedSessionFile,
          sessionId: 'session-a',
        },
      },
      vaultWorkingDirectory: sessionDir,
    }));
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;
    harness.responses.set('get_state', {
      leafEntryId: 'replacement-assistant',
      sessionFile: replacementSessionFile,
      sessionId: 'session-b',
    });

    const eventsPromise = collect(harness.session.execute(createRequest()).events);
    await waitFor(() => harness.kernels.length === 1);
    await waitFor(() => harness.kernels[0].requests.some(request => request.type === 'get_state'));
    const events = await eventsPromise;

    expect(getPromptMessages(harness.kernels[0])).toEqual([]);
    expect(harness.kernels[0].shutdown).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      category: 'provider',
      recoverable: true,
      type: 'execution_error',
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-a',
      providerState: {
        customState: 'preserved',
        sessionFile: requestedSessionFile,
        sessionId: 'session-a',
      },
    });
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('rejects steer while a relaunched kernel is awaiting resume validation', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resume-steer-'));
    const requestedSessionFile = path.join(sessionDir, 'session-a.jsonl');
    const replacementSessionFile = path.join(sessionDir, 'session-b.jsonl');
    await fs.writeFile(
      requestedSessionFile,
      '{"type":"session","id":"session-a"}\n',
    );
    const getState = createRejectableDeferred<unknown>();
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'session-a',
        providerState: {
          sessionFile: requestedSessionFile,
          sessionId: 'session-a',
        },
      },
      vaultWorkingDirectory: sessionDir,
    }), undefined, async <T>(type: string): Promise<T> => {
      if (type === 'get_state') return getState.promise as Promise<T>;
      return {} as T;
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;
    const session = harness.session;
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Pi session must expose steer');
    }

    const eventsPromise = collect(session.execute(createRequest()).events);
    await waitFor(() => harness.kernels.length === 1);
    await waitFor(() => harness.kernels[0].requests.some(
      request => request.type === 'get_state',
    ));

    await expect(session.steer(createRequest({
      input: [{ text: 'Do not send this', type: 'text' }],
    }))).resolves.toBe(false);
    expect(harness.kernels[0].emitExtensionRequest({
      id: 'startup-input',
      method: 'input',
      type: 'extension_ui_request',
    })).toBe(false);
    expect(harness.kernels[0].requests).not.toContainEqual(expect.objectContaining({
      type: 'steer',
    }));

    getState.resolve({
      sessionFile: replacementSessionFile,
      sessionId: 'session-b',
    });
    await eventsPromise;
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('ignores stale resume validation from a replaced kernel', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resume-stale-'));
    const requestedSessionFile = path.join(sessionDir, 'session-a.jsonl');
    const replacementSessionFile = path.join(sessionDir, 'session-b.jsonl');
    await fs.writeFile(
      requestedSessionFile,
      '{"type":"session","id":"session-a"}\n',
    );
    const firstGetState = createRejectableDeferred<unknown>();
    const secondGetState = createRejectableDeferred<unknown>();
    let getStateCount = 0;
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'session-a',
        providerState: {
          sessionFile: requestedSessionFile,
          sessionId: 'session-a',
        },
      },
      vaultWorkingDirectory: sessionDir,
    }), undefined, async <T>(type: string): Promise<T> => {
      if (type !== 'get_state') return {} as T;
      getStateCount += 1;
      return (getStateCount === 1
        ? firstGetState.promise
        : secondGetState.promise) as Promise<T>;
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;
    const session = harness.session;
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Pi session must expose steer');
    }

    const firstRun = session.execute(createRequest());
    const firstEvents = collect(firstRun.events);
    await waitFor(() => harness.kernels[0]?.requests.some(
      request => request.type === 'get_state',
    ));
    firstRun.cancel();
    await firstEvents;

    const secondEvents = collect(session.execute(createRequest()).events);
    await waitFor(() => harness.kernels[1]?.requests.some(
      request => request.type === 'get_state',
    ));
    firstGetState.resolve({
      sessionFile: requestedSessionFile,
      sessionId: 'session-a',
    });
    await flush();

    await expect(session.steer(createRequest({
      input: [{ text: 'Do not send this either', type: 'text' }],
    }))).resolves.toBe(false);
    expect(harness.kernels[1].requests).not.toContainEqual(expect.objectContaining({
      type: 'steer',
    }));

    secondGetState.resolve({
      sessionFile: replacementSessionFile,
      sessionId: 'session-b',
    });
    await secondEvents;
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('retains a missing persisted session path until recovery resolves it', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-missing-path-'));
    const missingSessionFile = path.join(sessionDir, 'missing.jsonl');
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          futureResumeCursor: { token: 'keep-me' },
          sessionFile: missingSessionFile,
        },
      },
      vaultWorkingDirectory: sessionDir,
    }), kernel => {
      kernel.start.mockImplementation(() => kernel.close());
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;

    const events = await collect(harness.session.execute(createRequest()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: missingSessionFile,
      type: 'execution_error',
    });
    expect(harness.kernels).toHaveLength(0);
    expect(harness.session.getSnapshot()).toMatchObject({
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        sessionFile: missingSessionFile,
      },
    });
    expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();
    await expect(fs.stat(missingSessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('resets a missing persisted path through the coordinator before retrying', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-coordinator-missing-'));
    const missingSessionFile = path.join(sessionDir, 'missing.jsonl');
    const harness = createHarness(createConfig({
      vaultWorkingDirectory: sessionDir,
    }));
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;
    const conversation: Conversation = {
      id: 'pi-recovery',
      providerId: 'pi',
      title: 'Pi recovery',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: missingSessionFile,
      messages: [],
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        sessionFile: missingSessionFile,
      },
    };
    const historyService = new PiConversationHistoryService();
    const recovery = createProviderRecoveryTestHarness({
      backend: harness.backend,
      conversation,
      vaultWorkingDirectory: sessionDir,
      configuration: createRequest().configuration,
      resolveMissingProviderSession: async (current, missingSessionId) => {
        const resolution = await historyService.resolveMissingConversationSession(
          current,
          sessionDir,
          missingSessionId,
        );
        return resolution === 'delete' ? 'deleted' : resolution === 'preserve'
          ? 'preserved'
          : 'reset';
      },
    });

    await expect(recovery.execute()).resolves.toMatchObject({
      missingSessionResolution: 'reset',
      status: 'missing-session',
    });
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toEqual({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        sessionFile: missingSessionFile,
        sessionId: missingSessionFile,
      }],
    });

    await recovery.coordinator.prepare();
    expect(recovery.createSessionSpy).toHaveBeenCalledTimes(2);
    expect(recovery.createSessionSpy.mock.calls[1]?.[0].resumeSeed).toBeUndefined();
    await recovery.coordinator.dispose();
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('starts fresh while retaining detached Pi history state', async () => {
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          futureResumeCursor: { token: 'keep-me' },
          previousSessions: [{
            leafEntryId: 'assistant-1',
            sessionFile: '/tmp/previous.jsonl',
            sessionId: 'previous-session',
          }],
        },
      },
    }));
    const run = harness.session.execute(createRequest({
      conversationHistory: createConversationHistory('detached prior'),
    }));
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    await waitFor(() => getPromptMessages(harness.kernels[0]).length === 1);
    completeTurn(harness.kernels[0]);
    await eventsPromise;

    expect(harness.kernels[0].launchSpec.args).not.toContain('--session');
    expect(getPromptMessages(harness.kernels[0])[0]).toEqual(expect.stringContaining(
      'detached prior question',
    ));
    expect(harness.session.getSnapshot().providerState).toMatchObject({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/tmp/previous.jsonl',
        sessionId: 'previous-session',
      }],
    });
  });

  it('does not duplicate recovered history after the fresh native session reloads', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-recovery-reload-'));
    const previousFile = path.join(sessionDir, 'previous.jsonl');
    const activeFile = path.join(sessionDir, 'active.jsonl');
    await fs.writeFile(previousFile, [
      JSON.stringify({ type: 'session', id: 'previous-session', cwd: sessionDir }),
      JSON.stringify({
        id: 'recovered-user',
        type: 'message',
        message: { role: 'user', content: 'recovered question' },
      }),
      JSON.stringify({
        id: 'recovered-assistant',
        type: 'message',
        message: { role: 'assistant', content: 'recovered answer' },
      }),
    ].join('\n'));
    const previousSession = {
      leafEntryId: 'recovered-assistant',
      sessionFile: previousFile,
      sessionId: 'previous-session',
    };
    const harness = createHarness(createConfig({
      resumeSeed: { providerState: { previousSessions: [previousSession] } },
      vaultWorkingDirectory: sessionDir,
    }));
    const run = harness.session.execute(createRequest({
      conversationHistory: createConversationHistory('recovered'),
      input: [{ text: 'Follow up', type: 'text' }],
    }));
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    await waitFor(() => getPromptMessages(harness.kernels[0]).length === 1);
    completeTurn(harness.kernels[0]);
    await eventsPromise;

    await fs.writeFile(activeFile, [
      JSON.stringify({ type: 'session', id: 'active-session', cwd: sessionDir }),
      JSON.stringify({
        id: 'fresh-user',
        type: 'message',
        message: { role: 'user', content: getPromptMessages(harness.kernels[0])[0] },
      }),
      JSON.stringify({
        id: 'fresh-assistant',
        type: 'message',
        message: { role: 'assistant', content: 'Fresh answer' },
      }),
    ].join('\n'));
    const conversation = {
      id: 'recovered-conversation',
      providerId: 'pi',
      title: 'Recovered',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: 'active-session',
      messages: [],
      providerState: {
        previousSessions: [previousSession],
        sessionFile: activeFile,
        sessionId: 'active-session',
      },
    } as Conversation;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      sessionDir,
      {
        environment: {
          HOME: sessionDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
        },
      },
    );

    expect(conversation.messages.map(message => message.content)).toEqual([
      'recovered question',
      'recovered answer',
      'Follow up',
      'Fresh answer',
    ]);
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('falls back from a stale path and projects Pi exact missing-id startup output', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-missing-id-'));
    const missingSessionFile = path.join(sessionDir, 'missing.jsonl');
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: 'missing-session-id',
        providerState: {
          futureResumeCursor: { token: 'keep-me' },
          sessionFile: missingSessionFile,
          sessionId: 'missing-session-id',
        },
      },
      vaultWorkingDirectory: sessionDir,
    }), kernel => {
      kernel.start.mockImplementation(() => {
        kernel.stderr = "No session found matching 'missing-session-id'";
        kernel.close();
      });
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;

    const events = await collect(harness.session.execute(createRequest()).events);

    expect(harness.kernels[0].launchSpec.args).toEqual(expect.arrayContaining([
      '--session',
      'missing-session-id',
    ]));
    expect(harness.kernels[0].launchSpec.args).not.toContain(missingSessionFile);
    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'missing-session-id',
      type: 'execution_error',
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: 'missing-session-id',
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        sessionId: 'missing-session-id',
      },
      providerStateDeletes: ['sessionFile'],
    });
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it.each([
    ['provider state', (target: string) => ({
      providerState: { futureResumeCursor: { token: 'keep-me' }, sessionId: target },
    })],
    ['top-level resume seed', (target: string) => ({
      providerSessionId: target,
      providerState: { futureResumeCursor: { token: 'keep-me' } },
    })],
  ] as const)('rejects an out-of-root path stored as a path-only %s session id', async (
    _source,
    createResumeSeed,
  ) => {
    const trustedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-path-id-trusted-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-path-id-outside-'));
    const outsideSessionFile = path.join(outsideDir, 'legacy.jsonl');
    await fs.writeFile(outsideSessionFile, '{"type":"session","id":"legacy"}\n');
    const harness = createHarness(createConfig({
      resumeSeed: createResumeSeed(outsideSessionFile),
      vaultWorkingDirectory: trustedDir,
    }), kernel => {
      kernel.start.mockImplementation(() => kernel.close());
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${trustedDir}`;

    const events = await collect(harness.session.execute(createRequest()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: outsideSessionFile,
      type: 'execution_error',
    });
    expect(harness.kernels).toHaveLength(0);
    expect(harness.session.getSnapshot()).toMatchObject({
      providerSessionId: outsideSessionFile,
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        sessionId: outsideSessionFile,
      },
    });
    expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();
    await fs.rm(trustedDir, { force: true, recursive: true });
    await fs.rm(outsideDir, { force: true, recursive: true });
  });

  it('normalizes a trusted path-only legacy session id before kernel startup', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-path-id-normalize-'));
    const sessionFile = path.join(sessionDir, 'legacy.jsonl');
    await fs.writeFile(sessionFile, '{"type":"session","id":"legacy"}\n');
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerSessionId: sessionFile,
        providerState: {
          futureResumeCursor: { token: 'keep-me' },
          sessionId: sessionFile,
        },
      },
      vaultWorkingDirectory: sessionDir,
    }), undefined, async <T>(type: string): Promise<T> => {
      if (type === 'set_model') throw new Error('stop after startup validation');
      return {} as T;
    });
    harness.host.settings.providerConfigs.pi.environmentVariables =
      `PI_CODING_AGENT_SESSION_DIR=${sessionDir}`;

    await collect(harness.session.execute(createRequest()).events);

    expect(harness.kernels).toHaveLength(1);
    expect(harness.kernels[0].launchSpec.args).toEqual(expect.arrayContaining([
      '--session',
      sessionFile,
    ]));
    expect(harness.session.getSnapshot()).toMatchObject({
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        sessionFile,
      },
      providerStateDeletes: ['sessionId'],
    });
    expect(harness.session.getSnapshot()).not.toHaveProperty('providerSessionId');
    await fs.rm(sessionDir, { force: true, recursive: true });
  });

  it('replays canonical history only while bootstrapping native context', async () => {
    const harness = createHarness();
    const conversationHistory = createConversationHistory('prior');

    for (const [index, text] of ['First follow up', 'Second follow up'].entries()) {
      const run = harness.session.execute(createRequest({
        conversationHistory,
        input: [{ text, type: 'text' }],
      }));
      const eventsPromise = collect(run.events);
      await waitFor(() => harness.kernels.flatMap(kernel => kernel.requests).filter(
        ({ type }) => type === 'prompt',
      ).length === index + 1);
      const kernel = [...harness.kernels].reverse().find(candidate => (
        candidate.requests.some(({ type }) => type === 'prompt')
      ));
      if (!kernel) throw new Error('Pi prompt kernel was not created');
      completeTurn(kernel);
      await eventsPromise;
    }

    const prompts = harness.kernels.flatMap(getPromptMessages);
    expect(harness.kernels).toHaveLength(1);
    expect(prompts[0]).toContain('prior question');
    expect(prompts[0]).toContain('prior answer');
    expect(prompts[1]).toBe('Second follow up');
  });

  it.each([
    ['model configuration', 'set_model', false],
    ['startup extension UI', 'set_model', true],
    ['prompt dispatch', 'prompt', false],
  ] as const)('retains history replay after pre-handoff %s failure', async (
    _label,
    failureType,
    emitStartupUi,
  ) => {
    let rejectRequest = true;
    const requestHandler = async <T>(type: string): Promise<T> => {
      if (type === failureType && rejectRequest) {
        rejectRequest = false;
        throw new Error(`${failureType} failed`);
      }
      const responses: Record<string, unknown> = {
        get_commands: { commands: [] },
        get_session_stats: {},
        get_state: {},
        prompt: { accepted: true },
        set_model: {},
        set_thinking_level: {},
      };
      return responses[type] as T;
    };
    const harness = createHarness(
      createConfig(),
      emitStartupUi
        ? kernel => kernel.start.mockImplementation(() => {
          kernel.emitExtensionRequest({
            id: 'startup-extension',
            method: 'select',
            type: 'extension_ui_request',
          });
        })
        : undefined,
      requestHandler,
    );
    const conversationHistory = createConversationHistory('pre-handoff');

    const failedEvents = await collect(harness.session.execute(createRequest({
      conversationHistory,
    })).events);
    expect(failedEvents).not.toContainEqual(expect.objectContaining({
      accepted: true,
      type: 'turn_started',
    }));

    const retry = harness.session.execute(createRequest({
      conversationHistory,
      input: [{ text: 'Retry after pre-handoff failure', type: 'text' }],
    }));
    const retryEvents = collect(retry.events);
    const expectedPromptCount = failureType === 'prompt' ? 2 : 1;
    await waitFor(() => (
      getPromptMessages(harness.kernels[0]).length === expectedPromptCount
    ));
    completeTurn(harness.kernels[0]);
    await retryEvents;

    expect(getPromptMessages(harness.kernels[0]).at(-1)).toEqual(
      expect.stringContaining('pre-handoff question'),
    );
  });

  it.each([
    ['cancellation', 'cancel'],
    ['kernel close', 'close'],
  ] as const)('replays history after accepted no-state %s', async (_label, teardown) => {
    const harness = createHarness();
    harness.responses.set('get_state', {});
    const conversationHistory = createConversationHistory('restart prior');
    const firstRun = harness.session.execute(createRequest({ conversationHistory }));
    const firstEvents = collect(firstRun.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    if (teardown === 'cancel') {
      firstRun.cancel();
    } else {
      harness.kernels[0].close(new Error('kernel lost after acceptance'));
    }
    await firstEvents;

    const retry = harness.session.execute(createRequest({
      conversationHistory,
      input: [{ text: 'Retry after kernel close', type: 'text' }],
    }));
    const retryEvents = collect(retry.events);
    await waitFor(() => harness.kernels.length === 2);
    await waitFor(() => getPromptMessages(harness.kernels[1]).length === 1);
    completeTurn(harness.kernels[1]);
    await retryEvents;

    expect(getPromptMessages(harness.kernels[1])[0]).toEqual(expect.stringContaining(
      'restart prior question',
    ));
  });

  it('replays history when configuration replaces an accepted no-state kernel', async () => {
    const harness = createHarness();
    harness.responses.set('get_state', {});
    const conversationHistory = createConversationHistory('replacement prior');
    const firstRun = harness.session.execute(createRequest({ conversationHistory }));
    const firstEvents = collect(firstRun.events);
    await waitFor(() => harness.kernels.length === 1);
    completeTurn(harness.kernels[0]);
    await firstEvents;

    const replacementRun = harness.session.execute(createRequest({
      conversationHistory,
      input: [{ text: 'Continue with passive tools', type: 'text' }],
      toolPolicy: { kind: 'passive' },
    }));
    const replacementEvents = collect(replacementRun.events);
    await waitFor(() => harness.kernels.length === 2);
    await waitFor(() => getPromptMessages(harness.kernels[1]).length === 1);
    completeTurn(harness.kernels[1]);
    await replacementEvents;

    expect(getPromptMessages(harness.kernels[1])[0]).toEqual(expect.stringContaining(
      'replacement prior question',
    ));
  });

  it('keeps no-session ephemeral continuation in the same process', async () => {
    const harness = createHarness(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
      resumeSeed: {
        providerSessionId: 'old-session',
        providerState: {
          forkSource: { resumeAt: 'assistant-old', sessionId: 'old-session' },
          forkSourceSessionFile: '/tmp/old-source.jsonl',
          futureState: { retained: true },
          leafEntryId: 'assistant-old',
          parentSession: '/tmp/parent.jsonl',
          sessionFile: '/tmp/old-session.jsonl',
          sessionId: 'old-session',
        },
      },
    }));

    const conversationHistory = createConversationHistory('ephemeral prior');
    for (const text of ['First', 'Clarification']) {
      const run = harness.session.execute(createRequest({
        conversationHistory,
        input: [{ text, type: 'text' }],
      }));
      const eventsPromise = collect(run.events);
      await waitFor(() => harness.kernels.length === 1);
      completeTurn(harness.kernels[0]);
      await eventsPromise;
    }

    expect(harness.kernels).toHaveLength(1);
    expect(harness.kernels[0].launchSpec.args).toContain('--no-session');
    const prompts = getPromptMessages(harness.kernels[0]);
    expect(prompts[0]).toEqual(expect.stringContaining(
      'ephemeral prior question',
    ));
    expect(prompts[1]).toBe('Clarification');
    const snapshot = harness.session.getSnapshot();
    expect(snapshot).not.toHaveProperty('providerSessionId');
    expect(snapshot.providerState).toEqual({ futureState: { retained: true } });
    expect(snapshot.providerStateDeletes).toEqual([
      'sessionId',
      'sessionFile',
      'leafEntryId',
      'parentSession',
      'forkSource',
      'forkSourceSessionFile',
    ]);
    expect(Object.isFrozen(snapshot.providerStateDeletes)).toBe(true);
  });

  it.each([
    ['passive', '--no-tools'],
    ['read-only', 'read,grep,find,ls'],
  ] as const)('maps %s tool policy into the launch profile', async (kind, expected) => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      toolPolicy: { kind },
    }));
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;

    expect(harness.kernels[0].launchSpec.args).toContain(expected);
  });

  it('includes provider-default dynamic sections in the complete system prompt', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      configuration: {
        model: 'pi:anthropic/claude-sonnet-4',
        reasoning: 'high',
        systemInstructions: {
          dynamicSections: ['## Collab Mode\nRuntime guidance.'],
          kind: 'provider-default',
        },
      },
    }));
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    completeTurn(harness.kernels[0]);
    await eventsPromise;

    const args = harness.kernels[0].launchSpec.args;
    const promptIndex = args.indexOf('--system-prompt');
    const systemPrompt = args[promptIndex + 1] ?? '';
    expect(systemPrompt).toContain('## Runtime Context');
    expect(systemPrompt).toContain('Use `bash: date`');
    expect(systemPrompt).toContain('## Vault Media');
    expect(systemPrompt).toContain('## Collab Mode\nRuntime guidance.');
    expect(systemPrompt.match(/## Collab Mode/g)).toHaveLength(1);
  });

  it('maps an explicit allow-list exactly and falls back to provider model settings', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest({
      configuration: {
        reasoning: 'high',
        systemInstructions: { kind: 'provider-default' },
      },
      toolPolicy: {
        kind: 'allow-list',
        names: ['read', 'grep'],
      },
    }));
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;

    expect(harness.kernels[0].launchSpec.args).toEqual(expect.arrayContaining([
      '--tools',
      'read,grep',
    ]));
    expect(harness.kernels[0].requests).toContainEqual({
      payload: {
        modelId: 'claude-sonnet-4',
        provider: 'anthropic',
      },
      type: 'set_model',
    });
  });

  it('supports native steer with prompt images', async () => {
    const harness = createHarness();
    const session = harness.session;
    expect(isSteerableExecutionSession(session)).toBe(true);
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Pi session must expose steer');
    }
    const run = session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();

    const steered = await session.steer(createRequest({
      input: [
        { text: 'Correction', type: 'text' },
        {
          image: {
            data: 'steer-image',
            id: 'image-2',
            mediaType: 'image/jpeg',
            name: 'photo.jpg',
            size: 11,
            source: 'file',
          },
          type: 'image',
        },
      ],
    }));
    expect(steered).toBe(true);
    expect(harness.kernels[0].requests).toContainEqual({
      payload: {
        images: [{ data: 'steer-image', mimeType: 'image/jpeg', type: 'image' }],
        message: 'Correction',
      },
      type: 'steer',
    });

    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;
  });

  it('returns false when steer cannot reach native handoff', async () => {
    const idleHarness = createHarness();
    const idleSession = idleHarness.session;
    if (!isSteerableExecutionSession(idleSession)) {
      throw new Error('Pi session must expose steer');
    }

    await expect(idleSession.steer(createRequest())).resolves.toBe(false);
    await idleSession.dispose();
    await expect(idleSession.steer(createRequest())).resolves.toBe(false);

    const activeHarness = createHarness();
    const activeSession = activeHarness.session;
    if (!isSteerableExecutionSession(activeSession)) {
      throw new Error('Pi session must expose steer');
    }
    const run = activeSession.execute(createRequest());
    const eventsPromise = collect(run.events);

    await expect(activeSession.steer(createRequest())).resolves.toBe(false);
    await waitFor(() => activeHarness.kernels.length === 1);
    const requestAbort = new AbortController();
    requestAbort.abort();
    await expect(activeSession.steer(createRequest({
      signal: requestAbort.signal,
    }))).resolves.toBe(false);

    run.cancel();
    await eventsPromise;
  });

  it('rejects an ambiguous native steer failure after lifecycle disposal', async () => {
    const nativeSteer = createRejectableDeferred<unknown>();
    const harness = createHarness(
      createConfig(),
      undefined,
      async <T>(type: string): Promise<T> => {
        if (type === 'steer') return nativeSteer.promise as Promise<T>;
        return {} as T;
      },
    );
    const lease = harness.host.executionLifecycleRegistry.acquire(
      harness.backend,
      harness.config,
      'chat',
    );
    const session = lease.session;
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Pi session must expose steer');
    }
    const run = session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);

    const steerPromise = session.steer(createRequest());
    await waitFor(() => harness.kernels[0].requests.some(
      request => request.type === 'steer',
    ));
    const transitionPromise = harness.host.executionLifecycleRegistry.runTransition(
      ['pi'],
      async () => undefined,
    );
    await waitFor(() => session.getStatus() === 'disposed');
    nativeSteer.reject(new Error('Pi steer response was lost during disposal'));

    await expect(steerPromise).rejects.toThrow(
      'Pi steer response was lost during disposal',
    );
    await transitionPromise;
    await eventsPromise;
    await harness.host.executionLifecycleRegistry.dispose();
  });

  it('returns true when native steer acceptance arrives after the active run is stale', async () => {
    const nativeSteer = createRejectableDeferred<unknown>();
    const harness = createHarness(
      createConfig(),
      undefined,
      async <T>(type: string): Promise<T> => {
        if (type === 'steer') return nativeSteer.promise as Promise<T>;
        return {} as T;
      },
    );
    const session = harness.session;
    if (!isSteerableExecutionSession(session)) {
      throw new Error('Pi session must expose steer');
    }
    const run = session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);

    const steerPromise = session.steer(createRequest());
    await waitFor(() => harness.kernels[0].requests.some(
      request => request.type === 'steer',
    ));
    run.cancel();
    nativeSteer.resolve({ accepted: true });

    await expect(steerPromise).resolves.toBe(true);
    await eventsPromise;
  });

  it('cancels once, shuts down the process, and fences late events', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();
    harness.kernels[0].emit({ type: 'agent_start' });

    run.cancel();
    harness.kernels[0].emit({
      assistantMessageEvent: { text_delta: 'late' },
      type: 'message_update',
    });
    const events = await eventsPromise;
    await flush();

    expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({
      text: 'late',
      type: 'text_delta',
    }));
    expect(harness.kernels[0].sent).toContainEqual({ type: 'abort' });
    expect(harness.kernels[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not launch a replacement kernel after cancellation during restart shutdown', async () => {
    const harness = createHarness();
    const firstRun = harness.session.execute(createRequest());
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await firstEventsPromise;

    const oldKernel = harness.kernels[0];
    const shutdown = createDeferred();
    oldKernel.shutdown.mockImplementation(() => shutdown.promise);
    const restartRun = harness.session.execute(createRequest({
      toolPolicy: { kind: 'passive' },
    }));
    const restartEventsPromise = collect(restartRun.events);
    await waitFor(() => oldKernel.shutdown.mock.calls.length === 1);

    restartRun.cancel();
    await expect(restartEventsPromise).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    shutdown.resolve();
    await flush();

    expect(harness.kernels).toHaveLength(1);
    expect(oldKernel.start).toHaveBeenCalledTimes(1);
    expect(oldKernel.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not launch a replacement kernel after disposal during restart shutdown', async () => {
    const harness = createHarness();
    const firstRun = harness.session.execute(createRequest());
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await firstEventsPromise;

    const oldKernel = harness.kernels[0];
    const shutdown = createDeferred();
    oldKernel.shutdown.mockImplementation(() => shutdown.promise);
    const restartRun = harness.session.execute(createRequest({
      toolPolicy: { kind: 'passive' },
    }));
    const restartEventsPromise = collect(restartRun.events);
    await waitFor(() => oldKernel.shutdown.mock.calls.length === 1);

    const disposePromise = harness.session.dispose();
    shutdown.resolve();
    await disposePromise;
    await restartEventsPromise;
    await flush();

    expect(harness.kernels).toHaveLength(1);
    expect(oldKernel.start).toHaveBeenCalledTimes(1);
    expect(oldKernel.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.session.getStatus()).toBe('disposed');
  });

  it('shuts down a replacement kernel when cancellation occurs during startup', async () => {
    const restartRunHolder: { run?: ProviderExecutionRun } = {};
    const harness = createHarness(createConfig(), (kernel, index) => {
      if (index === 1) {
        kernel.start.mockImplementation(() => restartRunHolder.run?.cancel());
      }
    });
    const firstRun = harness.session.execute(createRequest());
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => harness.kernels.length === 1);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await firstEventsPromise;

    const restartRun = harness.session.execute(createRequest({
      toolPolicy: { kind: 'passive' },
    }));
    restartRunHolder.run = restartRun;
    const events = await collect(restartRun.events);
    await waitFor(() => harness.kernels.length === 2);
    await flush();

    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(harness.kernels[1].start).toHaveBeenCalledTimes(1);
    expect(harness.kernels[1].shutdown).toHaveBeenCalledTimes(1);
    expect(harness.kernels[1].requests).toEqual([]);
  });

  it('rejects overlapping execution and cancels when iteration ends early', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    expect(() => harness.session.execute(createRequest())).toThrow(
      'Pi execution session already has an active run',
    );
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session_state_changed' },
    });
    await waitFor(() => harness.kernels.length === 1);
    await iterator.return?.();
    await flush();

    expect(harness.kernels[0].sent).toContainEqual({ type: 'abort' });
    expect(harness.kernels[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('terminates with process-exited and invalidates on subprocess death', async () => {
    const harness = createHarness();
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].close(new Error('exit code 1'));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      category: 'process-exited',
      message: 'exit code 1',
      type: 'execution_error',
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      invalidation: { reason: 'process-exited' },
      status: 'invalidated',
    });
  });

  it.each(['cancel', 'dispose'] as const)(
    'retains and rolls back a deferred fork creation when %s wins before commit',
    async (teardown) => {
      const createdFork = {
        leafEntryId: 'assistant-1',
        parentSession: '/tmp/source.jsonl',
        sessionFile: '/tmp/new-fork.jsonl',
        sessionId: 'new-fork',
      };
      const creation = createRejectableDeferred<typeof createdFork>();
      const rollback = createDeferred();
      const createForkSessionFile = jest.fn(() => creation.promise);
      const rollbackForkSessionFile = jest.fn(() => rollback.promise);
      const harness = createHarness(createConfig({
        resumeSeed: {
          providerState: {
            forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
            forkSourceSessionFile: '/tmp/source.jsonl',
            futureState: { retained: true },
          },
        },
      }), undefined, undefined, {
        createForkSessionFile,
        rollbackForkSessionFile,
      });
      const run = harness.session.execute(createRequest());
      const eventsPromise = collect(run.events);
      await waitFor(() => createForkSessionFile.mock.calls.length === 1, 100);

      if (teardown === 'cancel') run.cancel();
      const disposePromise = harness.session.dispose();
      const revisionBeforeCreationSettles = harness.session.getSnapshot().revision;
      let disposeSettled = false;
      void disposePromise.then(() => {
        disposeSettled = true;
      }, () => {
        disposeSettled = true;
      });

      creation.resolve(createdFork);
      await waitFor(() => rollbackForkSessionFile.mock.calls.length === 1, 100);
      await flush();

      expect(disposeSettled).toBe(false);
      expect(harness.kernels).toHaveLength(0);
      expect(harness.session.getSnapshot()).toMatchObject({
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
          futureState: { retained: true },
        },
        revision: revisionBeforeCreationSettles,
      });
      expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();
      expect(rollbackForkSessionFile).toHaveBeenCalledWith(createdFork);

      rollback.resolve();
      await disposePromise;
      const events = await eventsPromise;

      expect(rollbackForkSessionFile).toHaveBeenCalledTimes(1);
      expect(events.filter(event => (
        event.type === 'cancelled'
        || event.type === 'execution_error'
        || event.type === 'turn_completed'
      ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
      expect(harness.session.getSnapshot()).toMatchObject({
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
          futureState: { retained: true },
        },
        status: 'disposed',
      });
    },
  );

  it.each(['cancel', 'dispose'] as const)(
    'rolls back exactly once when %s occurs after fork creation but before state commit',
    async (teardown) => {
      const createdFork = {
        leafEntryId: 'assistant-1',
        parentSession: '/tmp/source.jsonl',
        sessionFile: '/tmp/new-fork.jsonl',
        sessionId: 'new-fork',
      };
      const rollback = createDeferred();
      const rollbackForkSessionFile = jest.fn(() => rollback.promise);
      let disposePromise: Promise<void> | undefined;
      const runHolder: { run?: ProviderExecutionRun } = {};
      const harnessHolder: { harness?: ReturnType<typeof createHarness> } = {};
      const createForkSessionFile = jest.fn(async () => {
        await Promise.resolve();
        if (teardown === 'cancel') runHolder.run?.cancel();
        else disposePromise = harnessHolder.harness?.session.dispose();
        return createdFork;
      });
      const harness = createHarness(createConfig({
        resumeSeed: {
          providerState: {
            forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
            forkSourceSessionFile: '/tmp/source.jsonl',
          },
        },
      }), undefined, undefined, {
        createForkSessionFile,
        rollbackForkSessionFile,
      });
      harnessHolder.harness = harness;
      const run = harness.session.execute(createRequest());
      runHolder.run = run;
      const eventsPromise = collect(run.events);

      await waitFor(() => rollbackForkSessionFile.mock.calls.length === 1, 100);
      disposePromise ??= harness.session.dispose();
      let disposeSettled = false;
      void disposePromise.then(() => {
        disposeSettled = true;
      }, () => {
        disposeSettled = true;
      });
      await flush();

      expect(disposeSettled).toBe(false);
      expect(harness.kernels).toHaveLength(0);
      expect(harness.session.getSnapshot().providerState).toMatchObject({
        forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
        forkSourceSessionFile: '/tmp/source.jsonl',
      });
      expect(harness.session.getSnapshot().providerStateDeletes).toBeUndefined();

      rollback.resolve();
      await disposePromise;
      await eventsPromise;

      expect(rollbackForkSessionFile).toHaveBeenCalledTimes(1);
      expect(harness.session.getSnapshot().providerState).toMatchObject({
        forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
        forkSourceSessionFile: '/tmp/source.jsonl',
      });
    },
  );

  it('lets an immediate retry wait for rollback and materialize its own fresh fork target', async () => {
    const firstTarget = {
      leafEntryId: 'assistant-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/fork-a.jsonl',
      sessionId: 'fork-a',
    };
    const retryTarget = {
      ...firstTarget,
      sessionFile: '/tmp/fork-b.jsonl',
      sessionId: 'fork-b',
    };
    const firstCreation = createRejectableDeferred<typeof firstTarget>();
    const rollback = createDeferred();
    const createForkSessionFile = jest.fn()
      .mockImplementationOnce(() => firstCreation.promise)
      .mockResolvedValueOnce(retryTarget);
    const rollbackForkSessionFile = jest.fn(() => rollback.promise);
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
        },
      },
    }), undefined, undefined, {
      createForkSessionFile,
      rollbackForkSessionFile,
    });
    harness.responses.set('get_state', retryTarget);
    const firstRun = harness.session.execute(createRequest({
      input: [{ text: 'A', type: 'text' }],
    }));
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => createForkSessionFile.mock.calls.length === 1, 100);

    firstRun.cancel();
    const firstEvents = await firstEventsPromise;
    const retryEventsPromise = collect(harness.session.execute(createRequest({
      input: [{ text: 'B', type: 'text' }],
    })).events);
    let retrySettled = false;
    void retryEventsPromise.then(() => {
      retrySettled = true;
    });
    firstCreation.resolve(firstTarget);
    await waitFor(() => rollbackForkSessionFile.mock.calls.length === 1, 100);
    await flush();

    expect(retrySettled).toBe(false);
    expect(createForkSessionFile).toHaveBeenCalledTimes(1);
    expect(harness.kernels).toHaveLength(0);

    rollback.resolve();
    await waitFor(() => createForkSessionFile.mock.calls.length === 2, 100);
    await waitFor(() => harness.kernels.length === 1, 100);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    const retryEvents = await retryEventsPromise;

    expect(firstEvents.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(createForkSessionFile.mock.calls).toEqual([
      ['/tmp/source.jsonl', 'assistant-1', { targetCwd: '/vault' }],
      ['/tmp/source.jsonl', 'assistant-1', { targetCwd: '/vault' }],
    ]);
    expect(rollbackForkSessionFile).toHaveBeenCalledTimes(1);
    const sessionTargetIndex = harness.kernels[0].launchSpec.args.indexOf('--session') + 1;
    expect(harness.kernels[0].launchSpec.args[sessionTargetIndex]).toBe('/tmp/fork-b.jsonl');
    await harness.session.dispose();
  });

  it('terminates an immediate retry when prior rollback fails and blocks further execution', async () => {
    const firstTarget = {
      leafEntryId: 'assistant-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/fork-a.jsonl',
      sessionId: 'fork-a',
    };
    const firstCreation = createRejectableDeferred<typeof firstTarget>();
    const createForkSessionFile = jest.fn(() => firstCreation.promise);
    const rollbackForkSessionFile = jest.fn(async () => {
      throw new Error('fork rollback failed');
    });
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
        },
      },
    }), undefined, undefined, {
      createForkSessionFile,
      rollbackForkSessionFile,
    });
    const firstRun = harness.session.execute(createRequest({
      input: [{ text: 'A', type: 'text' }],
    }));
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => createForkSessionFile.mock.calls.length === 1, 100);

    firstRun.cancel();
    const firstEvents = await firstEventsPromise;
    const retryEventsPromise = collect(harness.session.execute(createRequest({
      input: [{ text: 'B', type: 'text' }],
    })).events);
    let retrySettled = false;
    void retryEventsPromise.then(() => {
      retrySettled = true;
    });
    firstCreation.resolve(firstTarget);
    await waitFor(() => rollbackForkSessionFile.mock.calls.length === 1, 100);
    await flush();

    expect(retrySettled).toBe(true);
    const retryEvents = await retryEventsPromise;
    expect(firstEvents.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
    expect(retryEvents.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({
        category: 'provider',
        recoverable: false,
        type: 'execution_error',
      }),
    ]);
    expect(retryEvents.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({ recoverable: false }),
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(harness.session.getStatus()).toBe('invalidated');
    expect(() => harness.session.execute(createRequest())).toThrow(
      'cleanup failed and requires disposal',
    );
    await expect(harness.session.dispose()).rejects.toThrow('fork rollback failed');
    expect(harness.session.getStatus()).toBe('disposed');
    expect(createForkSessionFile).toHaveBeenCalledTimes(1);
    expect(rollbackForkSessionFile).toHaveBeenCalledTimes(1);
    expect(harness.kernels).toHaveLength(0);
  });

  it('retries the preserved fork seed after an ordinary prior creation failure', async () => {
    const retryTarget = {
      leafEntryId: 'assistant-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/fork-b.jsonl',
      sessionId: 'fork-b',
    };
    const firstCreation = createRejectableDeferred<typeof retryTarget>();
    const createForkSessionFile = jest.fn()
      .mockImplementationOnce(() => firstCreation.promise)
      .mockResolvedValueOnce(retryTarget);
    const rollbackForkSessionFile = jest.fn(async () => undefined);
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
        },
      },
    }), undefined, undefined, {
      createForkSessionFile,
      rollbackForkSessionFile,
    });
    harness.responses.set('get_state', retryTarget);
    const firstRun = harness.session.execute(createRequest({
      input: [{ text: 'A', type: 'text' }],
    }));
    const firstEventsPromise = collect(firstRun.events);
    await waitFor(() => createForkSessionFile.mock.calls.length === 1, 100);

    firstRun.cancel();
    await firstEventsPromise;
    const retryEventsPromise = collect(harness.session.execute(createRequest({
      input: [{ text: 'B', type: 'text' }],
    })).events);
    firstCreation.reject(new Error('source read failed before target creation'));
    await flush();

    expect(createForkSessionFile).toHaveBeenCalledTimes(2);
    await waitFor(() => harness.kernels.length === 1, 100);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    const retryEvents = await retryEventsPromise;

    expect(retryEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(rollbackForkSessionFile).not.toHaveBeenCalled();
    expect(harness.session.getStatus()).toBe('idle');
    await harness.session.dispose();
  });

  it('keeps cancellation primary while lifecycle disposal surfaces rollback failure', async () => {
    const createdFork = {
      leafEntryId: 'assistant-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/new-fork.jsonl',
      sessionId: 'new-fork',
    };
    let disposePromise: Promise<void> | undefined;
    const harnessHolder: { harness?: ReturnType<typeof createHarness> } = {};
    const rollbackForkSessionFile = jest.fn(async () => {
      throw new Error('fork rollback failed');
    });
    const createForkSessionFile = jest.fn(async () => {
      await Promise.resolve();
      disposePromise = harnessHolder.harness?.session.dispose();
      return createdFork;
    });
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
          forkSourceSessionFile: '/tmp/source.jsonl',
        },
      },
    }), undefined, undefined, {
      createForkSessionFile,
      rollbackForkSessionFile,
    });
    harnessHolder.harness = harness;
    const events = await collect(harness.session.execute(createRequest()).events);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([expect.objectContaining({ type: 'cancelled' })]);
    await expect(disposePromise).rejects.toThrow('fork rollback failed');
    expect(rollbackForkSessionFile).toHaveBeenCalledTimes(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      providerState: {
        forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
        forkSourceSessionFile: '/tmp/source.jsonl',
      },
      status: 'disposed',
    });
  });

  it('materializes a file fork before launching Pi', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-execution-fork-'));
    const sourceFile = path.join(tempDir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ cwd: '/source', id: 'source-session', type: 'session', version: 3 }),
      JSON.stringify({
        id: 'user-1',
        message: { content: 'Question', role: 'user' },
        parentId: null,
        type: 'message',
      }),
      JSON.stringify({
        id: 'assistant-1',
        message: { content: 'Answer', role: 'assistant' },
        parentId: 'user-1',
        type: 'message',
      }),
    ].join('\n'));
    const harness = createHarness(createConfig({
      resumeSeed: {
        providerState: {
          forkSource: {
            resumeAt: 'assistant-1',
            sessionId: 'source-session',
          },
          forkSourceSessionFile: sourceFile,
          futureState: { retained: true },
        },
      },
      vaultWorkingDirectory: tempDir,
    }), kernel => {
      harness.responses.set('get_state', {
        sessionFile: kernel.launchSpec.sessionTarget,
      });
    });
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await waitFor(() => harness.kernels.length === 1);
    const sessionTargetIndex = harness.kernels[0].launchSpec.args.indexOf('--session') + 1;
    const forkFile = harness.kernels[0].launchSpec.args[sessionTargetIndex];
    harness.responses.set('get_state', {
      leafEntryId: 'assistant-1',
      parentSession: sourceFile,
      sessionFile: forkFile,
      sessionId: 'fork-session',
    });
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;

    expect(forkFile).not.toBe(sourceFile);
    expect(path.dirname(forkFile)).toBe(tempDir);
    expect(await fs.readFile(forkFile, 'utf8')).toContain(
      `"parentSession":"${sourceFile}"`,
    );
    const snapshot = harness.session.getSnapshot();
    expect(snapshot.providerState).toMatchObject({
      futureState: { retained: true },
      sessionFile: forkFile,
    });
    expect(snapshot.providerState).not.toHaveProperty('forkSource');
    expect(snapshot.providerState).not.toHaveProperty('forkSourceSessionFile');
    expect(snapshot.providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionFile',
    ]);

    const continuedRun = harness.session.execute(createRequest({
      input: [{ text: 'Continue after fork', type: 'text' }],
    }));
    const continuedEventsPromise = collect(continuedRun.events);
    await waitFor(() => getPromptMessages(harness.kernels[0]).length === 2);
    harness.kernels[0].emit({ type: 'agent_start' });
    harness.kernels[0].emit({ type: 'agent_end' });
    await continuedEventsPromise;
    expect(harness.kernels).toHaveLength(1);
    expect(harness.session.getSnapshot().providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionFile',
    ]);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it('cancels extension UI when no renderer is available to an auxiliary session', async () => {
    const harness = createHarness(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
    }));
    const run = harness.session.execute(createRequest());
    const eventsPromise = collect(run.events);
    await flush();
    harness.kernels[0].emit({
      id: 'extension-1',
      method: 'select',
      type: 'extension_ui_request',
    });
    harness.kernels[0].emit({ type: 'agent_end' });
    await eventsPromise;

    expect(harness.kernels[0].sent).toContainEqual({
      cancelled: true,
      id: 'extension-1',
      type: 'extension_ui_response',
    });
  });

  it('does not rebuild continuity after disposal by a forced transition', async () => {
    const harness = createHarness(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
    }));
    await harness.session.dispose();

    expect(() => harness.session.execute(createRequest())).toThrow(
      'Pi execution session is disposed',
    );
    expect(harness.kernels).toHaveLength(0);
  });
});
