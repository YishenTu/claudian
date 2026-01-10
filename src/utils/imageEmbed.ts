/**
 * Claudian - Image Embed Utilities
 *
 * Replaces Obsidian image embeds ![[image.png]] with HTML <img> tags
 * before MarkdownRenderer processes the content.
 *
 * Note: This is display-only - the agent still receives the wikilink text.
 */

import type { App, TFile } from 'obsidian';

/**
 * Supported image extensions for rendering.
 */
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

/**
 * Regex pattern to match Obsidian image embeds.
 */
const IMAGE_EMBED_PATTERN = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Checks if a path is an image based on extension.
 */
function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/**
 * Resolves an image path to a TFile, checking multiple locations.
 */
function resolveImageFile(
  app: App,
  imagePath: string,
  mediaFolder: string
): TFile | null {
  // Try direct path first
  let file = app.vault.getFileByPath(imagePath);
  if (file) return file;

  // Try with media folder prefix
  if (mediaFolder) {
    const withFolder = `${mediaFolder}/${imagePath}`;
    file = app.vault.getFileByPath(withFolder);
    if (file) return file;
  }

  // Try metadata cache for partial matches
  const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, '');
  if (resolved) return resolved;

  return null;
}

/**
 * Escapes HTML special characters in a string.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds style attribute for image dimensions from alt text.
 * Supports formats: "100" (width only) or "100x200" (width x height)
 */
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

/**
 * Creates HTML for an image embed.
 */
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

/**
 * Creates fallback HTML when image file is not found.
 */
function createFallbackHtml(wikilink: string): string {
  return `<span class="claudian-embedded-image-fallback">${escapeHtml(wikilink)}</span>`;
}

/**
 * Replaces image embeds with HTML img tags in markdown content.
 * This should be called before MarkdownRenderer.renderMarkdown().
 *
 * Non-image embeds (e.g., ![[note.md]]) pass through unchanged.
 * Missing image files render as styled fallback text.
 *
 * @param markdown The raw markdown content
 * @param app Obsidian App instance
 * @param mediaFolder The configured media folder path (defaults to empty string)
 * @returns Markdown with image embeds replaced by HTML img tags
 */
export function replaceImageEmbedsWithHtml(
  markdown: string,
  app: App,
  mediaFolder: string = ''
): string {
  // Defensive check for app state
  if (!app?.vault || !app?.metadataCache) {
    return markdown;
  }

  // Reset lastIndex to avoid issues with global regex
  IMAGE_EMBED_PATTERN.lastIndex = 0;

  return markdown.replace(
    IMAGE_EMBED_PATTERN,
    (match, imagePath: string, altText: string | undefined) => {
      try {
        // Not an image, leave as-is for MarkdownRenderer
        if (!isImagePath(imagePath)) {
          return match;
        }

        // Resolve the image file
        const file = resolveImageFile(app, imagePath, mediaFolder);
        if (!file) {
          return createFallbackHtml(match);
        }

        // Create img tag with resolved file
        return createImageHtml(app, file, altText);
      } catch {
        return createFallbackHtml(match);
      }
    }
  );
}
