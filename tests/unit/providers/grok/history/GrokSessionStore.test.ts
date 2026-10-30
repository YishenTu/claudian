import * as os from 'node:os';
import * as path from 'node:path';

import { resolveGrokSessionHome } from '@/providers/grok/history/GrokSessionStore';

const wsl = { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const;

describe('Grok session store precedence', () => {
  it.each([
    ['Linux GROK_HOME', { GROK_HOME: ' /opt/grok/ ', HOME: '/home/a' }, '/opt/grok'],
    ['a Windows GROK_HOME through the drive mount', { GROK_HOME: 'C:\\grok', HOME: '/home/a' }, '/mnt/c/grok'],
    ['an unmappable relative GROK_HOME', { GROK_HOME: 'store', HOME: '/home/a' }, null],
    ['Linux HOME', { HOME: ' /home/a ' }, '/home/a/.grok'],
    ['HOME only, never USERPROFILE', { USERPROFILE: '/home/u' }, null],
    ['no Linux home instead of the Windows profile', {}, null],
  ])('uses %s for a WSL target on Windows', (_name, environment, expected) => {
    expect(resolveGrokSessionHome(environment, 'win32', wsl)).toBe(expected);
  });

  it.each([
    ['USERPROFILE before HOME', { USERPROFILE: ' C:\\Users\\me ', HOME: 'C:\\home' }, 'C:\\Users\\me\\.grok'],
    ['HOME when USERPROFILE is blank', { USERPROFILE: ' ', HOME: ' D:\\home ' }, 'D:\\home\\.grok'],
    ['a Windows GROK_HOME', { GROK_HOME: 'D:\\grok\\..\\store' }, 'D:\\store'],
  ])('uses %s for native Windows', (_name, environment, expected) => {
    expect(resolveGrokSessionHome(environment, 'win32')).toBe(expected);
  });

  it.each([
    ['HOME before USERPROFILE', { HOME: '/home/a', USERPROFILE: '/home/u' }, '/home/a/.grok'],
    ['USERPROFILE when HOME is blank', { HOME: ' ', USERPROFILE: ' /home/u ' }, '/home/u/.grok'],
    ['a relative GROK_HOME as unavailable', { GROK_HOME: 'store' }, null],
  ])('uses %s for native POSIX hosts', (_name, environment, expected) => {
    expect(resolveGrokSessionHome(environment, 'linux')).toBe(expected);
  });

  it('falls back to the host account for native installs only', () => {
    expect(resolveGrokSessionHome({}, 'linux')).toBe(path.posix.resolve(os.homedir(), '.grok'));
    expect(resolveGrokSessionHome({ HOME: 'relative' }, 'linux')).toBe(path.posix.resolve(os.homedir(), '.grok'));
    expect(resolveGrokSessionHome({}, 'win32')).toBe(path.win32.resolve(os.homedir(), '.grok'));
  });
});
