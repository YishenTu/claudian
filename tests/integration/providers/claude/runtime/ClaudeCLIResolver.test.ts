import type * as fsType from 'fs';
import type * as osType from 'os';
import * as path from 'path';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import { ClaudeCLIResolver } from '@/providers/claude/runtime/ClaudeCLIResolver';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');

describe('ClaudeCLIResolver', () => {
  const originalEnv = process.env;
  const isWindows = process.platform === 'win32';
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-resolver-'));
    process.env = { ...originalEnv, PATH: '', HOME: tempDir, USERPROFILE: tempDir };
    for (const key of ['MISE_SHIMS_DIR', 'MISE_DATA_DIR', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'npm_config_prefix']) {
      delete process.env[key];
    }
    jest.spyOn(os, 'homedir').mockReturnValue(tempDir);
    // Keep discovery independent of CLIs installed on the machine running the test.
    const statSync = fs.statSync;
    jest.spyOn(fs, 'statSync').mockImplementation(((filePath, options) => {
      if (!String(filePath).startsWith(`${tempDir}${path.sep}`)) {
        throw new Error('Outside fixture directory');
      }
      return statSync(filePath, options);
    }) as typeof fs.statSync);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createExecutable = (...segments: string[]): string => {
    const filePath = path.join(tempDir, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
    return filePath;
  };

  it.each(['default', 'MISE_SHIMS_DIR', 'MISE_DATA_DIR', 'XDG_DATA_HOME'])(
    'auto-detects Claude in mise shims with a GUI PATH using %s',
    (configuration) => {
      let segments = isWindows
        ? ['AppData', 'Local', 'mise', 'shims']
        : ['.local', 'share', 'mise', 'shims'];
      if (configuration !== 'default') {
        process.env[configuration] = path.join(tempDir, 'custom data');
        segments = ['custom data', ...(configuration === 'MISE_SHIMS_DIR'
          ? []
          : configuration === 'MISE_DATA_DIR' ? ['shims'] : ['mise', 'shims'])];
      }
      const cliPath = createExecutable(...segments, isWindows ? 'claude.exe' : 'claude');

      expect(resolveClaudeCLIPath('', '', '')).toBe(cliPath);
    },
  );

  it('prefers the configured PATH over an auto-detected installation', () => {
    createExecutable('.local', 'bin', isWindows ? 'claude.exe' : 'claude');
    const cliPath = createExecutable('custom bin', isWindows ? 'claude.exe' : 'claude');

    expect(resolveClaudeCLIPath('', '', `PATH="${path.dirname(cliPath)}"`)).toBe(cliPath);
  });

  it('resolves a configured CLI path that was pasted with surrounding quotes', () => {
    const cliPath = createExecutable('my tools', 'claude');

    expect(resolveClaudeCLIPath(`"${cliPath}"`, '', '')).toBe(cliPath);
  });

  it('does not fall back to PATH discovery when the configured path is quoted', () => {
    const configured = createExecutable('configured dir', 'claude');
    const discoverable = createExecutable('path dir', 'claude');
    const envText = `PATH=${path.dirname(discoverable)}`;

    expect(resolveClaudeCLIPath(`"${configured}"`, '', envText)).toBe(configured);
  });

  it('resolves a quoted legacy CLI path when no host-scoped path is set', () => {
    const cliPath = createExecutable('legacy dir', 'claude');

    expect(resolveClaudeCLIPath('', `"${cliPath}"`, '')).toBe(cliPath);
  });

  it('still resolves an unquoted configured path', () => {
    const cliPath = createExecutable('plain', 'claude');

    expect(resolveClaudeCLIPath(cliPath, '', '')).toBe(cliPath);
  });
});

function resolveClaudeCLIPath(hostnamePath: string | undefined, legacyPath: string | undefined, envText: string): string | null {
  return new ClaudeCLIResolver().resolveFromSettings({
    providerConfigs: { claude: { cliPathsByHost: { [getHostnameKey()]: hostnamePath }, cliPath: legacyPath } },
    sharedEnvironmentVariables: envText,
  });
}
