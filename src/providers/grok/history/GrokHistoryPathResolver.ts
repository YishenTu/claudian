import * as fs from 'node:fs';
import * as path from 'node:path';

import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import type { GrokHistoryEnvironment } from './GrokHistoryEnvironment';
import { resolveGrokSessionHome } from './GrokSessionStore';

const MAX_CWD_DIRECTORIES_TO_SCAN = 1_024;

export function encodeGrokSessionCwd(cwd: string): string {
  return encodeURIComponent(cwd.startsWith('/') ? path.posix.resolve(cwd) : path.resolve(cwd));
}

export function decodeGrokSessionCwd(encodedCwd: string): string | null {
  try {
    const decoded = decodeURIComponent(encodedCwd);
    if (decoded.startsWith('/')) return path.posix.resolve(decoded);
    if (!path.isAbsolute(decoded)) return null;
    return path.resolve(decoded);
  } catch {
    return null;
  }
}

export function resolveGrokSessionCwd(sessionDirectory: string): string | null {
  const cwdDirectory = path.dirname(path.resolve(sessionDirectory));
  const decoded = decodeGrokSessionCwd(path.basename(cwdDirectory));
  if (decoded) return decoded;

  try {
    const storedCwd = fs.readFileSync(path.join(cwdDirectory, '.cwd'), 'utf8').trim();
    return storedCwd.startsWith('/') ? path.posix.resolve(storedCwd) : path.isAbsolute(storedCwd) ? path.resolve(storedCwd) : null;
  } catch {
    return null;
  }
}

export function resolveGrokSessionDirectory(
  persistedHint: string | null | undefined,
  sessionId: string | null | undefined,
  vaultPath: string | null,
  context: GrokHistoryEnvironment,
): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const roots = getTrustedSessionRoots(context);
  const hostPath = context.target?.method === 'wsl' ? path.win32 : path;
  if (
    persistedHint
    && hostPath.basename(hostPath.normalize(persistedHint)) === normalizedSessionId
    && roots.some(root => isPathWithinRoot(persistedHint, root))
    && isDirectory(persistedHint)
  ) {
    return hostPath.resolve(persistedHint);
  }

  const nativeCwd = context.targetCwd ?? vaultPath;
  if (nativeCwd && (path.posix.isAbsolute(nativeCwd) || path.win32.isAbsolute(nativeCwd))) {
    for (const root of roots) {
      const direct = hostPath.join(root, encodeGrokSessionCwd(nativeCwd), normalizedSessionId);
      if (isDirectory(direct)) {
        return direct;
      }
    }
  }

  for (const root of roots) {
    const found = findExactSessionDirectory(root, normalizedSessionId, hostPath);
    if (found) {
      return found;
    }
  }
  return null;
}

function getTrustedSessionRoots(context: GrokHistoryEnvironment): string[] {
  const home = resolveGrokSessionHome(context.environment, context.hostPlatform, context.target);
  if (!home) return [];
  if (context.target?.method === 'wsl') {
    if (!context.target.distroName) return [];
    const root = createExecutionPathMapper(context.target).toHostPath(path.posix.join(home, 'sessions'));
    return root ? [root] : [];
  }
  const paths = context.hostPlatform === 'win32' ? path.win32 : path;
  return [paths.join(home, 'sessions')];
}

function normalizeSessionId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized
    && !path.isAbsolute(normalized)
    && !normalized.includes('/')
    && !normalized.includes('\\')
    && normalized !== '.'
    && normalized !== '..'
    ? normalized
    : null;
}

function findExactSessionDirectory(root: string, sessionId: string, hostPath = path): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    scanned += 1;
    if (scanned > MAX_CWD_DIRECTORIES_TO_SCAN) {
      break;
    }
    const candidate = hostPath.join(root, entry.name, sessionId);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
