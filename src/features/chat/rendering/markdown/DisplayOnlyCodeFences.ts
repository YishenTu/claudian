import { loadPrism } from 'obsidian';

import { escapeRawHTMLTags } from '@/features/chat/rendering/markdown/markdownHTML';
import { transformMarkdownSegments } from '@/utils/markdownSegments';

const PLACEHOLDER_LANGUAGE_PREFIX = 'claudian-display-only-fence-';

interface PrismHighlighter {
  highlightElement(element: Element): void;
}

function isPrismHighlighter(value: unknown): value is PrismHighlighter {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>).highlightElement === 'function';
}

export interface DisplayOnlyCodeFence {
  placeholderLanguage: string;
  originalLanguage: string;
}

export interface PreparedDisplayOnlyCodeFences {
  markdown: string;
  fences: DisplayOnlyCodeFence[];
}

/**
 * Replaces fence languages so Obsidian cannot dispatch registered code-block processors,
 * except languages in `pluginLanguages` (lowercase), which reach their processors untouched.
 */
export function prepareDisplayOnlyCodeFences(
  markdown: string,
  pluginLanguages: ReadonlySet<string> = new Set(),
): PreparedDisplayOnlyCodeFences {
  const fences: DisplayOnlyCodeFence[] = [];
  const preparedMarkdown = transformMarkdownSegments(markdown, {
    fence: (opener, fence) => {
      const languageMatch = fence.info.match(/^([\t ]*)(\S+)(.*)$/);
      if (!languageMatch) {
        return opener;
      }

      const originalLanguage = languageMatch[2];
      if (pluginLanguages.has(originalLanguage.toLowerCase())) {
        return opener;
      }

      const placeholderLanguage = `${PLACEHOLDER_LANGUAGE_PREFIX}${fences.length}`;
      fences.push({ placeholderLanguage, originalLanguage });

      const transformedInfo = `${languageMatch[1]}${placeholderLanguage}${languageMatch[3]}`;
      return opener.slice(0, fence.infoStart)
        + transformedInfo
        + opener.slice(fence.infoStart + fence.info.length);
    },
  });

  return { markdown: preparedMarkdown, fences };
}

/** Restores display metadata after Markdown post-processors finish, then highlights the code. */
export async function restoreDisplayOnlyCodeFences(
  container: HTMLElement,
  fences: readonly DisplayOnlyCodeFence[],
): Promise<void> {
  const codeBlocks: HTMLElement[] = [];

  for (const fence of fences) {
    const placeholderClass = `language-${fence.placeholderLanguage}`;
    const code = container.querySelector<HTMLElement>(`code.${placeholderClass}`);
    if (!code) {
      continue;
    }

    code.classList.remove(placeholderClass);
    code.classList.add(`language-${fence.originalLanguage}`);
    codeBlocks.push(code);
  }

  if (codeBlocks.length === 0) {
    return;
  }

  try {
    const prism: unknown = await loadPrism();
    if (!isPrismHighlighter(prism)) {
      return;
    }
    for (const code of codeBlocks) {
      prism.highlightElement(code);
    }
  } catch {
    // Language restoration is authoritative; highlighting is best-effort.
  }
}

/** Normalizes the user's plugin-rendered fence languages for case-insensitive matching. */
export function getPluginFenceLanguageSet(languages: readonly string[] | undefined): Set<string> {
  return new Set((languages ?? []).map(language => language.trim().toLowerCase()).filter(Boolean));
}

/**
 * Detects fences whose rendering waits for the final message: Mermaid and plugin-rendered languages.
 * Parses the HTML-escaped Markdown the render pass sees, since escaping can expose fences
 * that raw HTML blocks hid, including nested fences.
 */
export function hasDeferredDiagramFence(
  markdown: string,
  pluginLanguages: ReadonlySet<string>,
): boolean {
  return prepareDisplayOnlyCodeFences(escapeRawHTMLTags(markdown)).fences.some(fence => {
    const language = fence.originalLanguage.toLowerCase();
    return language === 'mermaid' || pluginLanguages.has(language);
  });
}
