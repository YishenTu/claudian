import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryEnvironment } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import type { CodexProviderSettings } from '../config';
import { inferWslDistroFromWindowsPath } from '../runtime/CodexExecutionTargetResolver';
import { createCodexPathMapper } from '../runtime/CodexPathMapper';
import { findCodexSessionFileAsync, runBeforeDeadline } from './CodexHistoryStore';

export const CODEX_HISTORY_LOOKUP_TIMEOUT_MS = 10_000;

export type CodexHistoryInstallation = Pick<CodexProviderSettings, 'installationMethod' | 'wslDistroOverride'>;

export interface CodexHistoryPathContext extends ProviderHistoryEnvironment {
  /** This host's Codex installation, decoded from the provider config; absent leaves WSL roots unconstrained. */
  installation?: CodexHistoryInstallation;
}

interface WslSessionsRoot {
  distroName: string;
  root: string;
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isWindowsPath(value: string): boolean {
  return (!path.posix.isAbsolute(value) || value.startsWith('//'))
    && (value.includes('\\') || /^[A-Za-z]:/.test(value));
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
    /^(\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\home\\[^\\]+\\\.codex\\sessions)(?:\\|$)/i,
  );
  return match ? { distroName: match[2], root: match[1] } : null;
}

function getWslDistroConstraint(context: CodexHistoryPathContext): string | null | undefined {
  if ((context.hostPlatform ?? process.platform) !== 'win32' || !context.installation) {
    return undefined;
  }
  const settings = context.installation;
  if (settings.installationMethod !== 'wsl') {
    return undefined;
  }
  return settings.wslDistroOverride
    || inferWslDistroFromWindowsPath(context.vaultPath)
    || null;
}

function getTrustedWslRoot(
  value: string | null | undefined,
  context: CodexHistoryPathContext,
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
  context: CodexHistoryPathContext,
  hints: Array<string | null | undefined> = [],
): string[] {
  const roots: string[] = [];
  const configuredHome = context.environment.CODEX_HOME?.trim();
  if (configuredHome && isAbsolutePath(configuredHome)) {
    roots.push(joinSessionsRoot(configuredHome));
    const distroConstraint = getWslDistroConstraint(context);
    if (distroConstraint !== undefined && path.posix.isAbsolute(configuredHome)) {
      const hintedDistro = hints
        .map(hint => inferWslDistroFromWindowsPath(hint))
        .find((distro): distro is string => !!distro);
      const pathMapper = createCodexPathMapper({
        distroName: distroConstraint || hintedDistro,
        method: 'wsl',
        platformFamily: 'unix',
        platformOs: 'linux',
      });
      const hostSessionsRoot = pathMapper.toHostPath(
        path.posix.join(configuredHome, 'sessions'),
      );
      if (hostSessionsRoot) {
        roots.push(hostSessionsRoot, hostSessionsRoot.replace(/^(\\\\)wsl\$(\\)/i, '$1wsl.localhost$2'));
      }
    }
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

export function getCodexArchivedTranscriptRoots(
  context?: CodexHistoryPathContext,
  sessionRootHints: string[] = [],
): string[] {
  const defaultSessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const sessionRoots = context
    ? getTrustedSessionRoots(context, sessionRootHints)
    : [...sessionRootHints, defaultSessionsRoot];
  return [...new Set(sessionRoots.map((root) => {
    const pathModule = isWindowsPath(root) ? path.win32 : path.posix;
    return pathModule.join(pathModule.dirname(root), 'archived_sessions');
  }))];
}

export function resolveCodexTranscriptRootHint(
  persistedRoot: string | null | undefined,
  context?: CodexHistoryPathContext,
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

/** The saved rollout path when it lies under a trusted session root; without a host context it is taken as is. */
export function resolveCodexSessionFileHint(
  persistedPath: string | null | undefined,
  context?: CodexHistoryPathContext,
): string | null {
  if (!persistedPath) return null;
  if (!context) return persistedPath;
  return getTrustedSessionRoots(context, [persistedPath]).some(root => isPathWithinRoot(persistedPath, root))
    ? persistedPath
    : null;
}

/** Present or unreadable keeps the saved path so reads surface the failure; null when the lookup deadline passes. */
async function isPresentOrUnreadable(filePath: string, deadline: number): Promise<boolean | null> {
  try {
    await runBeforeDeadline(() => access(filePath), deadline);
    return true;
  } catch (error) {
    if (Date.now() >= deadline) return null;
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * A thread's rollout: the trusted saved path while it exists, otherwise a search of the active,
 * transcript and archived roots, because Codex moves rollouts it archives or compresses. Access
 * failures other than ENOENT keep the saved path so reads surface them; the whole lookup, including
 * the saved-path check, ends at the deadline.
 */
export async function resolveCodexRolloutFile(
  persistedPath: string | null | undefined,
  threadId: string | null | undefined,
  transcriptRootPath: string | null,
  context?: CodexHistoryPathContext,
  deadline = Date.now() + CODEX_HISTORY_LOOKUP_TIMEOUT_MS,
): Promise<string | null> {
  const trusted = resolveCodexSessionFileHint(persistedPath, context);
  if (trusted) {
    const present = await isPresentOrUnreadable(trusted, deadline);
    if (present === null) return null;
    if (present) return trusted;
  }
  if (!threadId) return null;

  const rootHints = transcriptRootPath ? [transcriptRootPath] : [];
  const roots = new Set([
    ...(context ? getTrustedSessionRoots(context, [persistedPath]) : [path.join(os.homedir(), '.codex', 'sessions')]),
    ...rootHints,
    ...getCodexArchivedTranscriptRoots(context, rootHints),
  ]);
  for (const root of roots) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return null;
    const found = await findCodexSessionFileAsync(threadId, root, remainingMs);
    if (found) return found;
  }
  return null;
}
