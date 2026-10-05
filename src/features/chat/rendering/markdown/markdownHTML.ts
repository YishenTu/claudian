import { escapeHTML } from '@/utils/html';
import { transformMarkdownSegments } from '@/utils/markdownSegments';

/**
 * Escapes message-authored raw HTML before Obsidian's MarkdownRenderer sees it.
 *
 * This runs *before* trusted HTML injection points such as image embeds, so
 * user text like `<meta-name>` renders as plain text while intentional plugin
 * markup can still be inserted afterward.
 */
export function escapeRawHTMLTags(markdown: string): string {
  if (!markdown.includes('<')) {
    return markdown;
  }

  return transformMarkdownSegments(markdown, { rawHtml: escapeHTML });
}
