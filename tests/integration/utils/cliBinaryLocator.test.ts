import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { findCLIBinaryPath } from '@/utils/cliBinaryLocator';
import { getEnhancedPath } from '@/utils/env';

describe('mise CLI discovery and subprocess PATH', () => {
  const originalEnv = process.env;
  const isWindows = process.platform === 'win32';
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'claudian mise '));
    process.env = { ...originalEnv, PATH: '' };
    for (const key of ['MISE_SHIMS_DIR', 'MISE_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
      delete process.env[key];
    }
    // Windows normally supplies USERPROFILE even when HOME is absent.
    process.env[isWindows ? 'USERPROFILE' : 'HOME'] = directory;
    process.env.LOCALAPPDATA = path.join(directory, 'Local AppData');
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['default', 'home fallback', 'XDG_DATA_HOME', 'MISE_DATA_DIR', 'MISE_SHIMS_DIR'])(
    'discovers and launches a CLI from mise shims using %s',
    (configuration) => {
      let shims: string;
      switch (configuration) {
        case 'MISE_SHIMS_DIR':
          process.env.MISE_SHIMS_DIR = path.join(directory, 'custom shims');
          process.env.MISE_DATA_DIR = path.join(directory, 'unused data');
          process.env.XDG_DATA_HOME = path.join(directory, 'unused xdg');
          shims = process.env.MISE_SHIMS_DIR;
          break;
        case 'MISE_DATA_DIR':
          process.env.MISE_DATA_DIR = path.join(directory, 'custom data');
          process.env.XDG_DATA_HOME = path.join(directory, 'unused xdg');
          shims = path.join(process.env.MISE_DATA_DIR, 'shims');
          break;
        case 'XDG_DATA_HOME':
          process.env.XDG_DATA_HOME = path.join(directory, 'xdg data');
          shims = path.join(process.env.XDG_DATA_HOME, 'mise', 'shims');
          break;
        case 'home fallback':
          delete process.env.LOCALAPPDATA;
          shims = isWindows
            ? path.join(directory, 'AppData', 'Local', 'mise', 'shims')
            : path.join(directory, '.local', 'share', 'mise', 'shims');
          break;
        default:
          shims = isWindows
            ? path.join(directory, 'Local AppData', 'mise', 'shims')
            : path.join(directory, '.local', 'share', 'mise', 'shims');
      }

      const binaryName = 'claudian-mise-probe';
      const executable = path.join(shims, `${binaryName}${isWindows ? '.exe' : ''}`);
      mkdirSync(shims, { recursive: true });
      // Use a runnable fixture without installing mise or downloading managed tools.
      if (isWindows) copyFileSync(process.execPath, executable);
      else symlinkSync(process.execPath, executable);

      expect(findCLIBinaryPath(binaryName)).toBe(executable);
      const enhancedPath = getEnhancedPath();
      const entries = enhancedPath.split(path.delimiter);
      expect(entries).toContain(shims);
      expect(entries.some(entry => entry.includes('unused'))).toBe(false);
      expect(execFileSync(binaryName, ['-p', '"mise probe ok"'], {
        cwd: directory,
        env: { ...process.env, PATH: enhancedPath },
        encoding: 'utf8',
      }).trim()).toBe('mise probe ok');
    },
  );
});
