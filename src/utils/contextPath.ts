/**
 * Claudian - Context Path Utilities
 *
 * Utilities for context path validation, normalization, and conflict detection.
 */

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
 * @param existingPaths - Array of existing context paths
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
