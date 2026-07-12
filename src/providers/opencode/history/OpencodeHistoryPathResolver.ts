import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot, isSamePath } from '../../../core/storage/pathContainment';
import {
  resolveExistingOpencodeDatabasePath,
  resolveOpencodeDatabasePath,
  resolveOpencodeDataDir,
} from '../runtime/OpencodePaths';

export function resolveOpencodeDatabasePathHint(
  persistedPath: string | null | undefined,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!context) {
    return resolveExistingOpencodeDatabasePath(persistedPath);
  }

  const env = context.environment;
  const configuredPath = resolveOpencodeDatabasePath(env);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const trustedRoots = [
    resolveOpencodeDataDir(env),
    path.join(home, 'Library', 'Application Support', 'opencode'),
  ];
  const isTrustedHint = !!persistedPath && (
    (!!configuredPath && isSamePath(persistedPath, configuredPath))
    || trustedRoots.some(root => isPathWithinRoot(persistedPath, root))
  );

  return resolveExistingOpencodeDatabasePath(
    isTrustedHint ? persistedPath : undefined,
    env,
  );
}
