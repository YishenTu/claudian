import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';

const MEMORY_EXTENSION = '.md';
const SLUG_MAX_LENGTH = 48;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const WINDOWS_UNC_PATTERN = /^(?:\\\\|\/\/)/;
// Characters that are invalid in file names on at least one supported platform.
const INVALID_SEGMENT_CHARACTERS = /[*"<>:|?]/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/**
 * A vault-relative path to a project memory file. A leading `/` is read from the vault root, `\` separates like `/`,
 * and a missing `.md` extension is appended. Returns null for an empty path, a folder (trailing `/`), a path outside
 * the vault (`..`, drive letters, UNC paths), or an invalid file name.
 */
export function normalizeProjectMemoryPath(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed
    || hasControlCharacter(trimmed)
    || WINDOWS_DRIVE_PATTERN.test(trimmed)
    || WINDOWS_UNC_PATTERN.test(trimmed)
  ) {
    return null;
  }
  const rawSegments = trimmed.replace(/\\/g, '/').split('/');
  const last = rawSegments[rawSegments.length - 1];
  if (last === '' || last === '.') return null;

  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || INVALID_SEGMENT_CHARACTERS.test(segment)) return null;
    segments.push(segment);
  }
  const fileName = segments[segments.length - 1];
  if (fileName.toLowerCase() === MEMORY_EXTENSION) return null;
  if (!fileName.toLowerCase().endsWith(MEMORY_EXTENSION)) segments[segments.length - 1] = `${fileName}${MEMORY_EXTENSION}`;
  return segments.join('/');
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
