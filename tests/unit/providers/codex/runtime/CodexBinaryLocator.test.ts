import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findCodexBinaryPath,
  resolveCodexCliPath,
} from '@/providers/codex/runtime/CodexBinaryLocator';

describe('CodexBinaryLocator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binary-locator-'));
  });

  afterEach(() => {
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
