import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

describe('createExecutionPathMapper', () => {
  it.each([
    { host: 'C:\\repo\\src', target: '/mnt/c/repo/src', canonical: 'C:\\repo\\src' },
    { host: 'd:/Vault/../notes', target: '/mnt/d/notes', canonical: 'D:\\notes' },
    { host: '\\\\?\\C:\\vault', target: '/mnt/c/vault', canonical: 'C:\\vault' },
    { host: 'C:\\', target: '/mnt/c', canonical: 'C:\\' },
  ])('maps Windows drive path $host into WSL and back', ({ host, target, canonical }) => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath(host)).toBe(target);
    expect(mapper.toHostPath(target)).toBe(canonical);
  });

  it.each(['wsl$', 'WSL.LOCALHOST'])('maps %s paths into Linux paths for the selected distro', server => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath(String.raw`\\${server}\Ubuntu\home\user\repo`)).toBe('/home/user/repo');
    expect(mapper.toHostPath('/home/user/repo')).toBe('\\\\wsl$\\Ubuntu\\home\\user\\repo');
  });

  it('rejects \\\\wsl$ paths from a different distro', () => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath('\\\\wsl$\\Debian\\home\\user\\repo')).toBeNull();
  });

  it('keeps host-native paths unchanged', () => {
    const target: ExecutionTarget = {
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'macos',
    };
    const mapper = createExecutionPathMapper(target);

    expect(mapper.toTargetPath('/Users/example/repo')).toBe('/Users/example/repo');
    expect(mapper.toHostPath('/Users/example/repo')).toBe('/Users/example/repo');
  });
});

it('maps extended UNC roots case-insensitively and distinguishes drive mounts from Linux directories', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' });
  expect(mapper.toTargetPath(String.raw`\\?\UNC\WSL.LOCALHOST\uBuNtU\home\user\..\notes`)).toBe('/home/notes');
  expect(mapper.toTargetPath(String.raw`\\wsl$\Ubuntu`)).toBe('/');
  expect(mapper.toHostPath('/')).toBe(String.raw`\\wsl$\Ubuntu`);
  expect(mapper.toHostPath('/mnt/C')).toBe('C:\\');
  expect(mapper.toHostPath('/home/mnt/c/file')).toBe(String.raw`\\wsl$\Ubuntu\home\mnt\c\file`);
  expect(mapper.toHostPath('/mnt/cc/file')).toBe(String.raw`\\wsl$\Ubuntu\mnt\cc\file`);
  expect(mapper.toHostPath('relative/file')).toBeNull();
  expect(mapper.toHostPath('')).toBeNull();
});

it('filters unrepresentable paths and reports the same admission through the WSL mapper', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' });
  const paths = ['', 'prefixC:\\notes', 'C:notes', String.raw`\\server\share`, String.raw`\\wsl$\Debian\home`, 'C:\\notes', String.raw`\\wsl$\Ubuntu\home`];
  expect(paths.map(value => mapper.canRepresentHostPath(value))).toEqual([false, false, false, false, false, true, true]);
  expect(mapper.mapTargetPathList(paths)).toEqual(['/mnt/c/notes', '/home']);
});

it('maps drives without a distro but requires a distro for Linux-only host paths', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', platformFamily: 'unix', platformOs: 'linux' });
  expect(mapper.toHostPath('/mnt/c/notes')).toBe('C:\\notes');
  expect(mapper.toHostPath('/home/user')).toBeNull();
});

it.each([
  { platformFamily: 'unix', platformOs: 'macos', path: '/home/a/../notes/', expected: '/home/notes' },
  { platformFamily: 'windows', platformOs: 'windows', path: 'C:/vault/a/../notes', expected: 'C:\\vault\\notes' },
] as const)('normalizes identity mappings and filters empty inputs on $platformFamily', ({ platformFamily, platformOs, path, expected }) => {
  const mapper = createExecutionPathMapper({ method: 'host-native', platformFamily, platformOs });
  expect(mapper.toTargetPath(path)).toBe(expected);
  expect(mapper.toHostPath(path)).toBe(expected);
  expect(mapper.toTargetPath('')).toBeNull();
  expect(mapper.toHostPath('')).toBeNull();
  expect(mapper.canRepresentHostPath('')).toBe(false);
  expect(mapper.canRepresentHostPath(path)).toBe(true);
  expect(mapper.mapTargetPathList(['', path])).toEqual([expected]);
});

it('preserves backslashes in absolute POSIX filenames and the root directory', () => {
  const mapper = createExecutionPathMapper({ method: 'host-native', platformFamily: 'unix', platformOs: 'linux' });
  expect(mapper.toHostPath('/')).toBe('/');
  expect(mapper.toTargetPath('/notes/a\\b')).toBe('/notes/a\\b');
  expect(mapper.toTargetPath('notes\\file')).toBe('notes/file');
});
