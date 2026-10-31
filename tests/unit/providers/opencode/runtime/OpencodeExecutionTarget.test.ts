import { pathToFileURL } from 'node:url';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import {
  getOpencodeWSLForwardedEnvironment, opencodeEnvironment, opencodeFileURL, opencodeHostPath, opencodeTargetPath,
} from '@/providers/opencode/runtime/OpencodeExecutionTarget';

const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
const native: ExecutionTarget = { method: 'host-native', platformOs: 'windows', platformFamily: 'windows' };
const byKey = (entries: ReturnType<typeof getOpencodeWSLForwardedEnvironment>) => [...entries].sort((a, b) => a.key.localeCompare(b.key));

it('forwards only owned keys and explicit user values, translating Windows-path values of path keys', () => {
  const configured = [
    'CUSTOM=literal', 'SSL_CERT_FILE=C:\\certs\\ca.pem', 'SSL_CERT_DIR=\\\\server\\certs', 'NODE_EXTRA_CA_CERTS=D:/ca.pem',
    'TMPDIR=C:\\Temp', 'WSLENV=USER_DECLARED', 'USERPROFILE=C:\\Users\\Alice',
  ].join('\n');
  const env = {
    ...Object.fromEntries(configured.split('\n').map(line => line.split('=') as [string, string])),
    HOME: 'C:\\Users\\Alice', PATH: 'C:\\bin', UNRELATED: 'host', NOT_OPENCODE_KEY: 'host',
    OPENCODE_DB: 'C:\\Data\\opencode.db', OPENCODE_CONFIG: 'C:\\Data\\opencode.json', OPENCODE_PASSWORD: 'secret',
    OPENCODE_CONFIG_CONTENT: '{"prompt":"C:\\\\keep"}', CLAUDIAN_SESSION_TOOLS_RELAY: '{}',
    // A drive letter after the start is not a Windows path.
    XDG_DATA_HOME: '/home/alice/C:/data',
  };
  expect(byKey(getOpencodeWSLForwardedEnvironment(env, configured))).toEqual([
    { key: 'CLAUDIAN_SESSION_TOOLS_RELAY', hostPath: false, pathList: false },
    { key: 'CUSTOM', hostPath: false, pathList: false },
    { key: 'NODE_EXTRA_CA_CERTS', hostPath: true, pathList: false },
    { key: 'OPENCODE_CONFIG', hostPath: true, pathList: false },
    { key: 'OPENCODE_CONFIG_CONTENT', hostPath: false, pathList: false },
    { key: 'OPENCODE_DB', hostPath: true, pathList: false },
    { key: 'OPENCODE_PASSWORD', hostPath: false, pathList: false },
    { key: 'SSL_CERT_DIR', hostPath: true, pathList: true },
    { key: 'SSL_CERT_FILE', hostPath: true, pathList: false },
    { key: 'TMPDIR', hostPath: true, pathList: false },
    { key: 'XDG_DATA_HOME', hostPath: false, pathList: false },
  ]);
});

it.each([
  ['Linux HOME and PATH', 'HOME=/home/alice\nPATH=/usr/local/bin:/usr/bin', [{ key: 'HOME', hostPath: false, pathList: false }, { key: 'PATH', hostPath: false, pathList: false }]],
  ['Windows HOME and PATH', 'HOME=C:\\Users\\Alice\nPATH=C:\\bin', []],
  ['relative HOME and backslashed PATH', 'HOME=home\nPATH=/usr/bin\\x', []],
] as const)('forwards a configured HOME or PATH only as a Linux value (%s)', (_name, configured, forwarded) => {
  const env = Object.fromEntries(configured.split('\n').map(line => line.split('=') as [string, string]));
  expect(byKey(getOpencodeWSLForwardedEnvironment(env, configured))).toEqual([...forwarded, { key: 'XDG_DATA_HOME', hostPath: false, pathList: false }]);
});

it('translates a Windows-path data home, which crosses even when not configured', () => {
  expect(getOpencodeWSLForwardedEnvironment({ XDG_DATA_HOME: 'D:\\OpenCode' })).toEqual([{ key: 'XDG_DATA_HOME', hostPath: true, pathList: false }]);
});

it('drops unset values from a launch environment', () => {
  expect(Object.keys(opencodeEnvironment({ SET: 'value', EMPTY: '', UNSET: undefined }))).toEqual(['SET', 'EMPTY']);
});

it('maps paths only for a WSL target', () => {
  for (const host of [undefined, native]) {
    expect(opencodeTargetPath('C:\\Vault', host)).toBe('C:\\Vault');
    expect(opencodeTargetPath('/a/../b', host)).toBe('/a/../b');
    expect(opencodeHostPath('/home/alice', host)).toBe('/home/alice');
  }
  expect(opencodeTargetPath(':memory:', target)).toBe(':memory:');
  expect(opencodeTargetPath('C:\\Vault\\note.md', target)).toBe('/mnt/c/Vault/note.md');
  expect(opencodeTargetPath('\\\\wsl$\\Ubuntu\\home\\alice', target)).toBe('/home/alice');
  // Linux paths are normalized, never reinterpreted as host paths by an inner drive or double slash.
  expect(opencodeTargetPath('/home/alice/a:b', target)).toBe('/home/alice/a:b');
  expect(opencodeTargetPath('/home//alice/./x', target)).toBe('/home/alice/x');
  expect(opencodeHostPath('/home/alice', target)).toBe('\\\\wsl$\\Ubuntu\\home\\alice');
  expect(opencodeHostPath('/mnt/c/Vault', target)).toBe('C:\\Vault');
});

it('refuses paths the selected distro cannot address', () => {
  expect(() => opencodeTargetPath('\\\\wsl$\\Debian\\home\\alice', target)).toThrow('OpenCode path is outside the selected WSL distro: \\\\wsl$\\Debian\\home\\alice');
  expect(() => opencodeHostPath('relative', target)).toThrow('Cannot access OpenCode path from Windows: relative');
});

it('emits Linux file URLs with URL escaping for host managed plugin folders', () => {
  expect(opencodeFileURL('C:\\Temp\\plugin #1', target)).toBe('file:///mnt/c/Temp/plugin%20%231');
  expect(opencodeFileURL('\\\\wsl$\\Ubuntu\\home\\alice\\plugin', target)).toBe('file:///home/alice/plugin');
  // Native targets keep Node's own file URL, which resolves relative paths against the working directory.
  expect(opencodeFileURL('plugin', native)).toBe(pathToFileURL('plugin').href);
});
