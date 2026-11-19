import * as os from 'node:os';
import * as path from 'node:path';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

const STORE_SEGMENTS = ['.gemini', 'antigravity-cli'] as const;
const SESSION_ID_PATTERN = /^[\w-]+$/;

/**
 * agy's data root as a host path: `~/.gemini/antigravity-cli`, using its Go runtime's home-directory rule. Under WSL the
 * home is the Linux `HOME` read from the distro, and the store is reached through the distro's Windows share.
 */
export function resolveAntigravityStoreRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  target?: ExecutionTarget,
): string | null {
  if (target?.method === 'wsl') {
    const home = environment.HOME?.trim();
    if (!home || !path.posix.isAbsolute(home)) return null;
    return createExecutionPathMapper(target).toHostPath(path.posix.join(home, ...STORE_SEGMENTS));
  }
  const home = platform === 'win32'
    ? environment.USERPROFILE || os.homedir()
    : environment.HOME || os.homedir();
  return home ? path.join(home, ...STORE_SEGMENTS) : null;
}

/** Path rules for a store root: a Windows root (a drive or a WSL share) is only ever read on a Windows host. */
export function antigravityStorePaths(storeRoot: string): typeof path.posix {
  return path.posix.isAbsolute(storeRoot) ? path.posix : path.win32;
}

/** Full transcripts first; the short transcript truncates long fields. */
export function resolveAntigravityTranscriptPaths(storeRoot: string, sessionId: string): string[] {
  if (!SESSION_ID_PATTERN.test(sessionId)) return [];
  const paths = antigravityStorePaths(storeRoot);
  const logs = paths.join(storeRoot, 'brain', sessionId, '.system_generated', 'logs');
  return [paths.join(logs, 'transcript_full.jsonl'), paths.join(logs, 'transcript.jsonl')];
}
