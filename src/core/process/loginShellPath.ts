import * as os from 'os';
import * as path from 'path';

import { parsePathEntries } from './cliPath';
import { setLoginShellPathEntries } from './env';
import { runProcessProbe } from './ProcessProbe';

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const PATH_MARKER = '__CLAUDIAN_LOGIN_PATH__';

let resolution: Promise<void> | null = null;

/**
 * GUI-launched apps do not inherit the PATH that shell profiles build (version managers,
 * custom bins). Reads it once from an interactive login shell; failure keeps guessed paths.
 */
export function resolveLoginShellPath(): Promise<void> {
  resolution ??= readLoginShellPath().then(setLoginShellPathEntries);
  return resolution;
}

async function readLoginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return [];
  const shell = getLoginShell();
  if (!shell) return [];
  // printenv reports the exported PATH colon-joined in every shell, including fish.
  const script = `printf '%s' '${PATH_MARKER}'; /usr/bin/printenv PATH; printf '%s' '${PATH_MARKER}'`;
  const output = await runProcessProbe({
    args: ['-i', '-l', '-c', script],
    command: shell,
    cwd: os.homedir(),
    env: { ...process.env, CLAUDIAN_RESOLVING_ENVIRONMENT: '1' },
    killProcessTree: true,
  }, LOGIN_SHELL_TIMEOUT_MS);
  const value = output?.split(PATH_MARKER)[1];
  return value ? parsePathEntries(value.trim()).filter(entry => path.isAbsolute(entry)) : [];
}

function getLoginShell(): string | null {
  let shell = process.env.SHELL;
  if (!shell) {
    try {
      shell = os.userInfo().shell ?? undefined;
    } catch {
      return null;
    }
  }
  return shell && path.isAbsolute(shell) ? shell : null;
}
