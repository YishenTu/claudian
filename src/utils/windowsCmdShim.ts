const WINDOWS_CMD_ARGUMENT_CHARS = /[\s"&<>|{}^=;!'+,`~()%@]/u;

export interface WindowsCmdShimSpawnSpec {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
}

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
    windowsVerbatimArguments: true,
  };
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
