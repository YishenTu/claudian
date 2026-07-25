import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AcpSubprocess } from '@/providers/acp';
import { KimiAuxQueryRunner } from '@/providers/kimi/runtime/KimiAuxQueryRunner';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpSubprocess: jest.fn(),
  };
});

const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;

type FakeProcess = {
  emitClose: (error?: Error) => void;
  emitStdout: (text: string) => void;
  getStderrSnapshot: jest.Mock;
  onClose: jest.Mock;
  shutdown: jest.Mock;
  start: jest.Mock;
  stdin: { end: jest.Mock; write: jest.Mock };
  stdout: { on: (event: string, listener: (chunk: Buffer | string) => void) => void };
};

function createFakeProcess(): FakeProcess {
  const closeListeners: Array<(error?: Error) => void> = [];
  const stdoutListeners: Array<(chunk: Buffer | string) => void> = [];
  return {
    emitClose(error?: Error) {
      for (const listener of closeListeners) listener(error);
    },
    emitStdout(text: string) {
      for (const listener of stdoutListeners) listener(Buffer.from(text));
    },
    getStderrSnapshot: jest.fn(() => ''),
    onClose: jest.fn((listener: (error?: Error) => void) => {
      closeListeners.push(listener);
    }),
    shutdown: jest.fn(async () => {}),
    start: jest.fn(),
    stdin: { end: jest.fn(), write: jest.fn() },
    stdout: {
      on: jest.fn((event: string, listener: (chunk: Buffer | string) => void) => {
        if (event === 'data') stdoutListeners.push(listener);
      }),
    },
  };
}

function makeHost(): ProviderHost {
  return {
    app: {
      vault: {
        adapter: { basePath: '/tmp/kimi-aux-vault' },
      },
    },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/kimi/bin/kimi'),
    manifest: { version: '2.0.39-test' },
    settings: {
      providerConfigs: {
        kimi: {
          enabled: true,
          environmentVariables: 'KIMI_PROFILE=test',
        },
      },
    },
  } as unknown as ProviderHost;
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('KimiAuxQueryRunner', () => {
  let process: FakeProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    process = createFakeProcess();
    MockAcpSubprocess.mockImplementation(() => process as unknown as AcpSubprocess);
  });

  it('runs kimi --print with text output and aggregates stdout', async () => {
    const runner = new KimiAuxQueryRunner(makeHost());
    const onTextChunk = jest.fn();

    const query = runner.query({
      onTextChunk,
      systemPrompt: 'Title prompt',
    }, 'Generate a title');
    await flushPromises();
    process.emitStdout('Kimi');
    process.emitStdout(' title');
    process.emitClose();

    await expect(query).resolves.toBe('Kimi title');
    expect(MockAcpSubprocess).toHaveBeenCalledWith({
      args: ['--print', '--output-format', 'text', '--final-message-only'],
      command: '/opt/kimi/bin/kimi',
      cwd: '/tmp/kimi-aux-vault',
      env: expect.objectContaining({ KIMI_PROFILE: 'test' }),
    });
    expect(process.start).toHaveBeenCalledTimes(1);
    expect(process.stdin.write).toHaveBeenCalledWith('Title prompt\n\nGenerate a title');
    expect(process.stdin.end).toHaveBeenCalledTimes(1);
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Kimi');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'Kimi title');
  });

  it('sends the bare prompt when no system prompt is supplied', async () => {
    const runner = new KimiAuxQueryRunner(makeHost());

    const query = runner.query({ systemPrompt: '   ' }, 'Plain prompt');
    await flushPromises();
    process.emitClose();

    await expect(query).resolves.toBe('');
    expect(process.stdin.write).toHaveBeenCalledWith('Plain prompt');
  });

  it('passes kimi:-scoped and raw auxiliary models through --model', async () => {
    const runner = new KimiAuxQueryRunner(makeHost());

    const scoped = runner.query({ model: 'kimi:kimi-k2,thinking', systemPrompt: 's' }, 'p');
    await flushPromises();
    expect(MockAcpSubprocess).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ['--print', '--output-format', 'text', '--final-message-only', '--model', 'kimi-k2,thinking'],
    }));
    process.emitClose();
    await scoped;

    const raw = runner.query({ model: 'kimi-k2', systemPrompt: 's' }, 'p');
    await flushPromises();
    expect(MockAcpSubprocess).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ['--print', '--output-format', 'text', '--final-message-only', '--model', 'kimi-k2'],
    }));
    process.emitClose();
    await raw;

    const unset = runner.query({ model: undefined, systemPrompt: 's' }, 'p');
    await flushPromises();
    expect(MockAcpSubprocess).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ['--print', '--output-format', 'text', '--final-message-only'],
    }));
    process.emitClose();
    await unset;
  });

  it('rejects with the close error and stderr snapshot when the process fails', async () => {
    process.getStderrSnapshot.mockReturnValue('auth expired');
    const runner = new KimiAuxQueryRunner(makeHost());

    const query = runner.query({ systemPrompt: 's' }, 'p');
    await flushPromises();
    process.emitClose(new Error('kimi exited with code 1'));

    await expect(query).rejects.toThrow('kimi exited with code 1\n\nauth expired');
  });

  it('rejects a pre-aborted query without spawning a process', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const runner = new KimiAuxQueryRunner(makeHost());

    await expect(runner.query({
      abortController,
      systemPrompt: 's',
    }, 'p')).rejects.toThrow('Cancelled');
    expect(MockAcpSubprocess).not.toHaveBeenCalled();
  });

  it('shuts the process down when the query is aborted mid-run', async () => {
    const abortController = new AbortController();
    const runner = new KimiAuxQueryRunner(makeHost());

    const query = runner.query({ abortController, systemPrompt: 's' }, 'p');
    await flushPromises();
    abortController.abort();
    process.emitClose();

    await expect(query).rejects.toThrow('Cancelled');
    expect(process.shutdown).toHaveBeenCalledTimes(1);
  });

  it('reset shuts down the active process and is safe without one', async () => {
    const runner = new KimiAuxQueryRunner(makeHost());

    const query = runner.query({ systemPrompt: 's' }, 'p');
    await flushPromises();
    runner.reset();
    expect(process.shutdown).toHaveBeenCalledTimes(1);
    process.emitClose();
    await query;

    expect(() => runner.reset()).not.toThrow();
    expect(process.shutdown).toHaveBeenCalledTimes(1);
  });
});
