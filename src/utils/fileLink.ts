/**
 * Claudian - File Link Utilities
 *
 * Detects Obsidian wikilinks [[path/to/file]] in rendered content and makes
 * them clickable to open the file in Obsidian.
 */

import type { App, PaneType, WorkspaceLeaf } from 'obsidian';
import { Keymap, Notice } from 'obsidian';

import { getVaultFileByPath } from './obsidianCompat';

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
const WIKILINK_PATTERN_SOURCE = '(?<!!)\\[\\[([^\\]|#^]*)(?:#[^\\]|]+)?(?:\\^[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]';

/** Creates a fresh regex instance to avoid global state issues */
function createWikilinkPattern(): RegExp {
  return new RegExp(WIKILINK_PATTERN_SOURCE, 'g');
}

interface WikilinkMatch {
  index: number;
  fullMatch: string;
  linkPath: string;
  linkTarget: string;
  displayText: string;
}

function buildWikilinkMatch(
  fullMatch: string,
  linkPath: string,
  index: number
): WikilinkMatch {
  const pipeIndex = fullMatch.indexOf('|');
  const displayText = pipeIndex > 0 ? fullMatch.slice(pipeIndex + 1, -2) : linkPath || extractLinkTarget(fullMatch);

  return {
    index,
    fullMatch,
    linkPath,
    linkTarget: extractLinkTarget(fullMatch),
    displayText,
  };
}

function extractLinkTarget(fullMatch: string): string {
  const inner = fullMatch.slice(2, -2);
  const pipeIndex = inner.indexOf('|');
  return pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
}

/**
 * Finds all wikilinks in text that exist in the vault.
 * Sorted by index descending for end-to-start processing.
 */
function findWikilinks(app: App, text: string, sourcePath: string): WikilinkMatch[] {
  return parseWikilinks(text, sourcePath).filter(match => fileExistsInVault(app, match.linkPath, sourcePath));
}

/** Parses source for text replacement; same-note targets need an explicit note context. */
export function parseWikilinks(text: string, sourcePath = ''): WikilinkMatch[] {
  const pattern = createWikilinkPattern();
  const matches: WikilinkMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const linkPath = match[1];
    // A same-note target is meaningful only for a consumer with an explicit source.
    if (!linkPath && (!sourcePath || !extractLinkTarget(fullMatch).startsWith('#'))) continue;

    matches.push(buildWikilinkMatch(fullMatch, linkPath, match.index));
  }

  return matches.sort((a, b) => b.index - a.index);
}

function fileExistsInVault(app: App, linkPath: string, sourcePath: string): boolean {
  if (!linkPath) return !!sourcePath && !!getVaultFileByPath(app, sourcePath);
  const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
  if (file) {
    return true;
  }

  const directFile = getVaultFileByPath(app, linkPath);
  if (directFile) {
    return true;
  }

  if (!linkPath.endsWith('.md')) {
    const withExt = getVaultFileByPath(app, linkPath + '.md');
    if (withExt) {
      return true;
    }
  }

  return false;
}

