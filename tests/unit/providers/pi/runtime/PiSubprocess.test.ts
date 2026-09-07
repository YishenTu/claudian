import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import { PiSubprocess } from '@/providers/pi/runtime/PiSubprocess';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createMockProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 12345;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = signal === 'SIGKILL';
    return true;
  });
  return proc;
}

describe('PiSubprocess', () => {
  const originalPlatform = process.platform;
  let proc: any;
  let windowsNpmPrefix: string;
  let windowsAbsolutePiCommand: string;
  let windowsMalformedCommands: string[];
  let windowsPackageRoot: string;
  let windowsPiBin: string;
  let windowsPiCommand: string;
  let windowsPnpmBin: string;
  let windowsPnpmCommand: string;
  let windowsUnownedCommand: string;
  let windowsUnknownCommand: string;
  let windowsYarnBin: string;
  let windowsYarnCommand: string;

  beforeAll(async () => {
    windowsNpmPrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-windows-launch-'));
    windowsPackageRoot = path.join(
      windowsNpmPrefix,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    );
    windowsPiBin = path.join(windowsPackageRoot, 'dist', 'bundle', 'cli.js');
    windowsPiCommand = path.join(windowsNpmPrefix, 'pi.cmd');
    await fs.mkdir(path.dirname(windowsPiBin), { recursive: true });
    await fs.writeFile(windowsPiBin, '#!/usr/bin/env node\n');
    await fs.writeFile(path.join(windowsPackageRoot, 'package.json'), JSON.stringify({
      bin: { pi: 'dist/bundle/cli.js' },
      name: '@earendil-works/pi-coding-agent',
    }));
    await fs.writeFile(windowsPiCommand, createWindowsCommandShim(
      windowsPiCommand,
      windowsPiBin,
    ));
    windowsAbsolutePiCommand = path.join(windowsNpmPrefix, 'absolute-bin', 'pi.cmd');
    await fs.mkdir(path.dirname(windowsAbsolutePiCommand), { recursive: true });
    await fs.writeFile(
      windowsAbsolutePiCommand,
      `@ECHO off\r\nnode "${windowsPiBin}" %*\r\n`,
    );

    const pnpmPackageRoot = path.join(
      windowsNpmPrefix,
      'global',
      '5',
      '.pnpm',
      '@earendil-works+pi-coding-agent@0.84.3',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    );
    windowsPnpmBin = path.join(pnpmPackageRoot, 'dist', 'bundle', 'cli.js');
    windowsPnpmCommand = path.join(windowsNpmPrefix, 'pnpm-bin', 'pi.cmd');
    await writePiPackage(pnpmPackageRoot, windowsPnpmBin);
    await fs.mkdir(path.dirname(windowsPnpmCommand), { recursive: true });
    await fs.writeFile(windowsPnpmCommand, createWindowsCommandShim(
      windowsPnpmCommand,
      windowsPnpmBin,
    ));

    const yarnPackageRoot = path.join(
      windowsNpmPrefix,
      'Yarn',
      'Data',
      'global',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    );
    windowsYarnBin = path.join(yarnPackageRoot, 'dist', 'bundle', 'cli.js');
    windowsYarnCommand = path.join(windowsNpmPrefix, 'Yarn', 'bin', 'pi.cmd');
    await writePiPackage(yarnPackageRoot, windowsYarnBin);
    await fs.mkdir(path.dirname(windowsYarnCommand), { recursive: true });
    await fs.writeFile(windowsYarnCommand, createWindowsCommandShim(
      windowsYarnCommand,
      windowsYarnBin,
    ));

    const unownedBin = path.join(windowsNpmPrefix, 'unowned', 'cli.js');
    windowsUnownedCommand = path.join(windowsNpmPrefix, 'unowned-bin', 'pi.cmd');
    await fs.mkdir(path.dirname(unownedBin), { recursive: true });
    await fs.mkdir(path.dirname(windowsUnownedCommand), { recursive: true });
    await fs.writeFile(unownedBin, '#!/usr/bin/env node\n');
    await fs.writeFile(windowsUnownedCommand, createWindowsCommandShim(
      windowsUnownedCommand,
      unownedBin,
    ));

    windowsUnknownCommand = path.join(windowsNpmPrefix, 'unknown-bin', 'pi.cmd');
    await fs.mkdir(path.dirname(windowsUnknownCommand), { recursive: true });
    await fs.writeFile(windowsUnknownCommand, '@ECHO off\r\nunknown-wrapper %*\r\n');

    const malformedDir = path.join(windowsNpmPrefix, 'malformed-bin');
    await fs.mkdir(malformedDir, { recursive: true });
    windowsMalformedCommands = await Promise.all([
      (target: string) => `REM ${target}`,
      (target: string) => `unknown-wrapper & node ${target}`,
      (target: string) => `call ${target}`,
    ].map(async (buildContents, index) => {
      const command = path.join(malformedDir, String(index), 'pi.cmd');
      await fs.mkdir(path.dirname(command), { recursive: true });
      await fs.writeFile(
        command,
        `${buildContents(createWindowsCommandTarget(command, windowsPiBin))}\r\n`,
      );
      return command;
    }));
  });

  afterAll(async () => {
    await fs.rm(windowsNpmPrefix, { force: true, recursive: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.useRealTimers();
  });

  it('spawns Pi RPC with the launch spec args, cwd, stdio, and enhanced PATH', () => {
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: '/opt/pi/bin/pi',
      cwd: '/vault',
      env: { PATH: '/usr/bin' },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/pi/bin/pi', ['--mode', 'rpc'], expect.objectContaining({
      cwd: '/vault',
      stdio: 'pipe',
      windowsHide: true,
      env: expect.objectContaining({
        PATH: expect.stringContaining('/usr/bin'),
      }),
    }));
  });

  it('launches the Pi package entry directly for Windows npm shims', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new PiSubprocess({
      args: [
        '--mode',
        'rpc',
        '--system-prompt',
        'First line\nUse R&D policy',
        '--session',
        'D:\\文档\\Pi Sessions\\session.jsonl',
      ],
      command: windowsPiCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/node(?:\.exe)?$/i),
      [
        windowsPiBin,
        '--mode',
        'rpc',
        '--system-prompt',
        'First line\nUse R&D policy',
        '--session',
        'D:\\文档\\Pi Sessions\\session.jsonl',
      ],
      expect.objectContaining({
        cwd: 'C:\\Vault',
        windowsHide: true,
      }),
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      process.env.ComSpec || process.env.comspec || 'cmd.exe',
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails closed when a Windows Pi shim targets an unowned script', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new PiSubprocess({
      args: ['--mode', 'rpc', '--system-prompt', 'First line\nSecond line'],
      command: windowsUnownedCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    })).toThrow('could not be resolved to its Node.js entry point');
  });

  it('does not replace an unknown Windows shim with PI_PACKAGE_DIR', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new PiSubprocess({
      args: ['--mode', 'rpc', '--system-prompt', 'First line\nSecond line'],
      command: windowsUnknownCommand,
      cwd: 'C:\\Vault',
      env: {
        PATH: process.env.PATH,
        PI_PACKAGE_DIR: windowsPackageRoot,
      },
    })).toThrow('could not be resolved to its Node.js entry point');
  });

  it.each([
    ['commented', 0],
    ['prefixed', 1],
    ['malformed', 2],
  ])('rejects a %s owned-bin reference in an unsupported shim layout', (
    _layout,
    commandIndex,
  ) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: windowsMalformedCommands[commandIndex],
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    })).toThrow('could not be resolved to its Node.js entry point');
  });

  it.each([
    ['pnpm', () => windowsPnpmCommand, () => windowsPnpmBin],
    ['Yarn', () => windowsYarnCommand, () => windowsYarnBin],
    ['cross-volume', () => windowsAbsolutePiCommand, () => windowsPiBin],
  ])('resolves the package entry referenced by a %s Windows shim', (
    _packageManager,
    getCommand,
    getBin,
  ) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc', '--system-prompt', 'First line\nSecond line'],
      command: getCommand(),
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/node(?:\.exe)?$/i),
      [getBin(), '--mode', 'rpc', '--system-prompt', 'First line\nSecond line'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('kills the process tree when shutting down a direct Windows Pi launch', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: windowsPiCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });
    subprocess.start();

    const shutdown = subprocess.shutdown();

    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(proc.kill).not.toHaveBeenCalled();

    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    await shutdown;
  });

  it('keeps a bounded stderr snapshot for runtime errors', () => {
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    proc.stderr.emit('data', 'a'.repeat(9_000));

    expect(subprocess.getStderrSnapshot()).toHaveLength(8_000);
  });

  it('notifies close listeners and escalates shutdown after timeout', async () => {
    jest.useFakeTimers();
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    const onClose = jest.fn();
    subprocess.onClose(onClose);
    subprocess.start();

    const shutdown = subprocess.shutdown();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    jest.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    proc.exitCode = 1;
    proc.emit('exit', 1, 'SIGKILL');
    await shutdown;

    expect(onClose).toHaveBeenCalledWith(expect.any(Error));
  });

  it('settles after a final deadline when no exit follows SIGKILL', async () => {
    jest.useFakeTimers();
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    const shutdown = subprocess.shutdown();
    jest.advanceTimersByTime(6_000);

    await expect(shutdown).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('shares one shutdown sequence across repeated calls', async () => {
    const subprocess = new PiSubprocess({
      args: ['--mode', 'rpc'],
      command: 'pi',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    const first = subprocess.shutdown();
    const second = subprocess.shutdown();
    expect(proc.kill).toHaveBeenCalledTimes(1);

    proc.exitCode = 0;
    proc.emit('exit', 0, 'SIGTERM');
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});

function createWindowsCommandShim(commandPath: string, targetPath: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ${createWindowsCommandTarget(commandPath, targetPath)}`,
    '',
  ].join('\r\n');
}

function createWindowsCommandTarget(commandPath: string, targetPath: string): string {
  const relativeTarget = path.relative(path.dirname(commandPath), targetPath)
    .split(path.sep)
    .join('\\');
  return `"%~dp0\\${relativeTarget}" %*`;
}

async function writePiPackage(packageRoot: string, binPath: string): Promise<void> {
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(binPath, '#!/usr/bin/env node\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    bin: { pi: path.relative(packageRoot, binPath) },
    name: '@earendil-works/pi-coding-agent',
  }));
}
