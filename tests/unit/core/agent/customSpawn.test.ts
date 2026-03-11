import { spawn } from 'child_process';

import { type GeminiSpawnOptions,spawnGeminiCli } from '@/core/agent/customSpawn';
import * as env from '@/utils/env';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('spawnGeminiCli', () => {
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

  afterEach(() => {
    jest.restoreAllMocks();
    spawnMock.mockReset();
  });

  const createMockProcess = () => {
    const stderr = { on: jest.fn() } as unknown as NodeJS.ReadableStream;
    return {
      stdin: {} as NodeJS.WritableStream,
      stdout: {} as NodeJS.ReadableStream,
      stderr,
      killed: false,
      exitCode: null,
      kill: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      pid: 1234,
    };
  };

  it('spawns the CLI directly when cliPath is not a .js file', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const options: GeminiSpawnOptions = {
      cliPath: '/usr/local/bin/gemini',
      args: ['--output-format', 'stream-json'],
      cwd: '/tmp',
      env: {},
    };

    const result = spawnGeminiCli(options);

    expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/gemini', ['--output-format', 'stream-json'], expect.objectContaining({
      cwd: '/tmp',
    }));
    expect(result).toBe(mockProcess);
  });

  it('resolves node command for .js cliPath when available', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest
      .spyOn(env, 'findNodeExecutable')
      .mockReturnValue('/custom/node');

    const options: GeminiSpawnOptions = {
      cliPath: '/path/to/cli.js',
      args: ['--prompt', 'hello'],
      cwd: '/tmp',
      env: {},
      enhancedPath: '/enhanced/path',
    };

    const result = spawnGeminiCli(options);

    expect(findNodeExecutable).toHaveBeenCalledWith('/enhanced/path');
    expect(spawnMock).toHaveBeenCalledWith('/custom/node', ['/path/to/cli.js', '--prompt', 'hello'], expect.objectContaining({
      cwd: '/tmp',
    }));
    expect(result).toBe(mockProcess);
  });

  it('falls back to "node" when findNodeExecutable returns null for .js cliPath', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);

    const options: GeminiSpawnOptions = {
      cliPath: '/path/to/cli.js',
      args: ['--prompt', 'hello'],
      cwd: '/tmp',
      env: {},
    };

    spawnGeminiCli(options);

    expect(spawnMock).toHaveBeenCalledWith('node', ['/path/to/cli.js', '--prompt', 'hello'], expect.any(Object));
  });

  it('does not resolve node for non-.js cliPath', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest.spyOn(env, 'findNodeExecutable');

    const options: GeminiSpawnOptions = {
      cliPath: '/usr/local/bin/gemini',
      args: [],
      cwd: '/tmp',
      env: {},
    };

    spawnGeminiCli(options);

    expect(findNodeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/gemini', [], expect.any(Object));
  });

  it('passes signal to spawn options', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const abortController = new AbortController();
    const options: GeminiSpawnOptions = {
      cliPath: '/usr/local/bin/gemini',
      args: [],
      cwd: '/tmp',
      env: {},
      signal: abortController.signal,
    };

    spawnGeminiCli(options);

    const spawnOptions = spawnMock.mock.calls[0][2];
    expect(spawnOptions.signal).toBe(abortController.signal);
  });

  it('uses pipe for all stdio channels', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    spawnGeminiCli({
      cliPath: '/usr/local/bin/gemini',
      args: [],
      cwd: '/tmp',
      env: {},
    });

    const spawnOptions = spawnMock.mock.calls[0][2];
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('uses PATH from env when enhancedPath is not provided for .js cliPath', () => {
    const mockProcess = createMockProcess();
    spawnMock.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    const findNodeExecutable = jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);

    spawnGeminiCli({
      cliPath: '/path/to/cli.js',
      args: [],
      cwd: '/tmp',
      env: { PATH: '/some/path' },
    });

    expect(findNodeExecutable).toHaveBeenCalledWith('/some/path');
  });
});
