import type { ImageAttachment, ImageMediaType } from '../core/types';

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  'image/gif': 'image/gif',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const IMAGE_EXTENSIONS: Record<ImageMediaType, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface ParsedImageDataUri {
  data: string;
  mediaType: ImageMediaType;
}

export interface BuildImageAttachmentOptions {
  data: string;
  id: string;
  mediaType: string;
  name?: string;
}

export function normalizeImageMediaType(value: unknown): ImageMediaType | null {
  if (typeof value !== 'string') {
    return null;
  }

  return IMAGE_MEDIA_TYPES[value.trim().toLowerCase()] ?? null;
}

export function parseImageDataUri(value: unknown): ParsedImageDataUri | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  const mediaType = normalizeImageMediaType(match[1]);
  const data = match[2]?.trim();
  if (!mediaType || !data) {
    return null;
  }

  return { data, mediaType };
}

export function buildImageAttachmentFromBase64(
  options: BuildImageAttachmentOptions,
): ImageAttachment | null {
  const mediaType = normalizeImageMediaType(options.mediaType);
  const data = options.data.trim();
  if (!mediaType || !data) {
    return null;
  }

  return {
    data,
    id: options.id,
    mediaType,
    name: options.name?.trim() || `image.${IMAGE_EXTENSIONS[mediaType]}`,
    size: estimateBase64ByteLength(data),
    source: 'paste',
  };
}

function estimateBase64ByteLength(value: string): number {
  const data = value.replace(/\s/g, '');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
