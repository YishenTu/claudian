import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import type { PiFamilyProfile } from '../PiFamilyProfile';
import { findPiSessionFile, findPiSessionFileInRoot } from './PiHistoryStore';

function getConfiguredSessionDir(
  profile: PiFamilyProfile,
  context: ProviderHistoryPathContext,
): string | null {
  const configured = context.environment[profile.sessionDirEnvKey]?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

function getTrustedRoots(
  profile: PiFamilyProfile,
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string[] {
  const roots: string[] = [];
  const configuredSessionDir = getConfiguredSessionDir(profile, context);
  if (configuredSessionDir) {
    roots.push(configuredSessionDir);
  }

  const configuredAgentDir = context.environment[profile.agentDirEnvKey]?.trim();
  if (configuredAgentDir && path.isAbsolute(configuredAgentDir)) {
    roots.push(path.join(configuredAgentDir, 'sessions'));
  }
  if (vaultPath) {
    const vaultSessionRoot = path.join(vaultPath, profile.agentDirName, 'agent', 'sessions');
    if (isPathWithinRoot(vaultSessionRoot, vaultPath)) {
      roots.push(vaultSessionRoot);
    }
  }
  const home = context.environment.HOME?.trim()
    || context.environment.USERPROFILE?.trim()
    || os.homedir();
  roots.push(path.join(home, profile.agentDirName, 'agent', 'sessions'));
  return [...new Set(roots)];
}

function isLogicalSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !isPiSessionPathReference(value);
}

export function isPiSessionPathReference(
  value: string | null | undefined,
): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && (
    trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.endsWith('.jsonl')
  );
}

export function resolvePiSessionFileHint(
  profile: PiFamilyProfile,
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  vaultPath: string | null,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!context) {
    const target = persistedPath ?? logicalSessionId;
    return target ? findPiSessionFile(profile, target, vaultPath) : null;
  }

  const roots = getTrustedRoots(profile, vaultPath, context);
  const pathReference = persistedPath?.trim()
    || (isPiSessionPathReference(logicalSessionId)
      ? logicalSessionId.trim()
      : null);
  const resolvedPathReference = pathReference
    ? path.resolve(vaultPath ?? process.cwd(), pathReference)
    : null;
  if (
    resolvedPathReference
    && roots.some(root => isPathWithinRoot(resolvedPathReference, root))
    && isFile(resolvedPathReference)
  ) {
    return resolvedPathReference;
  }
  if (!isLogicalSessionId(logicalSessionId)) {
    return null;
  }

  for (const root of roots) {
    const resolved = findPiSessionFileInRoot(logicalSessionId, root);
    if (resolved && isPathWithinRoot(resolved, root) && isFile(resolved)) {
      return resolved;
    }
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
