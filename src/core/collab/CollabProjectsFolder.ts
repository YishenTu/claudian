import { isWindowsReservedName } from '@/core/collab/WindowsPortablePath';

export const DEFAULT_COLLAB_PROJECTS_FOLDER = 'workspace';

const MAX_PROJECTS_FOLDER_LENGTH = 175;
const MAX_PROJECTS_FOLDER_SEGMENT_LENGTH = 120;
const WINDOWS_INVALID_CHARACTER_PATTERN = /[<>:"\\|?*]/u;

export type CollabProjectsFolderErrorCode =
  | 'absolute-path'
  | 'control-character'
  | 'empty-path'
  | 'empty-segment'
  | 'path-too-long'
  | 'reserved-directory'
  | 'segment-too-long'
  | 'unsafe-segment'
  | 'windows-invalid-name';

export type CollabProjectsFolderParseResult =
  | { readonly ok: true; readonly value: string }
  | {
    readonly code: CollabProjectsFolderErrorCode;
    readonly message: string;
    readonly ok: false;
  };

export interface CollabProjectsFolderParseOptions {
  readonly obsidianConfigDirectory?: string;
}

function failure(
  code: CollabProjectsFolderErrorCode,
  message: string,
): CollabProjectsFolderParseResult {
  return { code, message, ok: false };
}

function configDirectorySegments(value: string | undefined): Set<string> {
  // Storage normalization has no Vault instance; application validation supplies Vault.configDir.
  // eslint-disable-next-line obsidianmd/hardcoded-config-path
  const normalized = (value?.trim() || '.obsidian').normalize('NFC');
  return new Set(
    normalized
      .split('/')
      .map(segment => segment.toLocaleLowerCase('en-US'))
      .filter(Boolean),
  );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/**
 * Parses the portable Vault-relative root used for newly planned Collab Projects.
 * Existing and pending Projects retain their separately persisted paths.
 */
export function parseCollabProjectsFolder(
  raw: string,
  options: CollabProjectsFolderParseOptions = {},
): CollabProjectsFolderParseResult {
  const normalized = raw.trim().normalize('NFC');
  if (!normalized) {
    return failure('empty-path', 'Enter a folder inside this Vault.');
  }
  if (normalized.startsWith('/') || /^[a-z]:[/\\]/iu.test(normalized)) {
    return failure('absolute-path', 'Use a folder path relative to this Vault.');
  }
  if (normalized.includes('\\')) {
    return failure('windows-invalid-name', 'Use forward slashes between folder names.');
  }
  if (normalized.length > MAX_PROJECTS_FOLDER_LENGTH) {
    return failure('path-too-long', 'The Projects folder path is too long.');
  }

  const segments = normalized.split('/');
  const configSegments = configDirectorySegments(options.obsidianConfigDirectory);
  for (const segment of segments) {
    if (!segment) {
      return failure('empty-segment', 'Folder names cannot be empty.');
    }
    if (segment === '.' || segment === '..') {
      return failure('unsafe-segment', 'The Projects folder cannot contain . or ...');
    }
    if (segment.length > MAX_PROJECTS_FOLDER_SEGMENT_LENGTH) {
      return failure('segment-too-long', 'A Projects folder name is too long.');
    }
    if (containsControlCharacter(segment)) {
      return failure('control-character', 'Folder names cannot contain control characters.');
    }
    if (
      WINDOWS_INVALID_CHARACTER_PATTERN.test(segment)
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || isWindowsReservedName(segment)
    ) {
      return failure('windows-invalid-name', 'Use folder names supported by macOS, Windows, and Linux.');
    }

    const comparable = segment.toLocaleLowerCase('en-US');
    if (comparable === '.git' || comparable === '.claudian' || configSegments.has(comparable)) {
      return failure('reserved-directory', 'The Projects folder cannot use a reserved application folder.');
    }
  }

  return { ok: true, value: segments.join('/') };
}
