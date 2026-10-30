// @test-ci {"native":true}
import * as fs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { DeepSeekCLIResolver } from '@/providers/deepseek/runtime/DeepSeekCLIResolver';

vi.mock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: vi.fn() }));
vi.mock('node:fs', async () => ({ ...(await vi.importActual<typeof import('node:fs')>('node:fs')) }));

describe('DeepSeek installation selection', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const windows = process.platform === 'win32';
  const localAppData = process.env.LOCALAPPDATA;
  let root: string;
  let app: string;
  let cli: string;
  let resolver: DeepSeekCLIResolver;
  const settings = (path = '') => ({ providerConfigs: { deepseek: { cliPathsByHost: { [getInstallationKey()]: path } } } });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(os.tmpdir(), 'deepseek discovery ')));
    // Real filesystem discovery must use the host's desktop layout and path semantics together.
    app = windows ? join(root, 'AppData', 'Local', 'Programs', 'DeepSeek Harness') : join(root, 'Applications', 'DeepSeek Harness.app');
    cli = windows ? join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : join(app, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\n');
    if (windows) {
      writeFileSync(join(app, 'DeepSeek Harness.exe'), '');
      process.env.LOCALAPPDATA = join(root, 'AppData', 'Local');
    }
    const actualStat = fs.statSync;
    // Hide installations outside the test root at the filesystem boundary, keeping lookup real.
    vi.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      if (!String(args[0]).startsWith(root)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return actualStat(...args);
    });
    vi.mocked(os.homedir).mockReturnValue(root);
    Object.defineProperty(process, 'platform', { ...platform, value: windows ? 'win32' : 'darwin' });
    vi.stubEnv('PATH', root);
    resolver = new DeepSeekCLIResolver();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = localAppData;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('selects Linux dsh without treating Windows Desktop, npm shims or host PATH as a WSL installation', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    // Native Windows runs discover these PATH shims; WSL resolution must keep the bare Linux command instead.
    for (const name of ['dsh', 'dsh.cmd', 'dsh.exe']) writeFileSync(join(root, name), '');
    const key = getInstallationKey();
    const config = { providerConfigs: { deepseek: { installationMethodsByHost: { [key]: 'wsl' },
      cliPath: '', cliPathsByHost: { [key]: 'C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness' } } } };
    expect(resolver.resolveFromSettings(config)).toBe('dsh');
    config.providerConfigs.deepseek.cliPathsByHost[key] = 'C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd';
    config.providerConfigs.deepseek.cliPath = ' "/opt/DeepSeek Linux/bin/dsh" ';
    expect(resolver.resolveFromSettings(config)).toBe('/opt/DeepSeek Linux/bin/dsh');
    config.providerConfigs.deepseek.cliPathsByHost[key] = '/home/me/.npm-global/bin/dsh';
    expect(resolver.resolveFromSettings(config)).toBe('/home/me/.npm-global/bin/dsh');
  });

  it.skipIf(windows)('keeps host discovery for a WSL selection stored on a non-Windows host', () => {
    const config = { providerConfigs: { deepseek: { installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, cliPathsByHost: {} } } };
    expect(resolver.resolveFromSettings(config)).toBe(cli);
  });

  it('discovers Desktop without a registered dsh command and notices removal and reinstall', () => {
    expect(resolver.resolveFromSettings(settings())).toBe(cli);
    rmSync(app, { recursive: true });
    expect(resolver.resolveFromSettings(settings())).toBeNull();
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\n');
    if (windows) writeFileSync(join(app, 'DeepSeek Harness.exe'), '');
    expect(resolver.resolveFromSettings(settings())).toBe(cli);
  });

  it('keeps npm first in Auto but an explicit app wins, including a renamed Unicode app and symlinks', () => {
    const npm = join(root, 'dsh');
    writeFileSync(npm, '#!/usr/bin/env node\n');
    chmodSync(npm, 0o700);
    expect(resolver.resolveFromSettings(settings())).toBe(npm);
    expect(resolver.resolveFromSettings(settings(app))).toBe(cli);
    const alias = join(root, windows ? '深度 求索' : '深度 求索.app');
    symlinkSync(app, alias, windows ? 'junction' : 'dir');
    expect(resolver.resolveFromSettings(settings(alias))).toBe(cli);
    const command = join(root, 'registered-dsh');
    symlinkSync(cli, command);
    expect(resolver.resolveFromSettings(settings(command))).toBe(cli);
  });

  it('discovers the per-user Windows Desktop under LOCALAPPDATA, else the profile\'s AppData\\Local, and maps an explicit install directory', () => {
    rmSync(app, { recursive: true });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const localAppData = process.env.LOCALAPPDATA;
    const install = (local: string): string => {
      const directory = join(local, 'Programs', 'DeepSeek Harness');
      const command = join(directory, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
      mkdirSync(dirname(command), { recursive: true });
      writeFileSync(command, '@echo off\r\n');
      writeFileSync(join(directory, 'DeepSeek Harness.exe'), '');
      return command;
    };
    try {
      process.env.LOCALAPPDATA = join(root, 'Roaming Local');
      expect(resolver.resolveFromSettings(settings())).toBeNull();
      const roaming = install(process.env.LOCALAPPDATA);
      expect(resolver.resolveFromSettings(settings())).toBe(roaming);
      delete process.env.LOCALAPPDATA;
      const local = install(join(root, 'AppData', 'Local'));
      expect(resolver.resolveFromSettings(settings())).toBe(local);
      expect(resolver.resolveFromSettings(settings(dirname(dirname(dirname(dirname(dirname(roaming)))))))).toBe(roaming);
    } finally {
      if (localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = localAppData;
    }
  });

  it('does not silently change installations when the explicit path disappears', () => {
    expect(resolver.resolveFromSettings(settings(app))).toBe(cli);
    rmSync(app, { recursive: true });
    writeFileSync(join(root, 'dsh'), '#!/usr/bin/env node\n', { mode: 0o700 });
    expect(resolver.resolveFromSettings(settings(app))).toBeNull();
  });
});
