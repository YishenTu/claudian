import {
  parseDefaultWSLDistroListOutput,
  resolveExecutionTarget,
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
