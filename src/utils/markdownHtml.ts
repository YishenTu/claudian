import { escapeHtml } from './html';
import { transformMarkdownSegments } from './markdownSegments';

/**
 * Escapes message-authored raw HTML before Obsidian's MarkdownRenderer sees it.
 *
 * This runs *before* trusted HTML injection points such as image embeds, so
 * user text like `<meta-name>` renders as plain text while intentional plugin
 * markup can still be inserted afterward.
 */
export function escapeRawHtmlTags(markdown: string): string {
  if (!markdown.includes('<')) {
    return markdown;
  }

  return transformMarkdownSegments(markdown, { rawHtml: escapeHtml });
}
