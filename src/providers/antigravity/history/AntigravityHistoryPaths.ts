import * as os from 'node:os';
import * as path from 'node:path';

const STORE_SEGMENTS = ['.gemini', 'antigravity-cli'] as const;
const SESSION_ID_PATTERN = /^[\w-]+$/;

/** agy's data root: `~/.gemini/antigravity-cli`, using its Go runtime's home-directory rule. */
export function resolveAntigravityStoreRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const home = platform === 'win32'
    ? environment.USERPROFILE || os.homedir()
    : environment.HOME || os.homedir();
  return home ? path.join(home, ...STORE_SEGMENTS) : null;
}

/** Full transcripts first; the short transcript truncates long fields. */
export function resolveAntigravityTranscriptPaths(storeRoot: string, sessionId: string): string[] {
  if (!SESSION_ID_PATTERN.test(sessionId)) return [];
  const logs = path.join(storeRoot, 'brain', sessionId, '.system_generated', 'logs');
  return [path.join(logs, 'transcript_full.jsonl'), path.join(logs, 'transcript.jsonl')];
}
