import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { createCustomSpawnFunction } from '@/core/agent/customSpawn';
import * as env from '@/utils/env';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('createCustomSpawnFunction', () => {
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
});
