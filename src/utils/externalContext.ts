/**
 * Claudian - External Context Utilities
 *
 * Utilities for external context validation, normalization, and conflict detection.
 */

import * as fs from 'fs';

import { normalizePathForComparison as normalizePathForComparisonImpl } from './path';

/** Conflict detection result type. */
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

/**
 * Checks if a new path conflicts with existing paths (nested or overlapping).
 * Returns the conflicting path if found, null otherwise.
 *
 * @param newPath - The new path to add
 * @param existingPaths - Array of existing external context paths
 * @returns Conflict info or null if no conflict
 */
export function findConflictingPath(
  newPath: string,
  existingPaths: string[]
): PathConflict | null {
  const normalizedNew = normalizePathForComparison(newPath);

  for (const existing of existingPaths) {
    const normalizedExisting = normalizePathForComparison(existing);

    // Check if new path is a child of existing (existing is parent)
    if (normalizedNew.startsWith(normalizedExisting + '/')) {
      return { path: existing, type: 'parent' };
    }

    // Check if new path is a parent of existing (new would contain existing)
    if (normalizedExisting.startsWith(normalizedNew + '/')) {
      return { path: existing, type: 'child' };
    }
  }

  return null;
}

/**
 * Extracts the folder name (last path segment) from a path.
 * @param p - The path to extract the folder name from
 * @returns The folder name (last path segment)
 */
export function getFolderName(p: string): string {
  const normalized = normalizePathForDisplay(p);
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

/** Result of directory path validation. */
export interface DirectoryValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Checks if a path exists and is a directory.
 * @param p - The path to check
 * @returns Validation result with specific error message if invalid
 */
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

/**
 * Checks if a path exists and is a directory.
 * @param p - The path to check
 * @returns true if path exists and is a directory, false otherwise
 */
export function isValidDirectoryPath(p: string): boolean {
  return validateDirectoryPath(p).valid;
}

/**
 * Filters an array of paths to only include valid directories.
 * @param paths - Array of paths to validate
 * @returns Array of paths that exist and are directories
 */
export function filterValidPaths(paths: string[]): string[] {
  return paths.filter(isValidDirectoryPath);
}

/**
 * Checks if a path is a duplicate of any existing paths (normalized comparison).
 * @param newPath - The new path to check
 * @param existingPaths - Array of existing paths
 * @returns true if path is a duplicate, false otherwise
 */
export function isDuplicatePath(newPath: string, existingPaths: string[]): boolean {
  const normalizedNew = normalizePathForComparison(newPath);
  return existingPaths.some(existing => normalizePathForComparison(existing) === normalizedNew);
}
