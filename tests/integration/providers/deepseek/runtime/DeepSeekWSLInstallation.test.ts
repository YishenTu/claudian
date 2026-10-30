import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { probeDeepSeekWSLInstallation } from '@/providers/deepseek/runtime/DeepSeekWSLInstallation';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

// wsl.exe is the emulated OS boundary; shared launch/probe code and the npm entry script stay real. The script runs in
// local Node against a real npm layout, so this suite skips Windows hosts; the native WSL job runs it in Linux Node.
describe.skipIf(process.platform === 'win32')('DeepSeek Linux npm entry discovery', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let root: string;
  let entry: string;
  let wsl: WSLProcessFixture;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'deepseek Linux # ')));
    entry = join(root, 'package/lib/bin.js');
    await mkdir(join(root, 'package/lib'), { recursive: true });
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    await writeFile(entry, '#!/usr/bin/env node\n');
    await chmod(entry, 0o700);
    await symlink(entry, join(root, 'bin/dsh'));
    wsl = new WSLProcessFixture();
    wsl.binaries.set('dsh', { path: join(root, 'bin/dsh'), version: 'dsh 1.2.3' });
    wsl.binaries.set('node', { path: '/usr/bin/node', version: 'v24.16.0' });
    wsl.reply = request => {
      if (request.argv[0] !== '-e') return undefined;
      try { return { stdout: execFileSync(process.execPath, request.argv, { cwd: root, encoding: 'utf8' }) }; }
      catch { return { code: 1 }; }
    };
    vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const probe = (configuredPath = '') => probeDeepSeekWSLInstallation({
    target: { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' },
    hostCwd: 'C:\\Vault', env: {}, command: configuredPath || 'dsh', configuredPath,
  });
  const missing = { installation: { path: null, version: null, source: 'auto' } };

  it('resolves the installed package entry and target Node inside the distro', async () => {
    expect(await probe()).toEqual({
      installation: { path: join(root, 'bin/dsh'), version: '1.2.3', source: 'auto' }, nodePath: '/usr/bin/node', entryPath: entry,
    });
    const resolver = wsl.requests.at(-1)!;
    expect(resolver.argv.at(-1)).toBe(join(root, 'bin/dsh'));
    for (const request of wsl.requests) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/Vault']));
  });

  it.each([
    ['an unrelated package', { name: 'desktop-wrapper', bin: { dsh: 'lib/bin.js' } }],
    ['a package without a dsh bin', { name: '@deepseek-ai/dsh', bin: { other: 'lib/bin.js' } }],
    ['a bin that is not a file', { name: '@deepseek-ai/dsh', bin: 'lib' }],
  ])('rejects %s as a Linux dsh installation', async (_name, manifest) => {
    await writeFile(join(root, 'package/package.json'), JSON.stringify(manifest));
    expect(await probe()).toEqual(missing);
  });

  it('accepts Linux paths whose directories merely contain a Windows extension', async () => {
    await mkdir(join(root, 'tools.cmd'));
    await symlink(entry, join(root, 'tools.cmd/dsh'));
    wsl.binaries.set('dsh', { path: join(root, 'tools.cmd/dsh'), version: 'dsh 1.2.3' });
    wsl.binaries.set('node', { path: '/opt/node.exe.d/bin/node', version: 'v24.16.0' });
    expect(await probe()).toMatchObject({ nodePath: '/opt/node.exe.d/bin/node', entryPath: entry, installation: { path: join(root, 'tools.cmd/dsh') } });
  });

  it('accepts the string bin form npm also publishes', async () => {
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: 'lib/bin.js' }));
    expect((await probe()).entryPath).toBe(entry);
  });

  it.each([
    ['dsh resolves to a Windows Desktop executable', false, () => { wsl.binaries.set('dsh', { path: '/mnt/c/Programs/DeepSeek/dsh.exe', version: 'dsh 1.2.3' }); }],
    ['dsh resolves to a Windows npm shim', false, () => { wsl.binaries.set('dsh', { path: '/mnt/c/Users/me/AppData/Roaming/npm/dsh.CMD', version: 'dsh 1.2.3' }); }],
    ['dsh resolves to a Windows PowerShell shim', false, () => { wsl.binaries.set('dsh', { path: '/mnt/c/Users/me/AppData/Roaming/npm/dsh.ps1', version: 'dsh 1.2.3' }); }],
    ['Linux Node is missing', false, () => { wsl.binaries.delete('node'); }],
    ['Node resolves to Windows node.exe through interop', false, () => { wsl.binaries.set('node', { path: '/mnt/c/Program Files/nodejs/node.exe', version: 'v24.16.0' }); }],
    ['the resolver prints a non-JSON line', true, () => { wsl.reply = request => request.argv[0] === '-e' ? { stdout: 'not json' } : undefined; }],
    ['the resolver prints a relative entry', true, () => { wsl.reply = request => request.argv[0] === '-e' ? { stdout: '"lib/bin.js"' } : undefined; }],
  ])('reports no installation when %s', async (_name, resolves, arrange) => {
    arrange();
    expect(await probe()).toEqual(missing);
    // Windows executables found through interop never run the Linux package resolver.
    expect(wsl.requests.some(request => request.argv[0] === '-e')).toBe(resolves);
  });

  it('reports no installation when dsh is absent', async () => {
    wsl.binaries.delete('dsh');
    expect(await probe()).toEqual(missing);
    expect(wsl.requests.map(request => request.argv.at(-1))).toEqual(['dsh']);
  });
});
