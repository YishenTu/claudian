/**
 * Claudian - File Link Utilities
 *
 * Detects Obsidian wikilinks [[path/to/file]] in rendered content and makes
 * them clickable to open the file in Obsidian.
 */

import type { App, Component } from 'obsidian';

/**
 * Regex pattern to match Obsidian wikilinks in text content.
 *
 * Matches:
 * - Standard wikilinks: [[note]] or [[folder/note]]
 * - Wikilinks with display text: [[note|display text]]
 * - Wikilinks with headings: [[note#heading]]
 * - Wikilinks with block references: [[note^block]]
 *
 * Does NOT match image embeds ![[image.png]] (those are handled separately).
 */
const WIKILINK_PATTERN = /(?<!!)\[\[([^\]|#^]+)(?:#[^\]|]+)?(?:\^[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

interface WikilinkMatch {
  index: number;
  fullMatch: string;
  linkPath: string;
  linkTarget: string;
  displayText: string;
}

export function extractLinkTarget(fullMatch: string): string {
  const inner = fullMatch.slice(2, -2);
  const pipeIndex = inner.indexOf('|');
  return pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
}

/**
 * Finds all wikilinks in text that exist in the vault.
 * Sorted by index descending for end-to-start processing.
 */
function findWikilinks(app: App, text: string): WikilinkMatch[] {
  WIKILINK_PATTERN.lastIndex = 0;
  const matches: WikilinkMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(text)) !== null) {
    const fullMatch = match[0];
    const linkPath = match[1];
    const linkTarget = extractLinkTarget(fullMatch);

    if (!fileExistsInVault(app, linkPath)) continue;

    const pipeIndex = fullMatch.lastIndexOf('|');
    const displayText = pipeIndex > 0 ? fullMatch.slice(pipeIndex + 1, -2) : linkPath;

    matches.push({ index: match.index, fullMatch, linkPath, linkTarget, displayText });
  }

  return matches.sort((a, b) => b.index - a.index);
}

/**
 * Checks if a file exists in the vault.
 */
function fileExistsInVault(app: App, linkPath: string): boolean {
  // Try to find the file using metadataCache (handles aliases, partial matches)
  const file = app.metadataCache.getFirstLinkpathDest(linkPath, '');
  if (file) {
    return true;
  }

  // Also try direct path lookup
  const directFile = app.vault.getFileByPath(linkPath);
  if (directFile) {
    return true;
  }

  // Try with .md extension if not present
  if (!linkPath.endsWith('.md')) {
    const withExt = app.vault.getFileByPath(linkPath + '.md');
    if (withExt) {
      return true;
    }
  }

  return false;
}

/**
 * Creates a link element for a wikilink.
 * Click handling is done via event delegation in registerFileLinkHandler.
 */
function createWikilink(
  linkTarget: string,
  displayText: string
): HTMLElement {
  const link = document.createElement('a');
  link.className = 'claudian-file-link internal-link';
  link.textContent = displayText;
  link.setAttribute('data-href', linkTarget);
  link.setAttribute('href', linkTarget);
  return link;
}

/**
 * Registers a delegated click handler for file links on a container.
 * Should be called once on the messages container.
 * Handles both our custom .claudian-file-link and Obsidian's .internal-link.
 */
export function registerFileLinkHandler(
  app: App,
  container: HTMLElement,
  component: Component
): void {
  component.registerDomEvent(container, 'click', (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    // Handle both our links and Obsidian's internal links
    const link = target.closest('.claudian-file-link, .internal-link') as HTMLAnchorElement;

    if (link) {
      event.preventDefault();
      const linkTarget = link.dataset.href || link.getAttribute('href');
      if (linkTarget) {
        void app.workspace.openLinkText(linkTarget, '', 'tab');
      }
    }
  });
}

/**
 * Builds a document fragment with wikilinks replaced by clickable links.
 */
function buildFragmentWithLinks(text: string, matches: WikilinkMatch[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let currentIndex = text.length;

  for (const { index, fullMatch, linkTarget, displayText } of matches) {
    const endIndex = index + fullMatch.length;

    if (endIndex < currentIndex) {
      fragment.insertBefore(
        document.createTextNode(text.slice(endIndex, currentIndex)),
        fragment.firstChild
      );
    }

    fragment.insertBefore(createWikilink(linkTarget, displayText), fragment.firstChild);
    currentIndex = index;
  }

  if (currentIndex > 0) {
    fragment.insertBefore(
      document.createTextNode(text.slice(0, currentIndex)),
      fragment.firstChild
    );
  }

  return fragment;
}

/**
 * Processes a text node and replaces wikilinks with clickable links.
 * Returns true if any replacements were made.
 */
function processTextNode(app: App, node: Text): boolean {
  const text = node.textContent;
  if (!text || !text.includes('[[')) return false;

  const matches = findWikilinks(app, text);
  if (matches.length === 0) return false;

  node.parentNode?.replaceChild(buildFragmentWithLinks(text, matches), node);
  return true;
}

/**
 * Processes rendered content to make wikilinks clickable.
 * This should be called after MarkdownRenderer.renderMarkdown().
 *
 * Obsidian's MarkdownRenderer may not process wikilinks in code blocks
 * or certain contexts, so this function catches those cases.
 *
 * @param app Obsidian App instance
 * @param container The container element with rendered markdown
 */
export function processFileLinks(app: App, container: HTMLElement): void {
  // Skip if no app or container
  if (!app || !container) return;

  // Process text within inline code elements
  // (wikilinks in inline code aren't rendered by Obsidian's MarkdownRenderer)
  container.querySelectorAll('code').forEach((codeEl) => {
    if (codeEl.parentElement?.tagName === 'PRE') return;

    const text = codeEl.textContent;
    if (!text || !text.includes('[[')) return;

    const matches = findWikilinks(app, text);
    if (matches.length === 0) return;

    codeEl.textContent = '';
    codeEl.appendChild(buildFragmentWithLinks(text, matches));
  });

  // Process regular text nodes (not in code blocks or already-rendered links)
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip nodes inside <pre>, <code>, <a>, or already processed links
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tagName = parent.tagName.toUpperCase();
        if (tagName === 'PRE' || tagName === 'CODE' || tagName === 'A') {
          return NodeFilter.FILTER_REJECT;
        }

        // Skip if parent or ancestor is a code block or link
        if (parent.closest('pre, code, a, .claudian-file-link, .internal-link')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  // Collect text nodes first (modifying while walking causes issues)
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Process each text node
  for (const textNode of textNodes) {
    processTextNode(app, textNode);
  }
}
