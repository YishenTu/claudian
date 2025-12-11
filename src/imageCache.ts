/**
 * Claudian - Image cache management
 *
 * Handles caching of pasted/dropped images with content-addressed storage.
 * Images are stored with SHA-256 hash filenames for deduplication.
 */

import { App } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ImageMediaType } from './types';
import { getVaultPath } from './utils';

export const IMAGE_CACHE_DIR = '.claudian-cache/images';

/** Ensures the cache directory exists and returns its absolute path. */
export function ensureImageCacheDir(app: App): string | null {
  const vaultPath = getVaultPath(app);
  if (!vaultPath) return null;
  const cacheDir = path.join(vaultPath, IMAGE_CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/** Saves an image buffer to cache with content-hash filename. Returns relative and absolute paths. */
export function saveImageToCache(
  app: App,
  buffer: Buffer,
  mediaType: ImageMediaType,
  preferredName?: string
): { relPath: string; absPath: string } | null {
  const cacheDir = ensureImageCacheDir(app);
  if (!cacheDir) return null;

  const hash = createHash('sha256').update(buffer).digest('hex');
  const ext = getExtension(mediaType, preferredName);
  const filename = `${hash}${ext}`;
  const relPath = path.posix.join(IMAGE_CACHE_DIR, filename);
  const absPath = path.join(cacheDir, filename);

  if (!fs.existsSync(absPath)) {
    fs.writeFileSync(absPath, buffer);
  }

  return { relPath, absPath };
}

/** Reads a cached image as base64 string, or null if not found. */
export function readCachedImageBase64(app: App, relPath: string): string | null {
  const absPath = getCacheAbsolutePath(app, relPath);
  if (!absPath) return null;
  try {
    const buffer = fs.readFileSync(absPath);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

/** Deletes cached images by relative paths (silently ignores missing files). */
export function deleteCachedImages(app: App, relPaths: string[]) {
  const seen = new Set<string>();
  for (const relPath of relPaths) {
    const normalized = normalizeCacheRelPath(relPath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    const absPath = getCacheAbsolutePath(app, normalized);
    if (absPath && fs.existsSync(absPath)) {
      try {
        fs.unlinkSync(absPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/** Resolves a cache-relative path to absolute, validating it stays within cache. */
export function getCacheAbsolutePath(app: App, relPath: string): string | null {
  const vaultPath = getVaultPath(app);
  if (!vaultPath) return null;

  const normalizedRel = normalizeCacheRelPath(relPath);
  if (!normalizedRel) return null;

  const absPath = path.resolve(vaultPath, normalizedRel);
  const cacheRoot = path.resolve(vaultPath, IMAGE_CACHE_DIR);
  if (!absPath.startsWith(cacheRoot)) {
    return null;
  }
  return absPath;
}

function normalizeCacheRelPath(relPath: string): string | null {
  if (!relPath) return null;
  const normalized = relPath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized)) return null;
  if (!normalized.startsWith(IMAGE_CACHE_DIR)) return null;
  return normalized;
}

function getExtension(mediaType: ImageMediaType, preferredName?: string): string {
  if (preferredName) {
    const ext = path.extname(preferredName);
    if (ext) return ext;
  }
  const subtype = mediaType.split('/')[1] || 'png';
  return `.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}