function extractLinkPathFromTarget(linkTarget: string): string {
  const subpathIndex = linkTarget.search(/[#^]/);
  return subpathIndex >= 0 ? linkTarget.slice(0, subpathIndex) : linkTarget;
}

/**
 * Creates a link element for a wikilink.
 * Click handling is done via event delegation in registerFileLinkHandler.
 */
function createWikilink(
  parent: HTMLElement,
  linkTarget: string,
  displayText: string
): HTMLElement {
  return parent.createEl('a', {
    cls: 'claudian-file-link internal-link',
    text: displayText,
    attr: {
      'data-href': linkTarget,
      href: linkTarget,
    },
  });
}

function repairEmptyInternalLink(app: App, link: HTMLAnchorElement, sourcePath: string): void {
  if ((link.textContent || '').trim()) return;

  const linkTarget = link.dataset.href || link.getAttribute('data-href') || link.getAttribute('href');
  if (!linkTarget) return;

  const linkPath = extractLinkPathFromTarget(linkTarget);
  if (!linkPath || !fileExistsInVault(app, linkPath, sourcePath)) return;

  link.classList.add('claudian-file-link');
  if (!link.dataset.href) {
    link.setAttribute('data-href', linkTarget);
  }
  link.textContent = linkTarget;
}

async function openFileLink(app: App, linkTarget: string, sourcePath: string, newPane: PaneType | boolean): Promise<void> {
  if (newPane) {
    await app.workspace.openLinkText(linkTarget, sourcePath, newPane);
    return;
  }
  const linkPath = extractLinkPathFromTarget(linkTarget);
  const file = linkPath
    ? app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)
    : sourcePath ? getVaultFileByPath(app, sourcePath) : null;
  let existingLeaf: WorkspaceLeaf | undefined;
  if (file) {
    const { leftSplit, rightSplit } = app.workspace;
    app.workspace.iterateAllLeaves(leaf => {
      if (existingLeaf) return;
      // Sidebar views such as Outline and Backlinks also keep the path of the note they track.
      const root = leaf.getRoot();
      if (root === leftSplit || root === rightSplit) return;
      if (leaf.getViewState().state?.file === file.path) {
        existingLeaf = leaf;
      }
    });
  }
  if (existingLeaf) {
    await app.workspace.revealLeaf(existingLeaf);
    const subpath = linkTarget.slice(linkPath.length);
    existingLeaf.setEphemeralState({ focus: true, ...(subpath ? { subpath } : {}) });
    return;
  }
  await app.workspace.openLinkText(linkTarget, sourcePath, 'tab');
}

/**
 * Registers a delegated click handler for file links on a container.
 * Should be called once on the messages container.
 * Handles both our custom .claudian-file-link and Obsidian's .internal-link.
 */
export function registerFileLinkHandler(
  app: App,
  container: HTMLElement,
  sourcePath = '',
): () => void {
  const handler = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const target = event.target as HTMLElement;
    // Handle both our links and Obsidian's internal links
    const link = target.closest('.claudian-file-link, .internal-link') as HTMLAnchorElement;

    if (link) {
      event.preventDefault();
      const linkTarget = link.dataset.href || link.getAttribute('href');
      if (linkTarget) {
        void openFileLink(app, linkTarget, sourcePath, Keymap.isModEvent(event)).catch(() => {
          new Notice('Failed to open file.');
        });
      }
    }
  };
  container.addEventListener('click', handler);
  container.addEventListener('auxclick', handler);
  return () => {
    container.removeEventListener('click', handler);
    container.removeEventListener('auxclick', handler);
  };
}

function buildFragmentWithLinks(parent: HTMLElement, text: string, matches: WikilinkMatch[]): DocumentFragment {
  const ownerDocument = parent.ownerDocument;
  const fragment = ownerDocument.defaultView?.createFragment() ?? createFragment();
  let currentIndex = text.length;

  for (const { index, fullMatch, linkTarget, displayText } of matches) {
    const endIndex = index + fullMatch.length;

    if (endIndex < currentIndex) {
      fragment.insertBefore(
        ownerDocument.createTextNode(text.slice(endIndex, currentIndex)),
        fragment.firstChild
      );
    }

    fragment.insertBefore(createWikilink(parent, linkTarget, displayText), fragment.firstChild);
    currentIndex = index;
  }

  if (currentIndex > 0) {
    fragment.insertBefore(
      ownerDocument.createTextNode(text.slice(0, currentIndex)),
      fragment.firstChild
    );
  }

  return fragment;
}

function processTextNode(app: App, node: Text, sourcePath: string): boolean {
  const text = node.textContent;
  if (!text || !text.includes('[[')) return false;

  const matches = findWikilinks(app, text, sourcePath);
  if (matches.length === 0) return false;

  const parent = node.parentElement;
  if (!parent) return false;

  node.parentNode?.replaceChild(buildFragmentWithLinks(parent, text, matches), node);
  return true;
}

/**
 * Call after MarkdownRenderer.renderMarkdown().
 * Catches wikilinks that remain as raw text after rendering, especially inline code spans.
 */
export function processFileLinks(app: App, container: HTMLElement, sourcePath = ''): void {
  if (!app || !container) return;

  // Repair resolved internal links that rendered as empty anchors.
  container.querySelectorAll('a.internal-link').forEach((linkEl) => {
    repairEmptyInternalLink(app, linkEl as HTMLAnchorElement, sourcePath);
  });

  // Wikilinks in inline code aren't rendered by Obsidian's MarkdownRenderer
  container.querySelectorAll('code').forEach((codeEl) => {
    if (codeEl.closest('pre, a, .claudian-file-link, .internal-link')) return;

    const text = codeEl.textContent;
    if (!text || !text.includes('[[')) return;

    const matches = findWikilinks(app, text, sourcePath);
    if (matches.length === 0) return;

    codeEl.textContent = '';
    codeEl.appendChild(buildFragmentWithLinks(codeEl, text, matches));
  });

  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tagName = parent.tagName.toUpperCase();
        if (tagName === 'PRE' || tagName === 'CODE' || tagName === 'A') {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest('pre, code, a, .claudian-file-link, .internal-link')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  // Modifying DOM while walking causes issues, so collect first
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    processTextNode(app, textNode, sourcePath);
  }
}
