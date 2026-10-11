import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * The native store native resolves in a child with this environment (rc.2 `resolveDshHome`): a non-blank DSH_HOME with a
 * leading `~` expanded, else `.dsh` under the child's os.homedir(), which reads USERPROFILE on Windows and HOME elsewhere.
 * A relative DSH_HOME resolves against the child's working directory, `cwd`.
 */
export function getDeepSeekHome(environment: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  const userHome = (platform === 'win32' ? environment.USERPROFILE : environment.HOME) || homedir();
  const configured = environment.DSH_HOME?.trim() ? environment.DSH_HOME : path.join(userHome, '.dsh');
  if (configured === '~') return path.resolve(cwd, userHome);
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return path.resolve(cwd, userHome, configured.slice(2));
  return path.resolve(cwd, configured);
}

/** Whether two resolved homes name one native store; Windows paths are case-insensitive. */
export function isSameDeepSeekHome(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return left === right;
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
