import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';

import { normalizeLinkedContentPath } from './LinkedContentPath';

/** Folder offered for the doc of a new project. */
export const DEFAULT_PROJECT_DOC_FOLDER = PROJECTS_PATH;

/**
 * A vault-relative folder for project docs, where `''` is the vault root (empty input, `/` or `.`). A leading `/`
 * is read from the vault root. Returns null for a folder outside the vault (`..`, drive letters, UNC paths).
 */
export function normalizeProjectDocFolder(value: string): string | null {
  const relative = value.trim().replace(/^\/+/, '');
  if (relative.split('/').every(segment => segment === '' || segment === '.')) return '';
  return normalizeLinkedContentPath(relative);
}

/** The folder holding a project doc; `''` for a doc at the vault root. */
export function projectDocFolderOf(docPath: string): string {
  const separator = docPath.lastIndexOf('/');
  return separator === -1 ? '' : docPath.slice(0, separator);
}
