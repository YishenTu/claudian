import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import fixture from '@test/fixtures/providers/grok/extensions/plan-mode-hook.json';
import spawn from 'cross-spawn';

import { AcpJsonRpcTransport } from '@/providers/acp';
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
  let native: AcpJsonRpcTransport;
  let connection: GrokExecutionNativeConnectionImpl;

  beforeEach(() => {
    const proc = createNativeProcess();
    native = new AcpJsonRpcTransport({ input: proc.stdin, output: proc.stdout });
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
