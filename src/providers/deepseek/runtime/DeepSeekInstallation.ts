import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isExistingFile, resolveConfiguredCLIPath } from '@/core/process/cliBinaryLocator';
import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { cliPathRequiresNode } from '@/core/process/env';
import { readWindowsCommandShimTarget, resolveOwningPackageBin } from '@/core/process/windowsCmdShim';

export interface DeepSeekDesktopInstallation {
  /** The bundled `dsh` command; it locates the installation and is never spawned. */
  readonly cliPath: string;
  readonly executable: string;
  readonly installAnchor: string;
}

const WINDOWS_EXECUTABLE = 'DeepSeek Harness.exe';
const WINDOWS_ROOT = /^(.+?)[\\/]+(?:deepseek harness\.exe|resources[\\/]+runtime[\\/]+cli[\\/]+bin[\\/]+dsh\.cmd)$/iu;

/** An official Desktop installation (macOS bundle or Windows per-user install). */
export function getDeepSeekDesktopInstallation(path: string): DeepSeekDesktopInstallation | undefined {
  let canonical = normalizeConfiguredCLIPath(path);
  try { canonical = realpathSync(canonical); } catch { /* Keep a missing configured path identifiable for diagnostics. */ }
  if (process.platform === 'win32') {
    const root = canonical.match(WINDOWS_ROOT)?.[1] ?? (isExistingFile(join(canonical, WINDOWS_EXECUTABLE)) ? canonical : undefined);
    return root ? mapDesktopInstallation(join(root, 'resources'), join(root, WINDOWS_EXECUTABLE), 'dsh.cmd') : undefined;
  }
  const app = canonical.match(/^(.*\.app)(?:\/Contents\/Resources\/runtime\/cli\/bin\/dsh)?$/u)?.[1];
  return app ? mapDesktopInstallation(join(app, 'Contents/Resources'), join(app, 'Contents/MacOS/DeepSeek Harness'), 'dsh') : undefined;
}

function mapDesktopInstallation(resources: string, executable: string, command: string): DeepSeekDesktopInstallation {
  const packages = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  return {
    cliPath: join(resources, 'runtime', 'cli', 'bin', command), executable, installAnchor: join(packages, 'dsh', 'package.json'),
  };
}

export function resolveDeepSeekCLIPath(path: string): string | null {
  return resolveConfiguredCLIPath(getDeepSeekDesktopInstallation(path)?.cliPath ?? path);
}

export function findDeepSeekDesktopCLI(): string | null {
  const installs = process.platform === 'darwin'
    ? [join(homedir(), 'Applications/DeepSeek Harness.app'), '/Applications/DeepSeek Harness.app']
    : process.platform === 'win32'
      // The NSIS installer is per-user with a fixed directory.
      ? [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')]
      : [];
  for (const install of installs) {
    const cli = resolveDeepSeekCLIPath(install);
    if (cli) return cli;
  }
  return null;
}

/**
 * The script Node runs for a non-Desktop dsh command, or undefined for a native executable. Windows npm-family
 * `.cmd`/`.ps1` shims only locate the `@deepseek-ai/dsh` package; they are never spawned.
 */
export function resolveDeepSeekNodeEntry(cliPath: string): string | undefined {
  if (process.platform === 'win32' && /\.(?:cmd|ps1)$/iu.test(cliPath)) {
    // npm-family installers write the .cmd shim beside every .ps1 shim.
    const target = readWindowsCommandShimTarget(cliPath.replace(/\.ps1$/iu, '.cmd'));
    const entry = target && resolveOwningPackageBin(target, '@deepseek-ai/dsh', 'dsh');
    if (!entry) {
      throw new Error(`The dsh Windows command shim could not be resolved to its Node.js entry point: ${cliPath}. `
        + 'Set the DeepSeek CLI path to the @deepseek-ai/dsh package\'s lib\\bin.js instead.');
    }
    return entry;
  }
  return cliPathRequiresNode(cliPath) ? cliPath : undefined;
}
