/**
 * Image loading utilities.
 *
 * Shared between the service (SDK payload hydration) and the view (UI rendering).
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import * as path from 'path';

import type { ImageAttachment } from '../types';
import { getVaultPath } from '../utils/path';
import { readCachedImageBase64 } from './imageCache';

export function resolveImageFilePath(filePath: string, vaultPath: string | null): string | null {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  if (vaultPath) {
    return path.join(vaultPath, filePath);
  }
  return null;
}

function readFileBase64(absPath: string): string | null {
  try {
    const buffer = fs.readFileSync(absPath);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

export function readImageAttachmentBase64(
  app: App,
  image: ImageAttachment,
  vaultPath?: string | null
): string | null {
  if (image.cachePath) {
    const cached = readCachedImageBase64(app, image.cachePath);
    if (cached) return cached;
  }

  if (image.filePath) {
    const vault = vaultPath ?? getVaultPath(app);
    const absPath = resolveImageFilePath(image.filePath, vault);
    if (absPath && fs.existsSync(absPath)) {
      return readFileBase64(absPath);
    }
  }

  return null;
}

export function ensureImageAttachmentBase64(
  app: App,
  image: ImageAttachment,
  vaultPath?: string | null
): string | null {
  if (image.data) return image.data;
  const base64 = readImageAttachmentBase64(app, image, vaultPath);
  if (base64) {
    image.data = base64;
  }
  return base64;
}

export function toImageDataUri(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export function getImageAttachmentDataUri(
  app: App,
  image: ImageAttachment,
  vaultPath?: string | null
): string | null {
  const base64 = ensureImageAttachmentBase64(app, image, vaultPath);
  if (!base64) return null;
  return toImageDataUri(image.mediaType, base64);
}

export async function hydrateImagesData(
  app: App,
  images?: ImageAttachment[],
  vaultPath?: string | null
): Promise<ImageAttachment[] | undefined> {
  if (!images || images.length === 0) return undefined;

  const hydrated: ImageAttachment[] = [];

  for (const image of images) {
    if (image.data) {
      hydrated.push(image);
      continue;
    }

    const base64 = readImageAttachmentBase64(app, image, vaultPath);
    if (base64) {
      hydrated.push({ ...image, data: base64 });
    }
  }

  return hydrated.length > 0 ? hydrated : undefined;
}
