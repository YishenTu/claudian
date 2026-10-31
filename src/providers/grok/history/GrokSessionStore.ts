import * as os from 'node:os';
import * as path from 'node:path';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

/** Authoritative store precedence, shared by history lookup and resume invalidation. */
export function resolveGrokSessionHome(
  environment: NodeJS.ProcessEnv,
  hostPlatform = process.platform,
  target?: ExecutionTarget,
): string | null {
  const paths = target?.method === 'wsl' ? path.posix : hostPlatform === 'win32' ? path.win32 : path.posix;
  let configuredHome = environment.GROK_HOME?.trim();
  if (configuredHome && target?.method === 'wsl' && !path.posix.isAbsolute(configuredHome)) {
    configuredHome = createExecutionPathMapper(target).toTargetPath(configuredHome) ?? configuredHome;
  }
  if (configuredHome) return paths.isAbsolute(configuredHome) ? paths.resolve(configuredHome) : null;
  const home = target?.method === 'wsl'
    ? environment.HOME?.trim()
    : hostPlatform === 'win32'
      ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
      : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  if (home && paths.isAbsolute(home)) return paths.resolve(home, '.grok');
  return target?.method === 'wsl' ? null : paths.resolve(os.homedir(), '.grok');
}
