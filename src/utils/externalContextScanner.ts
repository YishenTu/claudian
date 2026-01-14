/**
 * Claudian - External Context Scanner
 *
 * Scans configured external context paths for files to include in @-mention dropdown.
 * Features: recursive scanning, caching, and error handling.
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizePathForFilesystem } from './path';

/** File information from an external context path. */
export interface ExternalContextFile {
  /** Absolute file path */
  path: string;
  /** Filename */
  name: string;
  /** Path relative to context root */
  relativePath: string;
  /** Which external context path this file belongs to */
  contextRoot: string;
  /** Modification time in milliseconds */
  mtime: number;
}

interface ScanCache {
  files: ExternalContextFile[];
  timestamp: number;
}

/** Cache TTL in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30000;

/** Maximum files to scan per external context path */
const MAX_FILES_PER_PATH = 1000;

/** Maximum directory depth to prevent infinite recursion */
const MAX_DEPTH = 10;

/** Directories to skip during scanning */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  '.venv',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  'Pods',
]);

/**
 * Scanner for files in external context paths.
 * Caches results to avoid repeated filesystem scans.
 */
class ExternalContextScanner {
  private cache = new Map<string, ScanCache>();

  /**
   * Scans all external context paths and returns matching files.
   * Uses cached results when available.
   */
  scanPaths(externalContextPaths: string[]): ExternalContextFile[] {
    const allFiles: ExternalContextFile[] = [];
    const now = Date.now();

    for (const contextPath of externalContextPaths) {
      const expandedPath = normalizePathForFilesystem(contextPath);

      // Check cache first
      const cached = this.cache.get(expandedPath);
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        allFiles.push(...cached.files);
        continue;
      }

      // Scan directory
      const files = this.scanDirectory(expandedPath, expandedPath, 0);
      this.cache.set(expandedPath, { files, timestamp: now });
      allFiles.push(...files);
    }

    return allFiles;
  }

  /**
   * Recursively scans a directory for files.
   */
  private scanDirectory(
    dir: string,
    contextRoot: string,
    depth: number
  ): ExternalContextFile[] {
    if (depth > MAX_DEPTH) return [];

    const files: ExternalContextFile[] = [];

    try {
      if (!fs.existsSync(dir)) return [];

      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) return [];

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files/directories
        if (entry.name.startsWith('.')) continue;

        // Skip common large/build directories
        if (SKIP_DIRECTORIES.has(entry.name)) continue;

        // Skip symlinks to prevent infinite recursion and directory escape
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectories
          const subFiles = this.scanDirectory(fullPath, contextRoot, depth + 1);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          try {
            const fileStat = fs.statSync(fullPath);
            files.push({
              path: fullPath,
              name: entry.name,
              relativePath: path.relative(contextRoot, fullPath),
              contextRoot,
              mtime: fileStat.mtimeMs,
            });
          } catch {
            // Skip files that can't be stat'd
          }
        }

        // Limit total files per external context path
        if (files.length >= MAX_FILES_PER_PATH) break;
      }
    } catch {
      // Skip directories that can't be scanned
    }

    return files;
  }

  /** Clears all cached results. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /** Clears cached results for a specific external context path. */
  invalidatePath(contextPath: string): void {
    const expandedPath = normalizePathForFilesystem(contextPath);
    this.cache.delete(expandedPath);
  }
}

/** Singleton scanner instance. */
export const externalContextScanner = new ExternalContextScanner();
