import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathWithinRoot, isSamePath } from '../../../core/storage/pathContainment';
import { resolveOpencodeDatabasePath, resolveOpencodeDataDir } from './OpencodePaths';

/** A native session locator's database: recorded identity kept apart from current permission to open it. */
export interface OpencodeBindingDatabase {
  /** The recorded database; access decisions never rewrite it. */
  readonly recorded: string | null;
  /** Where the session may be read or run; null while the recorded database is not accessible. */
  readonly accessible: string | null;
}

/**
 * The single database policy for history, model recovery, forks and execution. Without a
 * recorded database the current one is used; a recorded database is accessible only while
 * it exists and lies in a trusted OpenCode data root or is the configured `OPENCODE_DB`.
 */
export function resolveOpencodeBindingDatabase(
  recordedPath: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): OpencodeBindingDatabase {
  const configured = resolveOpencodeDatabasePath(environment);
  const recorded = recordedPath?.trim() || null;
  if (!recorded) return { recorded: null, accessible: configured };
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || os.homedir();
  const trustedRoots = [
    resolveOpencodeDataDir(environment),
    path.join(home, 'Library', 'Application Support', 'opencode'),
  ];
  const trusted = (!!configured && isSamePath(recorded, configured))
    || trustedRoots.some(root => isPathWithinRoot(recorded, root));
  const exists = recorded === ':memory:' || fs.existsSync(recorded);
  return { recorded, accessible: trusted && exists ? recorded : null };
}
