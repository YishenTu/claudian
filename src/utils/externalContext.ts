/**
 * Claudian - External Context Utilities
 *
 * Utilities for external context validation, normalization, and conflict detection.
 */

import * as fs from 'fs';

import { normalizePathForComparison as normalizePathForComparisonImpl } from './path';

export interface PathConflict {
  path: string;
  type: 'parent' | 'child';
}

/**
 * Normalizes a path for comparison.
 * Re-exports the unified implementation from path.ts for consistency.
 * - Handles MSYS paths, home/env expansions
 * - Case-insensitive on Windows
 * - Trailing slash removed
 */
export function normalizePathForComparison(p: string): string {
  return normalizePathForComparisonImpl(p);
}

function normalizePathForDisplay(p: string): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function findConflictingPath(
  newPath: string,
  existingPaths: string[]
): PathConflict | null {
  const normalizedNew = normalizePathForComparison(newPath);

  for (const existing of existingPaths) {
    const normalizedExisting = normalizePathForComparison(existing);

    if (normalizedNew.startsWith(normalizedExisting + '/')) {
      return { path: existing, type: 'parent' };
    }

    if (normalizedExisting.startsWith(normalizedNew + '/')) {
      return { path: existing, type: 'child' };
    }
  }

  return null;
}

export function getFolderName(p: string): string {
  const normalized = normalizePathForDisplay(p);
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

export interface ExternalContextDisplayEntry {
  contextRoot: string;
  displayName: string;
  displayNameLower: string;
}

function getContextDisplayName(
  normalizedPath: string,
  folderName: string,
  needsDisambiguation: boolean
): string {
  if (!needsDisambiguation) return folderName;

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length < 2) return folderName;

  const parent = segments[segments.length - 2];
  if (!parent) return folderName;

  return `${parent}/${folderName}`;
}

export function buildExternalContextDisplayEntries(
  externalContexts: string[]
): ExternalContextDisplayEntry[] {
  const counts = new Map<string, number>();
  const normalizedPaths = new Map<string, string>();

  for (const contextPath of externalContexts) {
    const normalized = normalizePathForComparison(contextPath);
    normalizedPaths.set(contextPath, normalized);
    const folderName = getFolderName(normalized);
    counts.set(folderName, (counts.get(folderName) ?? 0) + 1);
  }

  return externalContexts.map(contextRoot => {
    const normalized = normalizedPaths.get(contextRoot) ?? normalizePathForComparison(contextRoot);
    const folderName = getFolderName(contextRoot);
    const needsDisambiguation = (counts.get(folderName) ?? 0) > 1;
    const displayName = getContextDisplayName(normalized, folderName, needsDisambiguation);

    return {
      contextRoot,
      displayName,
      displayNameLower: displayName.toLowerCase(),
    };
  });
}

export interface DirectoryValidationResult {
  valid: boolean;
  error?: string;
}

export function validateDirectoryPath(p: string): DirectoryValidationResult {
  try {
    const stats = fs.statSync(p);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Path exists but is not a directory' };
    }
    return { valid: true };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { valid: false, error: 'Path does not exist' };
    }
    if (error.code === 'EACCES') {
      return { valid: false, error: 'Permission denied' };
    }
    return { valid: false, error: `Cannot access path: ${error.message}` };
  }
}

export function isValidDirectoryPath(p: string): boolean {
  return validateDirectoryPath(p).valid;
}

export function filterValidPaths(paths: string[]): string[] {
  return paths.filter(isValidDirectoryPath);
}

export function isDuplicatePath(newPath: string, existingPaths: string[]): boolean {
  const normalizedNew = normalizePathForComparison(newPath);
  return existingPaths.some(existing => normalizePathForComparison(existing) === normalizedNew);
}
