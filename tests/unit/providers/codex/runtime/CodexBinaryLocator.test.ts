import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findCodexBinaryPath,
  resolveCodexCLIPath,
} from '@/providers/codex/runtime/CodexBinaryLocator';

describe('CodexBinaryLocator', () => {
  let tempDir: string;
  const originalEnvironment = {
    CODEX_INSTALL_DIR: process.env.CODEX_INSTALL_DIR,
    HOME: process.env.HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE,
  };

  function restoreEnvironmentVariable(
    name: keyof typeof originalEnvironment,
  ): void {
    const value = originalEnvironment[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  function createCompleteWindowsCodexRuntime(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const cliPath = path.join(dir, 'codex.exe');
    fs.writeFileSync(cliPath, '');
    fs.writeFileSync(path.join(dir, 'codex-code-mode-host.exe'), '');
    return cliPath;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binary-locator-'));
    process.env.PATH = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnvironmentVariable('CODEX_INSTALL_DIR');
    restoreEnvironmentVariable('HOME');
    restoreEnvironmentVariable('LOCALAPPDATA');
    restoreEnvironmentVariable('PATH');
    restoreEnvironmentVariable('USERPROFILE');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds a codex executable on PATH', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(findCodexBinaryPath(pathDir, process.platform)).toBe(pathBinary);
  });

  it('finds a Windows codex.cmd shim on PATH', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, 'codex.cmd');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(findCodexBinaryPath(pathDir, 'win32')).toBe(pathBinary);
  });

  it('finds a complete Codex install from CODEX_INSTALL_DIR on Windows', () => {
    const installDir = path.join(tempDir, 'custom-codex-install');
    const cliPath = createCompleteWindowsCodexRuntime(installDir);
    process.env.CODEX_INSTALL_DIR = installDir;
    process.env.LOCALAPPDATA = path.join(tempDir, 'empty-local-app-data');

    expect(findCodexBinaryPath('', 'win32')).toBe(cliPath);
  });

  it('finds the default standalone Codex install on Windows', () => {
    process.env.LOCALAPPDATA = tempDir;
    delete process.env.CODEX_INSTALL_DIR;
    const installDir = path.join(tempDir, 'Programs', 'OpenAI', 'Codex', 'bin');
    const cliPath = createCompleteWindowsCodexRuntime(installDir);

    expect(findCodexBinaryPath('', 'win32')).toBe(cliPath);
  });

  it('finds the newest complete Codex desktop runtime on Windows', () => {
    process.env.LOCALAPPDATA = tempDir;
    delete process.env.CODEX_INSTALL_DIR;
    const runtimeRoot = path.join(tempDir, 'OpenAI', 'Codex', 'bin');
    const olderCompleteDir = path.join(runtimeRoot, 'older-complete-runtime');
    const olderCompleteCliPath = createCompleteWindowsCodexRuntime(olderCompleteDir);
    const newerCompleteDir = path.join(runtimeRoot, 'newer-complete-runtime');
    const newerCompleteCliPath = createCompleteWindowsCodexRuntime(newerCompleteDir);
    const incompleteDir = path.join(runtimeRoot, 'newer-incomplete-runtime');
    fs.mkdirSync(incompleteDir, { recursive: true });
    const incompleteCliPath = path.join(incompleteDir, 'codex.exe');
    fs.writeFileSync(incompleteCliPath, '');
    fs.utimesSync(
      olderCompleteCliPath,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    fs.utimesSync(
      newerCompleteCliPath,
      new Date('2027-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );
    fs.utimesSync(
      incompleteCliPath,
      new Date('2028-01-01T00:00:00Z'),
      new Date('2028-01-01T00:00:00Z'),
    );

    expect(findCodexBinaryPath('', 'win32')).toBe(newerCompleteCliPath);
  });

  it('breaks equal desktop runtime timestamps by path regardless of directory enumeration order', () => {
    process.env.LOCALAPPDATA = tempDir;
    delete process.env.CODEX_INSTALL_DIR;
    const root = path.join(tempDir, 'OpenAI', 'Codex', 'bin');
    const first = createCompleteWindowsCodexRuntime(path.join(root, 'aaa'));
    const second = createCompleteWindowsCodexRuntime(path.join(root, 'bbb'));
    const timestamp = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(first, timestamp, timestamp);
    fs.utimesSync(second, timestamp, timestamp);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    entries.sort((left, right) => right.name.localeCompare(left.name));
    jest.spyOn(jest.requireActual<typeof fs>('fs'), 'readdirSync').mockReturnValueOnce(entries as never);

    expect(findCodexBinaryPath('', 'win32')).toBe(first);
  });

  it('honors configured files and quoted runtime PATH before a Windows desktop runtime', () => {
    process.env.LOCALAPPDATA = tempDir;
    delete process.env.CODEX_INSTALL_DIR;
    createCompleteWindowsCodexRuntime(path.join(tempDir, 'OpenAI', 'Codex', 'bin', 'hash'));
    const explicitDir = path.join(tempDir, 'my tools');
    fs.mkdirSync(explicitDir);
    const shim = path.join(explicitDir, 'codex.cmd');
    fs.writeFileSync(shim, '');
    const configured = path.join(tempDir, 'configured.exe');
    fs.writeFileSync(configured, '');
    const runtimePath = `"${path.join(tempDir, 'missing')}";"${explicitDir}"`;

    expect(findCodexBinaryPath(runtimePath, 'win32')).toBe(shim);
    expect(resolveCodexCLIPath(configured, '', `PATH=${runtimePath}`, {
      hostPlatform: 'win32',
    })).toBe(configured);
  });

  it('falls back from an incomplete install override to a complete desktop runtime', () => {
    process.env.LOCALAPPDATA = tempDir;
    const override = path.join(tempDir, 'incomplete');
    fs.mkdirSync(override);
    fs.writeFileSync(path.join(override, 'codex.exe'), '');
    process.env.CODEX_INSTALL_DIR = override;
    const desktop = createCompleteWindowsCodexRuntime(
      path.join(tempDir, 'OpenAI', 'Codex', 'bin', 'hash'),
    );

    expect(findCodexBinaryPath('', 'win32')).toBe(desktop);
  });

  it('prefers the macOS Codex app bundle over the ChatGPT app fallback', () => {
    process.env.HOME = tempDir;
    const appDir = path.join(tempDir, 'Applications', 'Codex.app', 'Contents', 'Resources');
    const appBinary = path.join(appDir, 'codex');
    const chatGptAppDir = path.join(
      tempDir,
      'Applications',
      'ChatGPT.app',
      'Contents',
      'Resources',
    );
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(chatGptAppDir, { recursive: true });
    fs.writeFileSync(appBinary, '');
    fs.writeFileSync(path.join(chatGptAppDir, 'codex'), '');

    expect(findCodexBinaryPath('', 'darwin')).toBe(appBinary);
  });

  it('falls back to the unified macOS ChatGPT app bundle', () => {
    process.env.HOME = tempDir;
    const appDir = path.join(tempDir, 'Applications', 'ChatGPT.app', 'Contents', 'Resources');
    const appBinary = path.join(appDir, 'codex');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(appBinary, '');

    expect(findCodexBinaryPath('', 'darwin')).toBe(appBinary);
  });

  it('prefers a user-local Codex binary over the ChatGPT app fallback', () => {
    process.env.HOME = tempDir;
    const localDir = path.join(tempDir, '.local', 'bin');
    const localBinary = path.join(localDir, 'codex');
    const appDir = path.join(tempDir, 'Applications', 'ChatGPT.app', 'Contents', 'Resources');
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(localBinary, '');
    fs.writeFileSync(path.join(appDir, 'codex'), '');

    expect(findCodexBinaryPath('', 'darwin')).toBe(localBinary);
  });

  it('honors an explicit runtime PATH before preferred macOS Codex locations', () => {
    process.env.HOME = tempDir;
    const explicitDir = path.join(tempDir, 'explicit-bin');
    const explicitBinary = path.join(explicitDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    const appDir = path.join(tempDir, 'Applications', 'Codex.app', 'Contents', 'Resources');
    fs.mkdirSync(explicitDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(explicitBinary, '');
    fs.writeFileSync(path.join(appDir, 'codex'), '');

    expect(findCodexBinaryPath(explicitDir, process.platform)).toBe(explicitBinary);
  });

  it('prefers a user-local Codex binary before generic Unix PATH auto-detection', () => {
    process.env.HOME = tempDir;
    const localDir = path.join(tempDir, '.local', 'bin');
    const localBinary = path.join(localDir, 'codex');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(localBinary, '');

    expect(findCodexBinaryPath('', 'linux')).toBe(localBinary);
  });

  it('prefers a hostname-specific configured path', () => {
    const hostnamePath = path.join(tempDir, 'hostname-codex');
    const legacyPath = path.join(tempDir, 'legacy-codex');
    fs.writeFileSync(hostnamePath, '');
    fs.writeFileSync(legacyPath, '');

    expect(resolveCodexCLIPath(hostnamePath, legacyPath, '')).toBe(hostnamePath);
  });

  it('falls back to a legacy configured path', () => {
    const legacyPath = path.join(tempDir, 'legacy-codex');
    fs.writeFileSync(legacyPath, '');

    expect(resolveCodexCLIPath('', legacyPath, '')).toBe(legacyPath);
  });

  it('falls back to PATH lookup when no configured file exists', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(resolveCodexCLIPath('', '', `PATH=${pathDir}`)).toBe(pathBinary);
  });

  it('uses the configured Linux command directly in WSL mode', () => {
    expect(resolveCodexCLIPath(
      'codex',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });

  it('strips matching surrounding quotes from configured Linux commands in WSL mode', () => {
    expect(resolveCodexCLIPath(
      '"/home/user/my tools/codex"',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('/home/user/my tools/codex');
    expect(resolveCodexCLIPath(
      "'/home/user/codex'",
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('/home/user/codex');
  });

  it('keeps Linux-side home and environment references literal in WSL mode', () => {
    const originalRoot = process.env.TEST_WSL_CODEX_ROOT;
    process.env.TEST_WSL_CODEX_ROOT = 'C:\\host-tools';
    try {
      expect(resolveCodexCLIPath(
        '"~/tools/codex"',
        '',
        '',
        { installationMethod: 'wsl', hostPlatform: 'win32' },
      )).toBe('~/tools/codex');
      expect(resolveCodexCLIPath(
        '"$TEST_WSL_CODEX_ROOT/bin/codex"',
        '',
        '',
        { installationMethod: 'wsl', hostPlatform: 'win32' },
      )).toBe('$TEST_WSL_CODEX_ROOT/bin/codex');
    } finally {
      if (originalRoot === undefined) {
        delete process.env.TEST_WSL_CODEX_ROOT;
      } else {
        process.env.TEST_WSL_CODEX_ROOT = originalRoot;
      }
    }
  });

  it('falls back to the default Linux command in WSL mode', () => {
    expect(resolveCodexCLIPath(
      '',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });

  it('ignores a Windows-native CLI path in WSL mode and falls back to the Linux command', () => {
    expect(resolveCodexCLIPath(
      'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });

  it('ignores a quoted Windows path and selects a quoted legacy Linux command in WSL mode', () => {
    expect(resolveCodexCLIPath(
      '"C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe"',
      '"/home/user/legacy tools/codex"',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('/home/user/legacy tools/codex');
  });

  it('ignores a quoted Windows-native CLI path in WSL mode and uses the default command', () => {
    expect(resolveCodexCLIPath(
      '"C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe"',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });
});
