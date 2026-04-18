import type { ChildProcess } from 'child_process';
import { EventEmitter, Readable, Writable } from 'stream';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';

import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import type { CodexLaunchSpec } from '@/providers/codex/runtime/codexLaunchTypes';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createLaunchSpec(overrides: Partial<CodexLaunchSpec> = {}): CodexLaunchSpec {
  return {
    target: {
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
    command: '/usr/bin/codex',
    args: ['app-server', '--listen', 'stdio://'],
    spawnCwd: '/workspace',
    targetCwd: '/workspace',
    env: {},
    pathMapper: {
      target: {
        method: 'host-native',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
      toTargetPath: jest.fn(),
      toHostPath: jest.fn(),
      mapTargetPathList: jest.fn(),
      canRepresentHostPath: jest.fn(),
    },
    ...overrides,
  };
}

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as any).stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
  (proc as any).stdout = new Readable({ read() {} });
  (proc as any).stderr = new Readable({ read() {} });
  (proc as any).pid = 12345;
  (proc as any).killed = false;
  (proc as any).kill = jest.fn().mockReturnValue(true);
  return proc;
}

describe('CodexAppServerProcess', () => {
  const originalPlatform = process.platform;
  let mockProc: ChildProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('spawn', () => {
    it('spawns codex app-server with correct arguments', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/codex',
        ['app-server', '--listen', 'stdio://'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: '/workspace',
        }),
      );
    });

    it('wraps Windows .cmd shims through cmd.exe and quotes shell metacharacters', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const server = new CodexAppServerProcess(createLaunchSpec({
        command: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\codex.cmd',
      }));
      server.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        process.env.ComSpec || process.env.comspec || 'cmd.exe',
        ['/d', '/s', '/c', '""C:\\Users\\R&D\\AppData\\Roaming\\npm\\codex.cmd" app-server --listen stdio://"'],
        expect.objectContaining({
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );
    });

    it('passes environment variables to the spawned process', () => {
      const env = { OPENAI_API_KEY: 'sk-test', PATH: '/usr/bin' };
      const server = new CodexAppServerProcess(createLaunchSpec({ env }));
      server.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/codex',
        ['app-server', '--listen', 'stdio://'],
        expect.objectContaining({
          env,
        }),
      );
    });
  });

  describe('stdio accessors', () => {
    it('exposes stdin, stdout, and stderr from the spawned process', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      expect(server.stdin).toBe(mockProc.stdin);
      expect(server.stdout).toBe(mockProc.stdout);
      expect(server.stderr).toBe(mockProc.stderr);
    });

    it('throws when accessing stdio before start', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());

      expect(() => server.stdin).toThrow();
      expect(() => server.stdout).toThrow();
      expect(() => server.stderr).toThrow();
    });
  });

  describe('isAlive', () => {
    it('returns true when process is running', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      expect(server.isAlive()).toBe(true);
    });

    it('returns false before start', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());

      expect(server.isAlive()).toBe(false);
    });

    it('returns false after process exits', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      mockProc.emit('exit', 0, null);

      expect(server.isAlive()).toBe(false);
    });
  });

  describe('onExit', () => {
    it('calls registered exit callback when process exits', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      const exitCallback = jest.fn();
      server.onExit(exitCallback);
      server.start();

      mockProc.emit('exit', 1, 'SIGTERM');

      expect(exitCallback).toHaveBeenCalledWith(1, 'SIGTERM');
    });

    it('calls exit callback registered after start', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      const exitCallback = jest.fn();
      server.onExit(exitCallback);

      mockProc.emit('exit', 0, null);

      expect(exitCallback).toHaveBeenCalledWith(0, null);
    });
  });

  describe('shutdown', () => {
    it('sends SIGTERM to the process', async () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      const shutdownPromise = server.shutdown();
      mockProc.emit('exit', 0, 'SIGTERM');
      await shutdownPromise;

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL if process does not exit within timeout', async () => {
      jest.useFakeTimers();
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      const shutdownPromise = server.shutdown();

      // Advance past the SIGKILL timeout
      jest.advanceTimersByTime(5_000);

      // Now simulate exit after SIGKILL
      mockProc.emit('exit', 137, 'SIGKILL');
      await shutdownPromise;

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

      jest.useRealTimers();
    });

    it('resolves immediately if process is not running', async () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      await server.shutdown();
      expect(server.isAlive()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('marks process as not alive on spawn error', () => {
      const server = new CodexAppServerProcess(createLaunchSpec());
      server.start();

      mockProc.emit('error', new Error('spawn failed'));

      expect(server.isAlive()).toBe(false);
    });
  });
});
