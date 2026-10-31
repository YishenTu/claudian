import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';

import { readWSLExec } from '@test/helpers/WSLLaunch';
import type { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

export interface OpencodeWSLPeerLaunch {
  /** The `--cd` directory wsl.exe starts the Linux process in. */
  cwd: string;
  /** What the Linux process sees: the distro environment plus WSLENV-declared host values. */
  env: Record<string, string | undefined>;
}

/**
 * Routes a test's mocked `cross-spawn`: the Linux `<command> serve` launch runs the shared native
 * peer script as the distro process; every other wsl.exe launch (probes) goes to the WSL process
 * fixture, whose `binaries` decide what `command -v` finds in the distro.
 * `toLinux` models the distro filesystem; `/p` values outside it are unmodeled and throw.
 */
export function routeOpencodeWSLPeer(native: WSLProcessFixture, cli: { command: string; peer: string }, toLinux: (hostPath: string) => string | null) {
  const launches: OpencodeWSLPeerLaunch[] = [];
  vi.mocked(spawn).mockImplementation((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    const exec = /(?:^|[\\/])wsl\.exe$/u.test(command) ? readWSLExec({ args: [...args] }) : undefined;
    if (exec?.args[3] !== cli.command || exec.args[4] !== 'serve') return native.spawn(command, args, options);
    const host = options.env ?? {};
    const forwarded = Object.fromEntries((host.WSLENV ?? '').split(':').filter(Boolean).flatMap(entry => {
      const [key, flags = ''] = entry.split('/');
      const value = host[key];
      // `/w` values only cross from WSL to Windows; `/u` and flagless values cross into WSL.
      if (value === undefined || flags.includes('w')) return [];
      const linux = flags.includes('p') ? toLinux(value) : value;
      if (flags.includes('l') || linux === null) throw new Error(`Unmodeled WSLENV entry: ${entry}=${value}`);
      return [[key, linux]];
    }));
    const launch = { cwd: args[args.indexOf('--cd') + 1], env: { ...native.environment, ...forwarded } };
    launches.push(launch);
    // The distro process is a POSIX process, so cross-spawn's Windows command resolution does not apply.
    return spawnProcess(process.execPath, [cli.peer, ...exec.args.slice(4)], { cwd: launch.cwd, env: launch.env, stdio: options.stdio });
  });
  return launches;
}
