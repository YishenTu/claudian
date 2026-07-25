import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';

const MAX_BUCKET_DIRECTORIES_TO_SCAN = 1_024;
const WORKDIR_HASH_LENGTH = 12;
const MAX_WORKDIR_SLUG_LENGTH = 40;

// Kimi Code stores sessions under
// `<home>/sessions/wd_<slug>_<sha256(normalized cwd)[:12]>/<session-id>/`,
// mirroring agent-core's session/store/workdir-key.ts.
export function encodeKimiWorkDirKey(cwd: string): string {
  const normalized = normalizeKimiWorkDir(cwd);
  const slug = slugifyKimiWorkDirName(path.posix.basename(normalized));
  const hash = createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, WORKDIR_HASH_LENGTH);
  return `wd_${slug}_${hash}`;
}

// Exact port of agent-core's utils/workdir-slug.ts.
export function slugifyKimiWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

// Port of agent-core's normalizeWorkDir: Windows-shaped paths resolve through
// win32 and fold to forward slashes; everything else resolves like pathe
// (posix resolution, backslashes normalized to slashes).
function normalizeKimiWorkDir(workDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return path.win32.resolve(workDir).replaceAll('\\', '/');
  }
  return path.resolve(workDir).replaceAll('\\', '/');
}

export function resolveKimiHome(context: ProviderHistoryPathContext): string {
  const configured = context.environment.KIMI_CODE_HOME?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(resolveUserHome(context.environment, context.hostPlatform), configured);
  }
  return path.resolve(resolveUserHome(context.environment, context.hostPlatform), '.kimi-code');
}

export function getTrustedKimiSessionRoots(
  context: ProviderHistoryPathContext,
): string[] {
  return [path.resolve(resolveKimiHome(context), 'sessions')];
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
      const direct = path.join(root, encodeKimiWorkDirKey(vaultPath), normalizedSessionId);
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
    if (scanned > MAX_BUCKET_DIRECTORIES_TO_SCAN) {
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
