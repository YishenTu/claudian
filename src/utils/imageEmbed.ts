/**
 * Claudian - Image Embed Utilities
 *
 * Replaces Obsidian image embeds ![[image.png]] with HTML <img> tags
 * before MarkdownRenderer processes the content.
 *
 * Note: This is display-only - the agent still receives the wikilink text.
 */

import type { App, TFile } from 'obsidian';

import { escapeHtml } from './inlineEdit';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

const IMAGE_EMBED_PATTERN = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

function resolveImageFile(
  app: App,
  imagePath: string,
  mediaFolder: string
): TFile | null {
  let file = app.vault.getFileByPath(imagePath);
  if (file) return file;

  if (mediaFolder) {
    const withFolder = `${mediaFolder}/${imagePath}`;
    file = app.vault.getFileByPath(withFolder);
    if (file) return file;
  }

  const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, '');
  if (resolved) return resolved;

  return null;
}


/** Supports formats: "100" (width only) or "100x200" (width x height) */
function buildStyleAttribute(altText: string | undefined): string {
  if (!altText) return '';

  const dimMatch = altText.match(/^(\d+)(?:x(\d+))?$/);
  if (!dimMatch) return '';

  const width = dimMatch[1];
  const height = dimMatch[2];

  if (height) {
    return ` style="width: ${width}px; height: ${height}px;"`;
  }
  return ` style="width: ${width}px;"`;
}

function createImageHtml(
  app: App,
  file: TFile,
  altText: string | undefined
): string {
  const src = app.vault.getResourcePath(file);
  const alt = escapeHtml(altText || file.basename);
  const style = buildStyleAttribute(altText);

  return `<span class="claudian-embedded-image"><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy"${style}></span>`;
}

function createFallbackHtml(wikilink: string): string {
  return `<span class="claudian-embedded-image-fallback">${escapeHtml(wikilink)}</span>`;
}

/**
 * Call before MarkdownRenderer.renderMarkdown().
 * Non-image embeds (e.g., ![[note.md]]) pass through unchanged.
 */
export function replaceImageEmbedsWithHtml(
  markdown: string,
  app: App,
  mediaFolder: string = ''
): string {
  if (!app?.vault || !app?.metadataCache) {
    return markdown;
  }

  // Reset lastIndex to avoid issues with global regex
  IMAGE_EMBED_PATTERN.lastIndex = 0;

  return markdown.replace(
    IMAGE_EMBED_PATTERN,
    (match, imagePath: string, altText: string | undefined) => {
      try {
        if (!isImagePath(imagePath)) {
          return match;
        }

        const file = resolveImageFile(app, imagePath, mediaFolder);
        if (!file) {
          return createFallbackHtml(match);
        }

        return createImageHtml(app, file, altText);
      } catch {
        return createFallbackHtml(match);
      }
    }
  );
}
