import * as fs from 'node:fs/promises';

import {
  type FilesystemMentionEntry,
  FilesystemMentionSource,
} from '@/shared/composer-dropdown/FilesystemMentionSource';
import { expandHomePath } from '@/utils/path';

export interface ExternalFileMentionSourceOptions {
  /** Re-read on every match so toggling the setting takes effect immediately. */
  readonly isEnabled: () => boolean;
  /** Absolute vault root, used to resolve relative (`./`, `../`) mentions. */
  readonly resolveBase?: () => string | null;
}

async function readDirectory(
  absoluteDir: string,
  signal: AbortSignal,
): Promise<readonly FilesystemMentionEntry[]> {
  try {
    const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    if (signal.aborted) return [];
    return dirents.map((dirent) => ({
      name: dirent.name,
      // Symlinks are surfaced as files; resolving them would require an extra
      // stat per entry and risks following cycles during interactive browsing.
      isDirectory: dirent.isDirectory(),
    }));
  } catch {
    // Missing directory or permission denied — degrade to "No matches".
    return [];
  }
}

/**
 * Builds a FilesystemMentionSource backed by Node's fs and Claudian's path
 * expansion. Isolated from the pure source so the shared module stays free of
 * Node imports and remains unit-testable with in-memory fakes.
 */
export function createExternalFileMentionSource(
  options: ExternalFileMentionSourceOptions,
): FilesystemMentionSource {
  return new FilesystemMentionSource({
    expandHome: expandHomePath,
    isEnabled: options.isEnabled,
    readDirectory,
    resolveBase: options.resolveBase,
  });
}
