export interface WindowsCmdShimSpawnSpec {
  args: string[];
  command: string;
  killProcessTree?: boolean;
}

interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
}

interface ErrorEmitterLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => unknown;

export function resolveWindowsCmdShimSpawnSpec(
  spec: Pick<WindowsCmdShimSpawnSpec, 'args' | 'command'>
    & Partial<Pick<WindowsCmdShimSpawnSpec, 'killProcessTree'>>,
): WindowsCmdShimSpawnSpec {
  const command = spec.command.trim();
  if (!command || process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return {
      args: spec.args,
      command: spec.command,
      ...(process.platform === 'win32' && spec.killProcessTree
        ? { killProcessTree: true }
        : {}),
    };
  }

  if (spec.args.some(value => /[\r\n]/u.test(value))) {
    throw new Error(
      'Windows command shims cannot safely receive multiline arguments. Use a native executable or launch the underlying script directly.',
    );
  }

  return {
    args: spec.args,
    command,
    killProcessTree: true,
  };
}

export function terminateSpawnedProcess(
  proc: KillableProcess,
  signal: NodeJS.Signals | number | undefined,
  spawnProcess: SpawnProcess,
  spawnSpec?: WindowsCmdShimSpawnSpec | null,
): boolean {
  if (
    process.platform !== 'win32'
    || !spawnSpec?.killProcessTree
    || typeof proc.pid !== 'number'
  ) {
    return proc.kill(signal);
  }

  try {
    const taskkill = spawnProcess('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (isErrorEmitterLike(taskkill)) {
      taskkill.on('error', () => {});
    }
    return true;
  } catch {
    return proc.kill(signal);
  }
}

function isErrorEmitterLike(value: unknown): value is ErrorEmitterLike {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { on?: unknown }).on === 'function';
}
