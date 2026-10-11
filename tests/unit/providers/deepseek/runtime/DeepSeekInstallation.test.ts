import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { getDeepSeekDesktopInstallation, resolveDeepSeekNodeEntry } from '@/providers/deepseek/runtime/DeepSeekInstallation';

const PACKAGES = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai'];

describe('DeepSeek installation layout', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let root: string;
  const onPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { ...platform, value }); };

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'deepseek installation '))); });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); rmSync(root, { recursive: true, force: true }); });

  it('maps the macOS bundle to its wrapper, Electron executable and install anchor', () => {
    onPlatform('darwin');
    const app = join(root, 'DeepSeek Harness.app');
    const resources = join(app, 'Contents', 'Resources');
    const installation = {
      cliPath: join(resources, 'runtime', 'cli', 'bin', 'dsh'),
      executable: join(app, 'Contents', 'MacOS', 'DeepSeek Harness'),
      installAnchor: join(resources, ...PACKAGES, 'dsh', 'package.json'),
    };
    expect(getDeepSeekDesktopInstallation(app)).toEqual(installation);
    expect(getDeepSeekDesktopInstallation(installation.cliPath)).toEqual(installation);
  });

  describe('on Windows', () => {
    let install: string;
    let installation: Record<string, string>;

    beforeEach(() => {
      onPlatform('win32');
      install = join(root, 'Programs', 'DeepSeek Harness');
      const resources = join(install, 'resources');
      installation = {
        cliPath: join(resources, 'runtime', 'cli', 'bin', 'dsh.cmd'),
        executable: join(install, 'DeepSeek Harness.exe'),
        installAnchor: join(resources, ...PACKAGES, 'dsh', 'package.json'),
      };
      mkdirSync(dirname(installation.cliPath), { recursive: true });
      writeFileSync(installation.cliPath, '@echo off\r\n');
      writeFileSync(installation.executable, '');
    });

    it('maps the install directory, its executable and its bundled dsh.cmd, matching names case-insensitively', () => {
      expect(getDeepSeekDesktopInstallation(install)).toEqual(installation);
      expect(getDeepSeekDesktopInstallation(installation.executable)).toEqual(installation);
      expect(getDeepSeekDesktopInstallation(installation.cliPath)).toEqual(installation);
      expect(getDeepSeekDesktopInstallation(`"${join(install, 'deepseek harness.EXE')}"`)).toEqual(installation);
      expect(getDeepSeekDesktopInstallation(join(install, 'Resources', 'Runtime', 'CLI', 'bin', 'DSH.cmd'))).toEqual(installation);
    });

    it('rejects directories without the Desktop executable and macOS bundles', () => {
      expect(getDeepSeekDesktopInstallation(root)).toBeUndefined();
      expect(getDeepSeekDesktopInstallation(join(root, 'DeepSeek Harness.app'))).toBeUndefined();
    });
  });

  describe('Node entry of an npm-installed dsh', () => {
    const writePackage = (packageRoot: string, name = '@deepseek-ai/dsh'): string => {
      const bin = join(packageRoot, 'lib', 'bin.js');
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '#!/usr/bin/env node\n');
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, bin: { dsh: 'lib/bin.js' } }));
      return bin;
    };
    // The npm cmd-shim form: a %dp0%-relative target run by "%_prog%".
    const writeShim = (shim: string, target: string): void => {
      mkdirSync(dirname(shim), { recursive: true });
      const relativeTarget = relative(dirname(shim), target).split(sep).join('\\');
      writeFileSync(shim, [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`, '',
      ].join('\r\n'));
    };

    it('runs a Node script directly on every platform and leaves a native executable alone', () => {
      onPlatform('darwin');
      const bin = writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh'));
      expect(resolveDeepSeekNodeEntry(bin)).toBe(bin);
      const native = join(root, 'dsh');
      writeFileSync(native, '\x7fELF');
      expect(resolveDeepSeekNodeEntry(native)).toBeUndefined();
    });

    it('resolves Windows npm .cmd and .ps1 shims to the owning @deepseek-ai/dsh bin instead of running the shim', () => {
      onPlatform('win32');
      const bin = writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh'));
      writeShim(join(root, 'dsh.cmd'), bin);
      writeFileSync(join(root, 'dsh.ps1'), '#!/usr/bin/env pwsh\n');
      expect(resolveDeepSeekNodeEntry(join(root, 'dsh.cmd'))).toBe(bin);
      expect(resolveDeepSeekNodeEntry(join(root, 'dsh.PS1'))).toBe(bin);
    });

    it.each([
      ['targets another package', (shim: string) => writeShim(shim, writePackage(join(root, 'node_modules', 'impostor'), 'impostor'))],
      ['targets a script no package declares', (shim: string) => {
        const script = join(root, 'loose', 'bin.js');
        mkdirSync(dirname(script), { recursive: true });
        writeFileSync(script, '');
        writeShim(shim, script);
      }],
      ['is not a Node invocation', (shim: string) => writeFileSync(shim, '@ECHO off\r\nsome-wrapper %*\r\n')],
      ['is missing', () => {}],
    ])('fails closed with CLI path guidance when a Windows shim %s', (_case, write) => {
      onPlatform('win32');
      const shim = join(root, 'dsh.cmd');
      write(shim);
      expect(() => resolveDeepSeekNodeEntry(shim)).toThrow(/@deepseek-ai\/dsh.*lib[\\/]bin\.js/);
    });
  });
});
