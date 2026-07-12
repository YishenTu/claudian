import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import { findPiSessionFile, findPiSessionFileInRoot } from './PiHistoryStore';

function getConfiguredSessionDir(context: ProviderHistoryPathContext): string | null {
  const configured = context.environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

function getTrustedRoots(
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string[] {
  const roots: string[] = [];
  const configuredSessionDir = getConfiguredSessionDir(context);
  if (configuredSessionDir) {
    roots.push(configuredSessionDir);
  }

  const configuredAgentDir = context.environment.PI_CODING_AGENT_DIR?.trim();
  if (configuredAgentDir && path.isAbsolute(configuredAgentDir)) {
    roots.push(path.join(configuredAgentDir, 'sessions'));
  }
  if (vaultPath) {
    const vaultSessionRoot = path.join(vaultPath, '.pi', 'agent', 'sessions');
    if (isPathWithinRoot(vaultSessionRoot, vaultPath)) {
      roots.push(vaultSessionRoot);
    }
  }
  const home = context.environment.HOME?.trim()
    || context.environment.USERPROFILE?.trim()
    || os.homedir();
  roots.push(path.join(home, '.pi', 'agent', 'sessions'));
  return [...new Set(roots)];
}

function isLogicalSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !path.isAbsolute(value)
    && !/[\\/]/.test(value);
}

export function resolvePiSessionFileHint(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  vaultPath: string | null,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!context) {
    const target = persistedPath ?? logicalSessionId;
    return target ? findPiSessionFile(target, vaultPath) : null;
  }

  const roots = getTrustedRoots(vaultPath, context);
  if (persistedPath && roots.some(root => isPathWithinRoot(persistedPath, root))) {
    return persistedPath;
  }
  if (!isLogicalSessionId(logicalSessionId)) {
    return null;
  }

  for (const root of roots) {
    const resolved = findPiSessionFileInRoot(logicalSessionId, root);
    if (resolved && isPathWithinRoot(resolved, root)) {
      return resolved;
    }
  }
  return null;
}
