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

interface CompletionEmitterLike {
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => unknown;

export const WINDOWS_TASKKILL_TERMINATION_TIMEOUT_MS = 10_000;

export interface TerminateSpawnedProcessTreeOptions {
  readonly taskkillTimeoutMs?: number;
}

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

export async function terminateSpawnedProcessTree(
  proc: KillableProcess,
  signal: NodeJS.Signals | number | undefined,
  spawnProcess: SpawnProcess,
  spawnSpec?: WindowsCmdShimSpawnSpec | null,
  options?: TerminateSpawnedProcessTreeOptions,
): Promise<boolean> {
  if (
    process.platform !== 'win32'
    || !spawnSpec?.killProcessTree
    || typeof proc.pid !== 'number'
  ) {
    return proc.kill(signal);
  }

  let taskkill: unknown;
  try {
    taskkill = spawnProcess('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    return proc.kill(signal);
  }
  if (!isCompletionEmitterLike(taskkill)) {
    return proc.kill(signal);
  }

  return new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const fallback = (): void => {
      try {
        settle(proc.kill(signal));
      } catch {
        settle(false);
      }
    };
    const timer = window.setTimeout(
      fallback,
      options?.taskkillTimeoutMs ?? WINDOWS_TASKKILL_TERMINATION_TIMEOUT_MS,
    );
    taskkill.once('error', fallback);
    taskkill.once('close', code => {
      if (code === 0) settle(true);
      else fallback();
    });
  });
}

function isErrorEmitterLike(value: unknown): value is ErrorEmitterLike {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { on?: unknown }).on === 'function';
}

function isCompletionEmitterLike(value: unknown): value is CompletionEmitterLike {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { once?: unknown }).once === 'function';
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
