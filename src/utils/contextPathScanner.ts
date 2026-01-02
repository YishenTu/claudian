/**
 * Claudian - Context Path Scanner
 *
 * Scans configured context paths for files to include in @-mention dropdown.
 * Features: recursive scanning, caching, and error handling.
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizePathForFilesystem } from './path';

/** File information from a context path. */
export interface ContextPathFile {
  /** Absolute file path */
  path: string;
  /** Filename */
  name: string;
  /** Path relative to context root */
  relativePath: string;
  /** Which context path this file belongs to */
  contextRoot: string;
  /** Modification time in milliseconds */
  mtime: number;
}

interface ScanCache {
  files: ContextPathFile[];
  timestamp: number;
}

/** Cache TTL in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30000;

/** Maximum files to scan per context path */
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
 * Scanner for files in context paths.
 * Caches results to avoid repeated filesystem scans.
 */
class ContextPathScanner {
  private cache = new Map<string, ScanCache>();

  /**
   * Scans all context paths and returns matching files.
   * Uses cached results when available.
   */
  scanPaths(contextPaths: string[]): ContextPathFile[] {
    const allFiles: ContextPathFile[] = [];
    const now = Date.now();

    for (const contextPath of contextPaths) {
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
  ): ContextPathFile[] {
    if (depth > MAX_DEPTH) return [];

    const files: ContextPathFile[] = [];

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
          } catch (err) {
            console.debug(`Skipped file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Limit total files per context path
        if (files.length >= MAX_FILES_PER_PATH) break;
      }
    } catch (err) {
      console.warn(`Failed to scan context directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return files;
  }

  /** Clears all cached results. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /** Clears cached results for a specific context path. */
  invalidatePath(contextPath: string): void {
    const expandedPath = normalizePathForFilesystem(contextPath);
    this.cache.delete(expandedPath);
  }
}

/** Singleton scanner instance. */
export const contextPathScanner = new ContextPathScanner();
