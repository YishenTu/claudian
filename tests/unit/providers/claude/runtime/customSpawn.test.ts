import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { createCustomSpawnFunction } from '@/providers/claude/runtime/customSpawn';
import * as env from '@/utils/env';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('createCustomSpawnFunction', () => {
  const originalPlatform = process.platform;
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.restoreAllMocks();
    spawnMock.mockReset();
  });

  const createMockProcess = () => {
    const stderr = { on: jest.fn() } as unknown as NodeJS.ReadableStream;
    return {
      stdin: {} as NodeJS.WritableStream,
      stdout: {} as NodeJS.ReadableStream,
      stderr,
      pid: 12345,
      killed: false,
      exitCode: null,
      kill: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
  };

  it('resolves node command to full path when available', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest
      .spyOn(env, 'findNodeExecutable')
      .mockReturnValue('/custom/node');

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    const options: SpawnOptions = {
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal,
    };

    const result = spawnFn(options);

    expect(findNodeExecutable).toHaveBeenCalledWith('/enhanced/path');
    expect(spawnMock).toHaveBeenCalledWith('/custom/node', ['cli.js'], expect.objectContaining({
      cwd: '/tmp',
    }));
    expect(result).toBe(mockProcess);
  });

  it('launches Node-backed script commands through node when SDK passes them directly', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest
      .spyOn(env, 'findNodeExecutable')
      .mockReturnValue('/custom/node');

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: '/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
      args: ['--output-format', 'stream-json'],
      cwd: '/tmp',
      env: {},
      signal,
    });

    expect(findNodeExecutable).toHaveBeenCalledWith('/enhanced/path');
    expect(spawnMock).toHaveBeenCalledWith(
      '/custom/node',
      ['/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs', '--output-format', 'stream-json'],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });

  it('falls back to node command for Node-backed scripts when node path resolution fails', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: '/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
      args: ['--output-format', 'stream-json'],
      cwd: '/tmp',
      env: {},
    } as SpawnOptions);

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs', '--output-format', 'stream-json'],
      expect.any(Object)
    );
  });

  it('pipes stderr only when DEBUG_CLAUDE_AGENT_SDK is set', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: { DEBUG_CLAUDE_AGENT_SDK: '1' },
      signal,
    });

    const spawnOptions = spawnMock.mock.calls[0][2];
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(mockProcess.stderr?.on).toHaveBeenCalledWith('data', expect.any(Function));
  });

  it('ignores stderr when DEBUG_CLAUDE_AGENT_SDK is not set', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal,
    });

    const spawnOptions = spawnMock.mock.calls[0][2];
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(mockProcess.stderr?.on).not.toHaveBeenCalled();
  });

  it('throws when process streams are missing', () => {
    const mockProcess = {
      stdin: null,
      stdout: null,
      stderr: null,
      killed: false,
      exitCode: null,
      kill: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;

    expect(() => spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal,
    })).toThrow('Failed to create process streams');
  });

  it('falls back to original command when findNodeExecutable returns null', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal,
    });

    // Should use 'node' as-is since findNodeExecutable returned null
    expect(spawnMock).toHaveBeenCalledWith('node', ['cli.js'], expect.any(Object));
  });

  it('does not resolve non-node commands', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest.spyOn(env, 'findNodeExecutable');

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: 'python',
      args: ['script.py'],
      cwd: '/tmp',
      env: {},
      signal,
    });

    expect(findNodeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith('python', ['script.py'], expect.any(Object));
  });

  it('wraps manually configured Windows .cmd commands through cmd.exe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest.spyOn(env, 'findNodeExecutable');

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Vault',
      env: {},
    } as SpawnOptions);

    expect(findNodeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      process.env.ComSpec || process.env.comspec || 'cmd.exe',
      ['/d', '/s', '/c', '""C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd" --output-format stream-json"'],
      expect.objectContaining({
        cwd: 'C:\\Vault',
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    );
  });

  it('kills the process tree when aborting manually configured Windows .cmd commands', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const mockProcess = createMockProcess();
    const originalKill = mockProcess.kill;
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();
    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Vault',
      env: {},
      signal: controller.signal,
    } as SpawnOptions);

    controller.abort();

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(originalKill).not.toHaveBeenCalled();
  });

  it('delegates returned Windows .cmd process kill to process-tree termination', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const mockProcess = createMockProcess();
    const originalKill = mockProcess.kill;
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const result = spawnFn({
      command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Vault',
      env: {},
    } as SpawnOptions);

    expect(result).toBe(mockProcess);
    expect(result.kill).not.toBe(originalKill);

    result.kill('SIGKILL');

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(originalKill).not.toHaveBeenCalled();
  });

  it('does not pass signal to spawn options', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    const signal = new AbortController().signal;
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal,
    });

    const spawnOptions = spawnMock.mock.calls[0][2];
    expect(spawnOptions).not.toHaveProperty('signal');
  });

  it('kills child immediately when signal is already aborted', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();
    controller.abort();

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal: controller.signal,
    });

    expect(mockProcess.kill).toHaveBeenCalled();
  });

  it('kills child when signal aborts after spawn', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
      signal: controller.signal,
    });

    expect(mockProcess.kill).not.toHaveBeenCalled();

    controller.abort();

    expect(mockProcess.kill).toHaveBeenCalled();
  });

  it('does not kill child when signal is not provided', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const spawnFn = createCustomSpawnFunction('/enhanced/path');
    spawnFn({
      command: 'node',
      args: ['cli.js'],
      cwd: '/tmp',
      env: {},
    } as SpawnOptions);

    expect(mockProcess.kill).not.toHaveBeenCalled();
  });
});
