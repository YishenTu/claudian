import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findCodexBinaryPath,
  resolveCodexCliPath,
} from '@/providers/codex/runtime/CodexBinaryLocator';

describe('CodexBinaryLocator', () => {
  let tempDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binary-locator-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds a codex executable on PATH', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, 'codex');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(findCodexBinaryPath(pathDir, 'darwin')).toBe(pathBinary);
  });

  it('finds a Windows codex.cmd shim on PATH', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, 'codex.cmd');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(findCodexBinaryPath(pathDir, 'win32')).toBe(pathBinary);
  });

  it('prefers the macOS Codex app bundle over generic PATH auto-detection', () => {
    process.env.HOME = tempDir;
    const appDir = path.join(tempDir, 'Applications', 'Codex.app', 'Contents', 'Resources');
    const appBinary = path.join(appDir, 'codex');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(appBinary, '');

    expect(findCodexBinaryPath('', 'darwin')).toBe(appBinary);
  });

  it('honors an explicit runtime PATH before preferred macOS Codex locations', () => {
    process.env.HOME = tempDir;
    const explicitDir = path.join(tempDir, 'explicit-bin');
    const explicitBinary = path.join(explicitDir, 'codex');
    const appDir = path.join(tempDir, 'Applications', 'Codex.app', 'Contents', 'Resources');
    fs.mkdirSync(explicitDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(explicitBinary, '');
    fs.writeFileSync(path.join(appDir, 'codex'), '');

    expect(findCodexBinaryPath(explicitDir, 'darwin')).toBe(explicitBinary);
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

    expect(resolveCodexCliPath(hostnamePath, legacyPath, '')).toBe(hostnamePath);
  });

  it('falls back to a legacy configured path', () => {
    const legacyPath = path.join(tempDir, 'legacy-codex');
    fs.writeFileSync(legacyPath, '');

    expect(resolveCodexCliPath('', legacyPath, '')).toBe(legacyPath);
  });

  it('falls back to PATH lookup when no configured file exists', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, 'codex');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(resolveCodexCliPath('', '', `PATH=${pathDir}`)).toBe(pathBinary);
  });

  it('uses the configured Linux command directly in WSL mode', () => {
    expect(resolveCodexCliPath(
      'codex',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });

  it('falls back to the default Linux command in WSL mode', () => {
    expect(resolveCodexCliPath(
      '',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });

  it('ignores a Windows-native CLI path in WSL mode and falls back to the Linux command', () => {
    expect(resolveCodexCliPath(
      'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.exe',
      '',
      '',
      { installationMethod: 'wsl', hostPlatform: 'win32' },
    )).toBe('codex');
  });
});
