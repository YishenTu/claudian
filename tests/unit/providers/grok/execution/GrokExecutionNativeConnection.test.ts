import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { getHostnameKey } from '@/utils/env';

jest.mock('cross-spawn', () => jest.fn());

import fixture from '@test/fixtures/providers/grok/extensions/plan-mode-hook.json';
import spawn from 'cross-spawn';

import { isSteerableExecutionSession, type ProviderExecutionEvent, type ProviderExecutionRequest } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ACPJSONRPCTransport } from '@/providers/acp';
import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';
import { GrokExecutionNativeConnectionImpl } from '@/providers/grok/execution/GrokExecutionNativeConnection';

function createNativeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    pid: 12345,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => {
      proc.exitCode = 0;
      proc.killed = true;
      proc.emit('exit', 0, null);
      return true;
    },
  });
  jest.mocked(spawn).mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
  return proc;
}

describe('GrokExecutionNativeConnection', () => {
  let native: ACPJSONRPCTransport;
  let connection: GrokExecutionNativeConnectionImpl;

  beforeEach(() => {
    const proc = createNativeProcess();
    native = new ACPJSONRPCTransport({ input: proc.stdin, output: proc.stdout });
    native.onRequest('initialize', () => fixture.initializeResult);
    native.start();
    connection = new GrokExecutionNativeConnectionImpl({
      command: '/opt/grok',
      cwd: '/vault',
      env: {},
      requestExtension: async () => { throw new Error('Unexpected UI extension'); },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      version: 'test',
    });
  });

  afterEach(async () => {
    await connection.shutdown();
    native.dispose();
  });

  it.each(['x.ai/session/interjection', '_x.ai/session/interjection'])(
    'forwards native interjection application through %s', async method => {
      const notifications: unknown[] = [];
      const unsubscribe = connection.onInterjection(notification => notifications.push(notification));
      await connection.initialize();
      native.notify(method, { sessionId: 'session', interjectionId: 'redirect' });
      await native.flush();
      await new Promise(resolve => setImmediate(resolve));
      expect(notifications).toEqual([{ sessionId: 'session', interjectionId: 'redirect' }]);
      unsubscribe();
    },
  );

  it('registers native plan blocking without replacing session configuration', async () => {
    let received: unknown;
    native.onRequest('session/new', params => {
      received = params;
      return { sessionId: 'session-native' };
    });
    const request = {
      _meta: {
        modelId: 'grok-4.6',
        systemPromptOverride: 'Keep these instructions.',
        yoloMode: true,
      },
      cwd: '/vault',
      mcpServers: [],
    };

    await connection.initialize();
    await connection.newSession(request);

    expect(received).toEqual({
      ...request,
      _meta: { ...request._meta, ...fixture.sessionMeta },
    });
    await expect(native.request(fixture.request.method, fixture.request.params)).resolves.toEqual({
      decision: 'deny',
      systemMessage: 'Plan mode is unavailable in Claudian. Continue in normal mode.',
    });
    expect(request._meta).toEqual({
      modelId: 'grok-4.6',
      systemPromptOverride: 'Keep these instructions.',
      yoloMode: true,
    });
  });

  it.each(['_x.ai/hooks/run', 'x.ai/hooks/run'])(
    'rebinds hooks on load and denies late child callbacks through %s',
    async method => {
      let received: unknown;
      native.onRequest('session/load', params => {
        received = params;
        return {};
      });
      const request = {
        _meta: { systemPromptOverride: 'Resumed instructions.', yoloMode: true },
        cwd: '/vault',
        mcpServers: [],
        sessionId: 'session-existing',
      };

      await connection.initialize();
      await connection.loadSession(request);
      connection.cancel(request.sessionId);

      expect(received).toEqual({
        ...request,
        _meta: { ...request._meta, ...fixture.sessionMeta },
      });
      await expect(native.request(method, {
        ...fixture.request.params,
        permissionMode: 'bypassPermissions',
        sessionId: 'session-child',
        toolName: 'exit_plan_mode',
      })).resolves.toEqual({
        decision: 'deny',
        systemMessage: 'Plan mode is unavailable in Claudian. Continue in normal mode.',
      });
    },
  );

  it('denies malformed hook callbacks instead of returning a fail-open protocol error', async () => {
    await connection.initialize();

    await expect(native.request('_x.ai/hooks/run', null)).resolves.toMatchObject({ decision: 'deny' });
  });

  it.each([
    undefined,
    { blockingEvents: ['pre_tool_use'], decisions: ['continue'] },
    { blockingEvents: ['stop'], decisions: ['deny'] },
    { blockingEvents: 'pre_tool_use', decisions: 'deny' },
  ])('rejects runtimes without blocking pre-tool hooks', async hooks => {
    native.onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { _meta: { 'x.ai/hooks': hooks } },
    }));

    await expect(connection.initialize()).rejects.toThrow(
      'Grok does not support blocking tool hooks. Update Grok to the latest version.',
    );
  });

});

it.each([false, true])('terminates on native exit after prompt settled: %s', async settled => {
  const proc = createNativeProcess();
  const native = new ACPJSONRPCTransport({ input: proc.stdin, output: proc.stdout });
  let resolvePrompt!: (value: { stopReason: string }) => void;
  const prompt = new Promise<{ stopReason: string }>(resolve => { resolvePrompt = resolve; });
  let started = false;
  native.onRequest('initialize', () => fixture.initializeResult);
  native.onRequest('session/new', () => ({ sessionId: 'session' }));
  native.onRequest('session/set_mode', () => ({}));
  native.onRequest('session/prompt', () => { started = true; return prompt; });
  native.onRequest('_x.ai/interject', () => ({ result: { status: 'queued' } }));
  native.start();
  const session = new GrokExecutionBackend({ settings: { model: 'grok/grok-4', providerConfigs: { grok: { enabled: true, visibleModels: ['grok-4'], selectedModelsByHost: { [getHostnameKey()]: { fingerprint: 'test', refreshedAt: 1, defaultModelId: 'grok-4', models: [{ rawId: 'grok-4', displayName: 'Grok 4', supportsReasoning: false, reasoningEfforts: [] }] } } } } } } as unknown as ProviderHost, {
    nativeFactory: { create: options => new GrokExecutionNativeConnectionImpl(options) },
  }).createSession({
    vaultWorkingDirectory: '/tmp', lifecycle: 'persistent', nativePersistence: 'enabled',
    interactionPort: { askUserQuestion: jest.fn(), dismissInteraction: jest.fn(), requestApproval: jest.fn() },
  });
  const request: ProviderExecutionRequest = {
    configuration: { permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Answer.' } },
    input: [{ type: 'text', text: 'hello' }], signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
  const events: ProviderExecutionEvent[] = [];
  const collection = (async () => { for await (const event of session.execute(request).events) events.push(event); })();
  try {
    for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setImmediate(resolve));
    expect(started).toBe(true);
    if (!isSteerableExecutionSession(session)) throw new Error('No steering');
    await session.steer(request);
    if (settled) {
      resolvePrompt({ stopReason: 'end_turn' });
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    }
    proc.kill();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'transport', recoverable: true });
    await collection;
  } finally {
    await session.dispose();
    await collection;
    native.dispose();
  }
});
