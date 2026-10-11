import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

import { findCLIBinaryPath, resolveConfiguredCLIPath } from '@/core/process/cliBinaryLocator';
import { DeepSeekCLIResolver } from '@/providers/deepseek/runtime/DeepSeekCLIResolver';

jest.mock('@/core/device/InstallationKey', () => ({ getInstallationKey: () => 'device:test' }));
jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }));
jest.mock('@/core/process/cliBinaryLocator', () => ({
  ...jest.requireActual('@/core/process/cliBinaryLocator'), findCLIBinaryPath: jest.fn(), resolveConfiguredCLIPath: jest.fn(),
}));

describe('DeepSeek installation selection', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let root: string;
  let app: string;
  let cli: string;
  let resolver: DeepSeekCLIResolver;
  const settings = (path = '') => ({ providerConfigs: { deepseek: { cliPathsByHost: { 'device:test': path } } } });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(os.tmpdir(), 'deepseek discovery ')));
    app = join(root, 'Applications', 'DeepSeek Harness.app');
    cli = join(app, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\n');
    jest.mocked(resolveConfiguredCLIPath).mockImplementation(path => path?.startsWith(root)
      ? jest.requireActual('@/core/process/cliBinaryLocator').resolveConfiguredCLIPath(path) : null);
    jest.mocked(os.homedir).mockReturnValue(root);
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    jest.mocked(findCLIBinaryPath).mockReturnValue(null);
    resolver = new DeepSeekCLIResolver();
  });

  afterEach(() => { Object.defineProperty(process, 'platform', platform); rmSync(root, { recursive: true, force: true }); });

  it('discovers Desktop without a registered dsh command and notices removal and reinstall', () => {
    expect(resolver.resolveFromSettings(settings())).toBe(cli);
    rmSync(app, { recursive: true });
    expect(resolver.resolveFromSettings(settings())).toBeNull();
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\n');
    expect(resolver.resolveFromSettings(settings())).toBe(cli);
  });

  it('keeps npm first in Auto but an explicit app wins, including a renamed Unicode app and symlinks', () => {
    const npm = join(root, 'dsh');
    writeFileSync(npm, '#!/usr/bin/env node\n');
    jest.mocked(findCLIBinaryPath).mockReturnValue(npm);
    expect(resolver.resolveFromSettings(settings())).toBe(npm);
    expect(resolver.resolveFromSettings(settings(app))).toBe(cli);
    const alias = join(root, '深度 求索.app');
    symlinkSync(app, alias, 'dir');
    expect(resolver.resolveFromSettings(settings(alias))).toBe(cli);
    const command = join(root, 'registered-dsh');
    symlinkSync(cli, command);
    expect(resolver.resolveFromSettings(settings(command))).toBe(cli);
  });

  it('discovers the per-user Windows Desktop under LOCALAPPDATA, else the profile\'s AppData\\Local, and maps an explicit install directory', () => {
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
    jest.mocked(findCLIBinaryPath).mockReturnValue('/another/dsh');
    expect(resolver.resolveFromSettings(settings(app))).toBeNull();
  });
});
