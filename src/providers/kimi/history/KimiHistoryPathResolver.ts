import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';

const MAX_CWD_DIRECTORIES_TO_SCAN = 1_024;

// kimi-cli stores sessions under `<share>/sessions/<md5(absolute work_dir)>/<session-id>/`.
export function encodeKimiSessionCwd(cwd: string): string {
  return createHash('md5').update(path.resolve(cwd), 'utf8').digest('hex');
}

export function resolveKimiShareDir(context: ProviderHistoryPathContext): string {
  const configured = context.environment.KIMI_SHARE_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(resolveUserHome(context.environment, context.hostPlatform), configured);
  }
  return path.resolve(resolveUserHome(context.environment, context.hostPlatform), '.kimi');
}

export function getTrustedKimiSessionRoots(
  context: ProviderHistoryPathContext,
): string[] {
  return [path.resolve(resolveKimiShareDir(context), 'sessions')];
}

export function resolveKimiSessionDirectory(
  persistedHint: string | null | undefined,
  sessionId: string | null | undefined,
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const roots = getTrustedKimiSessionRoots(context);
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
      const direct = path.join(root, encodeKimiSessionCwd(vaultPath), normalizedSessionId);
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
