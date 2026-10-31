import { getPiWSLForwardedEnvironment } from '@/providers/pi/runtime/piWSLEnvironment';

it('forwards configured and Pi variables, marking only Windows store locations as host paths', () => {
  expect(getPiWSLForwardedEnvironment({
    CUSTOM: 'value', UNRELATED: 'host', WSLENV: 'X', HOME: '/home/a', PATH: '/bin', USERPROFILE: '/home/u',
    PI_CODING_AGENT_DIR: 'C:\\Pi', PI_CODING_AGENT_SESSION_DIR: '\\\\server\\sessions', PI_PACKAGE_DIR: '/opt/C:/pi', PI_OTHER: 'C:\\x',
  }, 'CUSTOM=value\nWSLENV=X\nHOME=/home/a\nPATH=/usr/bin\nUSERPROFILE=/home/u')).toEqual([
    { key: 'CUSTOM', hostPath: false, pathList: false }, { key: 'HOME', hostPath: false, pathList: false }, { key: 'PATH', hostPath: false, pathList: false },
    { key: 'PI_CODING_AGENT_DIR', hostPath: true, pathList: false }, { key: 'PI_CODING_AGENT_SESSION_DIR', hostPath: true, pathList: false },
    { key: 'PI_PACKAGE_DIR', hostPath: false, pathList: false }, { key: 'PI_OTHER', hostPath: false, pathList: false },
  ]);
});

it.each([
  ['an inherited Linux HOME', { HOME: '/home/a' }, ''],
  ['a non-absolute HOME', { HOME: '~/linux' }, 'HOME=~/linux'],
  ['a PATH containing Windows entries', { PATH: '/usr/bin;C:\\x' }, 'PATH=/usr/bin;C:\\x'],
])('keeps WSL defaults for %s', (_name, env, text) => {
  expect(getPiWSLForwardedEnvironment(env, text)).toEqual([]);
});

it('marks a Windows package directory as a host path', () => {
  expect(getPiWSLForwardedEnvironment({ PI_PACKAGE_DIR: 'D:\\pkg' }, '')).toEqual([{ key: 'PI_PACKAGE_DIR', hostPath: true, pathList: false }]);
});
