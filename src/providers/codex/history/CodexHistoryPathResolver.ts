import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import { inferWslDistroFromWindowsPath } from '../runtime/CodexExecutionTargetResolver';
import { getCodexProviderSettings } from '../settings';
import { findCodexSessionFileAsync } from './CodexHistoryStore';

export const CODEX_HISTORY_LOOKUP_TIMEOUT_MS = 10_000;

interface WslSessionsRoot {
  distroName: string;
  root: string;
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isWindowsPath(value: string): boolean {
  return value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function joinSessionsRoot(home: string): string {
  const pathModule = isWindowsPath(home)
    ? path.win32
    : path.posix;
  return pathModule.join(home, 'sessions');
}

function parseStandardWslSessionsRoot(value: string): WslSessionsRoot | null {
  const normalized = path.win32.normalize(value);
  const match = normalized.match(
    /^(\\\\wsl\$\\([^\\]+)\\home\\[^\\]+\\\.codex\\sessions)(?:\\|$)/i,
  );
  return match ? { distroName: match[2], root: match[1] } : null;
}

function getWslDistroConstraint(context: ProviderHistoryPathContext): string | null | undefined {
  if ((context.hostPlatform ?? process.platform) !== 'win32' || !context.settings) {
    return undefined;
  }
  const settings = getCodexProviderSettings(context.settings);
  if (settings.installationMethod !== 'wsl') {
    return undefined;
  }
  return settings.wslDistroOverride
    || inferWslDistroFromWindowsPath(context.vaultPath)
    || null;
}

function getTrustedWslRoot(
  value: string | null | undefined,
  context: ProviderHistoryPathContext,
): WslSessionsRoot | null {
  if (!value) {
    return null;
  }
  const distroConstraint = getWslDistroConstraint(context);
  if (distroConstraint === undefined) {
    return null;
  }
  const parsed = parseStandardWslSessionsRoot(value);
  if (!parsed || (
    distroConstraint
    && parsed.distroName.toLowerCase() !== distroConstraint.toLowerCase()
  )) {
    return null;
  }
  return parsed;
}

function getTrustedSessionRoots(
  context: ProviderHistoryPathContext,
  hints: Array<string | null | undefined> = [],
): string[] {
  const roots: string[] = [];
  const configuredHome = context.environment.CODEX_HOME?.trim();
  if (configuredHome && isAbsolutePath(configuredHome)) {
    roots.push(joinSessionsRoot(configuredHome));
  }

  const home = context.environment.HOME?.trim()
    || context.environment.USERPROFILE?.trim()
    || os.homedir();
  const homePathModule = isWindowsPath(home)
    ? path.win32
    : path.posix;
  roots.push(homePathModule.join(home, '.codex', 'sessions'));
  for (const hint of hints) {
    const wslRoot = getTrustedWslRoot(hint, context);
    if (wslRoot) {
      roots.push(wslRoot.root);
    }
  }
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

  return getTrustedSessionRoots(context, [persistedRoot])
    .find(root => isPathWithinRoot(persistedRoot, root))
    ? persistedRoot
    : null;
}

export async function resolveCodexSessionFileHint(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  context?: ProviderHistoryPathContext,
  deadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS,
): Promise<string | null> {
  if (!context) {
    return persistedPath ?? (
      logicalSessionId
        ? findCodexSessionFileAsync(logicalSessionId, undefined, Math.max(0, deadline - Date.now()))
        : null
    );
  }

  const roots = getTrustedSessionRoots(context, [persistedPath]);
  if (persistedPath && roots.some(root => isPathWithinRoot(persistedPath, root))) {
    return persistedPath;
  }

  if (!logicalSessionId) {
    return null;
  }

  for (const root of roots) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      return null;
    }
    const resolved = await findCodexSessionFileAsync(logicalSessionId, root, remainingMs);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
