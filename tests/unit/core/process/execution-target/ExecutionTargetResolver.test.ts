import {
  inferWSLDistroFromWindowsPath,
  parseDefaultWSLDistroListOutput,
  resolveExecutionTarget,
  resolveExecutionTargetAsync,
} from '@/core/process/execution-target/ExecutionTargetResolver';

describe('resolveExecutionTarget', () => {
  it('infers the WSL distro from a \\\\wsl$ workspace path', () => {
    const target = resolveExecutionTarget({
      settings: { installationMethod: 'wsl', wslDistroOverride: '' },
      hostPlatform: 'win32',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });
  });

  it('uses the explicit WSL distro override when the workspace path is a Windows drive path', () => {
    const target = resolveExecutionTarget({
      settings: { installationMethod: 'wsl', wslDistroOverride: 'Debian' },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Debian',
    });
  });

  it('falls back to the default WSL distro when the workspace path is a Windows drive path', () => {
    const target = resolveExecutionTarget({
      settings: { installationMethod: 'wsl', wslDistroOverride: '' },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
      resolveDefaultWSLDistro: () => 'Ubuntu',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Ubuntu',
    });
  });

  it('preserves native host execution on non-Windows hosts', () => {
    const target = resolveExecutionTarget({
      settings: { installationMethod: 'wsl', wslDistroOverride: '' },
      hostPlatform: 'darwin',
      hostVaultPath: '/Users/example/repo',
    });

    expect(target).toMatchObject({
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
  });
});

describe('parseDefaultWSLDistroListOutput', () => {
  const distroListOutput = `
  NAME              STATE           VERSION
* Ubuntu-24.04      Running         2
  Debian            Stopped         2
`;

  it('extracts the starred default distro from wsl --list --verbose output', () => {
    expect(parseDefaultWSLDistroListOutput(distroListOutput)).toBe('Ubuntu-24.04');
  });

  it('decodes the native UTF-16LE output emitted by wsl.exe list commands', () => {
    expect(parseDefaultWSLDistroListOutput(
      Buffer.from(distroListOutput, 'utf16le'),
    )).toBe('Ubuntu-24.04');
  });

  it('continues to accept UTF-8 output when WSL_UTF8 is enabled', () => {
    expect(parseDefaultWSLDistroListOutput(
      Buffer.from(distroListOutput, 'utf8'),
    )).toBe('Ubuntu-24.04');
  });

  it('returns undefined when no default distro marker is present', () => {
    expect(parseDefaultWSLDistroListOutput(`
NAME              STATE           VERSION
Ubuntu-24.04      Running         2
Debian            Stopped         2
`)).toBeUndefined();
  });
});

it.each([
  ['linux', { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' }],
  ['darwin', { method: 'host-native', platformFamily: 'unix', platformOs: 'macos' }],
  ['win32', { method: 'native-windows', platformFamily: 'windows', platformOs: 'windows' }],
] as const)('resolves native %s consistently through sync and async APIs', async (hostPlatform, expected) => {
  const options = { hostPlatform, settings: { installationMethod: 'native-windows' as const, wslDistroOverride: 'Debian' } };
  expect(resolveExecutionTarget(options)).toEqual(expected);
  expect(await resolveExecutionTargetAsync(options)).toEqual(expected);
});

it.each([
  [undefined, undefined], [null, undefined], ['', undefined],
  ['//WSL.LOCALHOST/Ubuntu/home/user', 'Ubuntu'],
  [String.raw`\\wsl$\Ubuntu`, 'Ubuntu'],
  [String.raw`C:\\wsl$\Ubuntu`, undefined],
] as const)('infers only a rooted WSL UNC distro from %j', (input, expected) => {
  expect(inferWSLDistroFromWindowsPath(input)).toBe(expected);
});

it.each([
  { name: 'indented CRLF output', output: '  NAME  STATE  VERSION\r\n  * Ubuntu  Running  2\r\n', expected: 'Ubuntu' },
  { name: 'multiple spaces after the marker', output: '*  Ubuntu  Running  2', expected: 'Ubuntu' },
  { name: 'BOM-less Unicode at the encoding boundary', output: Buffer.from('* 发行版发行版发行', 'utf16le'), expected: '发行版发行版发行' },
  { name: 'spaces within a distro name', output: '* My Ubuntu  Running  2', expected: 'My Ubuntu' },
  { name: 'single trailing space', output: '* Ubuntu ', expected: 'Ubuntu' },
  { name: 'empty marker before the default', output: '*  \n* Ubuntu  Running  2', expected: 'Ubuntu' },
  { name: 'short UTF-8 output', output: Buffer.from('*A', 'utf8'), expected: 'A' },
  { name: 'BOM-less Unicode ending in ASCII', output: Buffer.from('*发行版发行版发行A', 'utf16le'), expected: '发行版发行版发行A' },
  { name: 'short UTF-16 output', output: Buffer.from('*A', 'utf16le'), expected: 'A' },
  { name: 'BOM with Unicode distro', output: Buffer.from('\uFEFF* 发行版发行版发行版发行版', 'utf16le'), expected: '发行版发行版发行版发行版' },
])('parses $name', ({ output, expected }) => {
  expect(parseDefaultWSLDistroListOutput(output)).toBe(expected);
});
