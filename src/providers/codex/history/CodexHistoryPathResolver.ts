import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import { findCodexSessionFileAsync } from './CodexHistoryStore';

function getTrustedSessionRoots(context: ProviderHistoryPathContext): string[] {
  const roots: string[] = [];
  const configuredHome = context.environment.CODEX_HOME?.trim();
  if (configuredHome && path.isAbsolute(configuredHome)) {
    roots.push(path.join(configuredHome, 'sessions'));
  }

  const home = context.environment.HOME?.trim()
    || context.environment.USERPROFILE?.trim()
    || os.homedir();
  roots.push(path.join(home, '.codex', 'sessions'));
  return [...new Set(roots)];
}

export function resolveCodexTranscriptRootHint(
  persistedRoot: string | null | undefined,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!persistedRoot) {
    return null;
  }
  if (!context) {
    return persistedRoot;
  }

  return getTrustedSessionRoots(context).find(root => isPathWithinRoot(persistedRoot, root))
    ? persistedRoot
    : null;
}

export async function resolveCodexSessionFileHint(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  context?: ProviderHistoryPathContext,
): Promise<string | null> {
  if (!context) {
    return persistedPath ?? (
      logicalSessionId ? findCodexSessionFileAsync(logicalSessionId) : null
    );
  }

  const roots = getTrustedSessionRoots(context);
  if (persistedPath && roots.some(root => isPathWithinRoot(persistedPath, root))) {
    return persistedPath;
  }

  if (!logicalSessionId) {
    return null;
  }

  for (const root of roots) {
    const resolved = await findCodexSessionFileAsync(logicalSessionId, root);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
