import { piHostPath, piTargetPath, samePiTargetPath } from '@/providers/pi/runtime/piTargetPaths';

const wsl = { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const;
const native = { method: 'host-native', platformFamily: 'windows', platformOs: 'windows' } as const;

it.each([undefined, native])('leaves host-native paths untouched (%j)', target => {
  expect(piTargetPath('C:\\Vault\\..\\x', target)).toBe('C:\\Vault\\..\\x');
  expect(piHostPath('/home/a', target)).toBe('/home/a');
});

it.each([
  ['/home/a/../b', '/home/b'],
  ['C:\\Vault', '/mnt/c/Vault'],
  ['//wsl$/Ubuntu/home/a', '/home/a'],
  ['\\\\wsl.localhost\\Ubuntu\\home\\a', '/home/a'],
])('maps %s to the WSL path %s', (value, expected) => {
  expect(piTargetPath(value, wsl)).toBe(expected);
});

it('maps Linux and drive paths back to host paths', () => {
  expect(piHostPath('/home/a', wsl)).toBe('\\\\wsl$\\Ubuntu\\home\\a');
  expect(piHostPath('C:\\Vault', wsl)).toBe('C:\\Vault');
});

it.each([['\\\\wsl$\\Debian\\home\\a'], ['relative\\path']])('rejects %s, which no WSL path names', value => {
  expect(() => piTargetPath(value, wsl)).toThrow(`Pi path cannot be mapped to WSL: ${value}`);
  expect(() => piHostPath(value, wsl)).toThrow('Pi path cannot be mapped to WSL');
});

it('compares WSL paths by their case-sensitive Linux identity', () => {
  expect(samePiTargetPath('C:\\Vault', '/mnt/c/Vault', wsl)).toBe(true);
  expect(samePiTargetPath('/home/A', '/home/a', wsl)).toBe(false);
});

it.each([['linux', false], ['win32', true]] as const)('compares resolved host paths with %s case rules', (platform, insensitive) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    expect(samePiTargetPath('/tmp/a/../Vault', '/tmp/Vault')).toBe(true);
    expect(samePiTargetPath('/tmp/Vault', '/tmp/vault')).toBe(insensitive);
    expect(samePiTargetPath('/tmp/Vault', '/tmp/Other')).toBe(false);
  } finally { Object.defineProperty(process, 'platform', original); }
});
