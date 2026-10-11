import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDeepSeekHome, isSameDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHome';

// Native resolveDshHome (dsh-home-paths) runs in the child: a non-blank DSH_HOME with `~` expanded, else os.homedir()/.dsh,
// where os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
describe('DeepSeek native store home', () => {
  it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, string]>([
    ['Windows follows USERPROFILE, never a POSIX-style HOME', 'win32', { HOME: 'C:\\msys\\home\\me', USERPROFILE: 'C:\\Users\\Me' }, 'C:\\Users\\Me\\.dsh'],
    ['POSIX follows HOME', 'darwin', { HOME: '/Users/me', USERPROFILE: '/elsewhere' }, '/Users/me/.dsh'],
    ['a blank DSH_HOME is unset on Windows', 'win32', { DSH_HOME: ' \t', USERPROFILE: 'D:\\Profiles\\Me' }, 'D:\\Profiles\\Me\\.dsh'],
    ['a blank DSH_HOME is unset on POSIX', 'linux', { DSH_HOME: '  ', HOME: '/home/me' }, '/home/me/.dsh'],
    ['a Windows DSH_HOME expands a leading ~\\ against USERPROFILE', 'win32', { DSH_HOME: '~\\Stores\\dsh', USERPROFILE: 'C:\\Users\\Me' }, 'C:\\Users\\Me\\Stores\\dsh'],
    ['a POSIX DSH_HOME expands a leading ~/ against HOME', 'darwin', { DSH_HOME: '~/stores/dsh', HOME: '/Users/me' }, '/Users/me/stores/dsh'],
    ['a bare ~ is the home itself', 'darwin', { DSH_HOME: '~', HOME: '/Users/me' }, '/Users/me'],
    ['an explicit Windows DSH_HOME is normalized', 'win32', { DSH_HOME: 'E:/dsh/../store', USERPROFILE: 'C:\\Users\\Me' }, 'E:\\store'],
  ])('%s', (_case, platform, environment, expected) => {
    expect(getDeepSeekHome(environment, platform === 'win32' ? 'C:\\Vault' : '/vault', platform)).toBe(expected);
  });

  // Native resolves DSH_HOME in the Host, whose working directory is the vault, not Obsidian's.
  it.each<[NodeJS.Platform, string, string, string]>([
    ['darwin', '/Users/me/Vault', 'stores/dsh', '/Users/me/Vault/stores/dsh'],
    ['win32', 'C:\\Users\\Me\\Vault', 'stores\\dsh', 'C:\\Users\\Me\\Vault\\stores\\dsh'],
  ])('resolves a relative DSH_HOME against the Host working directory on %s', (platform, cwd, relative, expected) => {
    expect(getDeepSeekHome({ DSH_HOME: relative, HOME: '/Users/me', USERPROFILE: 'C:\\Users\\Me' }, cwd, platform)).toBe(expected);
  });

  it('falls back to the operating-system home when the child environment names none', () => {
    expect(getDeepSeekHome({}, process.cwd(), process.platform)).toBe(join(homedir(), '.dsh'));
  });

  it('compares stores case-insensitively with normalized separators only on Windows', () => {
    expect(isSameDeepSeekHome('C:\\Users\\Me\\.dsh', 'c:/users/me/.DSH/', 'win32')).toBe(true);
    expect(isSameDeepSeekHome('C:\\Users\\Me\\.dsh', 'C:\\Users\\Other\\.dsh', 'win32')).toBe(false);
    expect(isSameDeepSeekHome('/Users/me/.dsh', '/Users/me/.dsh', 'darwin')).toBe(true);
    expect(isSameDeepSeekHome('/Users/me/.dsh', '/Users/Me/.dsh', 'darwin')).toBe(false);
  });
});
