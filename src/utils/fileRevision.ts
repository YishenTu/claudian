import * as fs from 'node:fs/promises';

/**
 * A native-history revision token for one file: size changes on every append, and the modification time
 * also catches same-length rewrites. Null when the file cannot be read. Antigravity reads the size back to find
 * what agy appended between two revisions of its transcript.
 */
export async function readFileRevision(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null;
  } catch {
    return null;
  }
}
