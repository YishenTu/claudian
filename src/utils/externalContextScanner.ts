/**
 * Geminian - External Context Scanner
 *
 * Scans configured external context paths for files to include in @-mention dropdown.
 * Features: recursive scanning, caching, and error handling.
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizePathForFilesystem } from './path';

export interface ExternalContextFile {
  path: string;
  name: string;
  relativePath: string;
  contextRoot: string;
  /** In milliseconds */
  mtime: number;
}

interface ScanCache {
  files: ExternalContextFile[];
  timestamp: number;
}

const CACHE_TTL_MS = 30000;
const MAX_FILES_PER_PATH = 1000;
const MAX_DEPTH = 10;

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

class ExternalContextScanner {
  private cache = new Map<string, ScanCache>();

  scanPaths(externalContextPaths: string[]): ExternalContextFile[] {
    const allFiles: ExternalContextFile[] = [];
    const now = Date.now();

    for (const contextPath of externalContextPaths) {
      const expandedPath = normalizePathForFilesystem(contextPath);

      const cached = this.cache.get(expandedPath);
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        allFiles.push(...cached.files);
        continue;
      }

      const files = this.scanDirectory(expandedPath, expandedPath, 0);
      this.cache.set(expandedPath, { files, timestamp: now });
      allFiles.push(...files);
    }

    return allFiles;
  }

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
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        // Symlinks can cause infinite recursion and directory escape
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
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
            // Inaccessible file
          }
        }

        if (files.length >= MAX_FILES_PER_PATH) break;
      }
    } catch {
      // Inaccessible directory
    }

    return files;
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  invalidatePath(contextPath: string): void {
    const expandedPath = normalizePathForFilesystem(contextPath);
    this.cache.delete(expandedPath);
  }
}

export const externalContextScanner = new ExternalContextScanner();
