import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';

const MAX_CWD_DIRECTORIES_TO_SCAN = 1_024;

export function encodeGrokSessionCwd(cwd: string): string {
  return encodeURIComponent(path.resolve(cwd));
}

export function decodeGrokSessionCwd(encodedCwd: string): string | null {
  try {
    const decoded = decodeURIComponent(encodedCwd);
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
    return path.isAbsolute(storedCwd) ? path.resolve(storedCwd) : null;
  } catch {
    return null;
  }
}

export function resolveGrokSessionDirectory(
  persistedHint: string | null | undefined,
  sessionId: string | null | undefined,
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const roots = getTrustedSessionRoots(context);
  if (
    persistedHint
    && path.basename(path.normalize(persistedHint)) === normalizedSessionId
    && roots.some(root => isPathWithinRoot(persistedHint, root))
    && isDirectory(persistedHint)
  ) {
    return path.resolve(persistedHint);
  }

  if (vaultPath && path.isAbsolute(vaultPath)) {
    for (const root of roots) {
      const direct = path.join(root, encodeGrokSessionCwd(vaultPath), normalizedSessionId);
      if (isPathWithinRoot(direct, root) && isDirectory(direct)) {
        return direct;
      }
    }
  }

  for (const root of roots) {
    const found = findExactSessionDirectory(root, normalizedSessionId);
    if (found) {
      return found;
    }
  }
  return null;
}

export function getTrustedGrokSessionRoots(
  context: ProviderHistoryPathContext,
): string[] {
  return getTrustedSessionRoots(context);
}

function getTrustedSessionRoots(context: ProviderHistoryPathContext): string[] {
  const configuredHome = context.environment.GROK_HOME?.trim();
  if (configuredHome) {
    return path.isAbsolute(configuredHome)
      ? [path.resolve(configuredHome, 'sessions')]
      : [];
  }
  const home = resolveUserHome(context.environment, context.hostPlatform);
  return [path.resolve(home, '.grok', 'sessions')];
}

function resolveUserHome(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | undefined,
): string {
  const preferred = platform === 'win32'
    ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
    : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return preferred && path.isAbsolute(preferred) ? preferred : os.homedir();
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

function findExactSessionDirectory(root: string, sessionId: string): string | null {
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
    const candidate = path.join(root, entry.name, sessionId);
    if (isPathWithinRoot(candidate, root) && isDirectory(candidate)) {
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
