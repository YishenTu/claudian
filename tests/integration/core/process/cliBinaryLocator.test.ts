// @test-ci {"native":true}
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { findCLIBinaryPath } from '@/core/process/cliBinaryLocator';
import { getEnhancedPath } from '@/core/process/env';
import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describe('enhanced CLI discovery and subprocess PATH', () => {
  const originalEnv = { ...process.env };
  const isWindows = process.platform === 'win32';
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'claudian mise '));
    process.env.PATH = '';
    for (const key of ['MISE_SHIMS_DIR', 'MISE_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'npm_config_prefix']) {
      delete process.env[key];
    }
    // Windows normally supplies USERPROFILE even when HOME is absent.
    process.env[isWindows ? 'USERPROFILE' : 'HOME'] = directory;
    process.env.LOCALAPPDATA = path.join(directory, 'Local AppData');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    // Windows can briefly lock the copied executable after it exits.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each(['default', 'home fallback', 'XDG_DATA_HOME', 'MISE_DATA_DIR', 'MISE_SHIMS_DIR', 'npm_config_prefix', ...(!isWindows ? ['.npm-global'] : [])])(
    'discovers and launches a CLI using %s',
    (configuration) => {
      let shims: string;
      switch (configuration) {
        case 'npm_config_prefix':
          process.env.npm_config_prefix = path.join(directory, 'npm prefix');
          shims = isWindows ? process.env.npm_config_prefix : path.join(process.env.npm_config_prefix, 'bin');
          break;
        case '.npm-global':
          shims = path.join(directory, '.npm-global', 'bin');
          break;
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
      expect(entries).not.toContain(path.join(directory, 'unused data', 'shims'));
      expect(entries).not.toContain(path.join(directory, 'unused xdg', 'mise', 'shims'));
      expect(execFileSync(binaryName, ['-p', '"mise probe ok"'], {
        cwd: directory,
        env: { ...process.env, PATH: enhancedPath },
        encoding: 'utf8',
      }).trim()).toBe('mise probe ok');
    },
  );

  describeUnix('Unix executable admission', () => {
    it('skips a non-executable PATH file and probes the later runnable installation', async () => {
      const first = path.join(directory, 'first bin');
      const second = path.join(directory, 'second bin');
      mkdirSync(first); mkdirSync(second);
      const name = 'claudian-executable-probe';
      writeFileSync(path.join(first, name), 'not executable');
      chmodSync(path.join(first, name), 0o644);
      const executable = path.join(second, name);
      symlinkSync(process.execPath, executable);
      const envPath = [first, second].join(path.delimiter);
      // The OS PATH search already skips this non-executable file.
      expect(execFileSync(name, ['--version'], { env: { ...process.env, PATH: envPath }, encoding: 'utf8' }).trim())
        .toBe(`v${process.versions.node}`);
      const resolver = new CachedProviderCLIResolver({
        binaryName: name, providerId: 'test-provider', hostnameKey: 'test-host',
        getSettingsProjection: () => ({ environmentText: `PATH=${envPath}` }),
      });
      const installation = await probeCLIInstallation({
        path: resolver.resolveFromSettings({}), configuredPath: '', args: ['--version'],
        env: { ...process.env, PATH: envPath },
      });
      expect(installation).toEqual({ path: executable, version: process.versions.node, source: 'auto' });
    });
  });
});
