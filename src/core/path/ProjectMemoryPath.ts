import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { normalizeLinkedContentPath } from '@/core/path/LinkedContentPath';

const MEMORY_EXTENSION = '.md';
const SLUG_MAX_LENGTH = 48;
// Characters that are invalid in file names on at least one supported platform.
const INVALID_SEGMENT_CHARACTERS = /[*"<>:|?]/;

/**
 * A vault-relative path to a project memory file. A leading `/` is read from the vault root, `\` separates like `/`,
 * and a missing `.md` extension is appended. Returns null for an empty path, a folder (trailing `/`), a path outside
 * the vault (`..`, drive letters, UNC paths), or an invalid file name.
 */
export function normalizeProjectMemoryPath(value: string): string | null {
  const trimmed = value.trim();
  const last = trimmed.split(/[\\/]/).pop();
  if (last === '' || last === '.') return null;
  // One leading separator names the vault root; a doubled one stays a UNC path, which the Linked content rules reject.
  const path = normalizeLinkedContentPath(trimmed.replace(/^[\\/](?![\\/])/, ''));
  if (path === null) return null;
  const segments = path.split('/');
  if (segments.some(segment => INVALID_SEGMENT_CHARACTERS.test(segment))) return null;
  const fileName = segments[segments.length - 1].toLowerCase();
  if (fileName === MEMORY_EXTENSION) return null;
  return fileName.endsWith(MEMORY_EXTENSION) ? path : `${path}${MEMORY_EXTENSION}`;
}

/** The memory path offered for a new project: `.claudian/projects/<name-slug>/MEMORY.md`. */
export function defaultProjectMemoryPath(name: string): string {
  return `${PROJECTS_PATH}/${slugifyProjectName(name)}/MEMORY.md`;
}

/** The folder holding a memory file; `''` for one at the vault root. */
export function projectMemoryFolderOf(memoryPath: string): string {
  const separator = memoryPath.lastIndexOf('/');
  return separator === -1 ? '' : memoryPath.slice(0, separator);
}

function slugifyProjectName(name: string): string {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}
