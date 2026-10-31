import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';

it('locates wsl.exe independently of an explicitly configured Linux PATH', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows');
  try {
    const spec = buildTargetLaunchSpec({
      target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
      hostCwd: 'C:\\vault', command: 'cli', args: [], env: { PATH: '/opt/cli:/usr/bin' },
      forwardEnvironment: [{ key: 'PATH' }],
    });
    expect(spec.args.slice(0, 7)).toEqual(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', '--exec', '/bin/sh', '-c']);
    expect(spec.command).toBe('D:\\Windows\\System32\\wsl.exe');
    expect(spec.env).toEqual({ PATH: '/opt/cli:/usr/bin', WSLENV: 'PATH' });
  } finally { vi.unstubAllEnvs(); }
});

it('keeps native Windows argv quoting and environment independent of a saved WSL distro', () => {
  const env = { HOME: 'C:\\Users\\me', WSLENV: 'HOME/p:KEY', KEY: 'native-key' };
  const args = ['a b', 'quote"', 'trailing\\'];
  const spec = buildTargetLaunchSpec({
    target: { method: 'host-native', platformFamily: 'windows', platformOs: 'windows', distroName: 'Debian' },
    hostCwd: String.raw`\\wsl$\Ubuntu\home\me`, command: 'C:\\CLI\\cli.exe', args, env,
    forwardEnvironment: [{ key: 'KEY', hostPath: true }],
  });
  expect(spec.command).toBe('C:\\CLI\\cli.exe');
  expect(spec.args).toEqual(args);
  // Native Windows launches need Node's quoting; WSL alone supplies verbatim argv.
  expect(spec.windowsVerbatimArguments).toBeUndefined();
  expect(spec.env).toEqual(env);
  expect(spec.spawnCwd).toBe(String.raw`\\wsl$\Ubuntu\home\me`);
});

it('does not implicitly forward named host variables when no forwarding list is supplied', () => {
  // `undefined` is a legal key; it guards the default forwarding list against non-declaration entries.
  const env = { undefined: 'host-value' };
  const spec = buildTargetLaunchSpec({
    target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
    hostCwd: 'C:\\vault', command: 'cli', args: [], env,
  });
  expect(spec.env).toEqual(env);
});
