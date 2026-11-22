/**
 * Claudian - Image Embed Utilities
 *
 * Replaces Obsidian image embeds ![[image.png]] with HTML <img> tags
 * before MarkdownRenderer processes the content.
 *
 * Note: This is display-only - the agent still receives the wikilink text.
 */

import type { App, TFile } from 'obsidian';
import * as path from 'path';

import { escapeHTML } from './html';
import { transformMarkdownSegments } from './markdownSegments';
import { getVaultFileByPath } from './obsidianCompat';

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

/** Native button wrapping an embedded image whose host lets it open a full preview. */
export const EMBEDDED_IMAGE_BUTTON_CLASS = 'claudian-embedded-image-button';

const IMAGE_EMBED_PATTERN = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

interface ReplaceImageEmbedsOptions {
  mediaFolder?: string;
  sourcePath?: string;
}

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

function resolveImageFile(
  app: App,
  imagePath: string,
  options: Required<ReplaceImageEmbedsOptions>
): TFile | null {
  // With a note context, resolve the embed through Obsidian's note-relative
  // link resolution before the configured media-folder fallback.
  if (options.sourcePath) {
    const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, options.sourcePath);
    if (resolved) return resolved;
  }

  let file = getVaultFileByPath(app, imagePath);
  if (file) return file;

  if (options.mediaFolder) {
    const { mediaFolder } = options;
    const isVaultRelative = !path.posix.isAbsolute(mediaFolder) && !path.win32.isAbsolute(mediaFolder)
      && !mediaFolder.split('/').includes('..');
    const folder = isVaultRelative ? path.posix.normalize(mediaFolder).replace(/\/$/, '') : mediaFolder;
    const withFolder = `${folder}/${imagePath}`;
    file = getVaultFileByPath(app, withFolder);
    if (file) return file;
  }

  if (options.sourcePath) {
    return null;
  }

  return app.metadataCache.getFirstLinkpathDest(imagePath, options.sourcePath);
}


const DIMENSIONS_PATTERN = /^(\d+)(?:x(\d+))?$/;

/** Supports formats: "100" (width only) or "100x200" (width x height) */
function buildStyleAttribute(altText: string | undefined): string {
  if (!altText) return '';

  const dimMatch = altText.match(DIMENSIONS_PATTERN);
  if (!dimMatch) return '';

  const width = dimMatch[1];
  const height = dimMatch[2];

  if (height) {
    return ` style="width: ${width}px; height: ${height}px;"`;
  }
  return ` style="width: ${width}px;"`;
}

function createImageHTML(
  app: App,
  file: TFile,
  altText: string | undefined
): string {
  const src = app.vault.getResourcePath(file);
  // A size spec is not a description, so the file name stays the image's accessible name.
  const alt = escapeHTML(altText && !DIMENSIONS_PATTERN.test(altText) ? altText : file.basename);
  const style = buildStyleAttribute(altText);

  return `<span class="claudian-embedded-image"><img src="${escapeHTML(src)}" alt="${alt}" loading="lazy"${style}></span>`;
}

function createFallbackHTML(wikilink: string): string {
  return `<span class="claudian-embedded-image-fallback">${escapeHTML(wikilink)}</span>`;
}

function normalizeOptions(options?: string | ReplaceImageEmbedsOptions): Required<ReplaceImageEmbedsOptions> {
  if (typeof options === 'string') {
    return { mediaFolder: options, sourcePath: '' };
  }

  return {
    mediaFolder: options?.mediaFolder ?? '',
    sourcePath: options?.sourcePath ?? '',
  };
}

/**
 * Call before MarkdownRenderer.render().
 * Non-image embeds (e.g., ![[note.md]]) pass through unchanged.
 */
export function replaceImageEmbedsWithHTML(
  markdown: string,
  app: App,
  options?: string | ReplaceImageEmbedsOptions
): string {
  if (!markdown.includes('![[') || !app?.vault || !app?.metadataCache) {
    return markdown;
  }

  const normalizedOptions = normalizeOptions(options);

  // Reset lastIndex to avoid issues with global regex
  IMAGE_EMBED_PATTERN.lastIndex = 0;

  return transformMarkdownSegments(markdown, {
    wikilink: (wikilink, { embedded }) => {
      if (!embedded) {
        return wikilink;
      }

      return wikilink.replace(
        IMAGE_EMBED_PATTERN,
        (match, imagePath: string, altText: string | undefined) => {
          try {
            if (!isImagePath(imagePath)) {
              return match;
            }

            const file = resolveImageFile(app, imagePath, normalizedOptions);
            if (!file) {
              return createFallbackHTML(match);
            }

            return createImageHTML(app, file, altText);
          } catch {
            return createFallbackHTML(match);
          }
        }
      );
    },
  });
}

/**
 * Wraps each rendered embedded image in a native button that opens it full size. Runs on the
 * rendered DOM so it does not depend on the host Markdown sanitizer keeping `<button>` markup.
 */
export function makeEmbeddedImagesPreviewable(container: HTMLElement, label: (name: string) => string): void {
  for (const image of container.querySelectorAll<HTMLImageElement>('.claudian-embedded-image > img')) {
    // The generated wrapper holds only the image, so appending keeps its position.
    const button = image.parentElement!.createEl('button', {
      cls: EMBEDDED_IMAGE_BUTTON_CLASS,
      attr: { type: 'button', 'aria-label': label(image.alt) },
    });
    button.appendChild(image);
  }
}
