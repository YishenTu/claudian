const WINDOWS_CMD_ARGUMENT_CHARS = /[\s"&<>|{}^=;!'+,`~()%@]/u;

export interface WindowsCmdShimSpawnSpec {
  args: string[];
  command: string;
  killProcessTree?: boolean;
  windowsVerbatimArguments?: boolean;
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
  spec: Pick<WindowsCmdShimSpawnSpec, 'args' | 'command'>,
): WindowsCmdShimSpawnSpec {
  const command = spec.command.trim();
  if (!command || process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return {
      args: spec.args,
      command: spec.command,
    };
  }

  const shellCommand = [command, ...spec.args]
    .map(value => quoteWindowsShellArgument(value))
    .join(' ');

  return {
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    command: process.env.ComSpec || process.env.comspec || 'cmd.exe',
    killProcessTree: true,
    windowsVerbatimArguments: true,
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

function requiresWindowsShellQuoting(value: string): boolean {
  return WINDOWS_CMD_ARGUMENT_CHARS.test(value)
    || value.includes('[')
    || value.includes(']');
}

function quoteWindowsShellArgument(value: string): string {
  if (!value.length) {
    return '""';
  }

  if (!requiresWindowsShellQuoting(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}
