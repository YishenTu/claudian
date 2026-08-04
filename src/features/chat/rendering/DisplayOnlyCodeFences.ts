import { loadPrism } from 'obsidian';

import { transformMarkdownSegments } from '../../../utils/markdownSegments';

const PLACEHOLDER_LANGUAGE_PREFIX = 'claudian-display-only-fence-';

export interface DisplayOnlyCodeFence {
  placeholderLanguage: string;
  originalLanguage: string;
}

export interface PreparedDisplayOnlyCodeFences {
  markdown: string;
  fences: DisplayOnlyCodeFence[];
}

/** Replaces fence languages so Obsidian cannot dispatch registered code-block processors. */
export function prepareDisplayOnlyCodeFences(
  markdown: string,
): PreparedDisplayOnlyCodeFences {
  const fences: DisplayOnlyCodeFence[] = [];
  const preparedMarkdown = transformMarkdownSegments(markdown, {
    fence: (opener, fence) => {
      const languageMatch = fence.info.match(/^([\t ]*)(\S+)(.*)$/);
      if (!languageMatch) {
        return opener;
      }

      const placeholderLanguage = `${PLACEHOLDER_LANGUAGE_PREFIX}${fences.length}`;
      const originalLanguage = languageMatch[2];
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
    const code = container.querySelector<HTMLElement>(`.${placeholderClass}`);
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
    if (
      typeof prism !== 'object'
      || prism === null
      || !('highlightElement' in prism)
      || typeof prism.highlightElement !== 'function'
    ) {
      return;
    }
    for (const code of codeBlocks) {
      prism.highlightElement(code);
    }
  } catch {
    // Language restoration is authoritative; highlighting is best-effort.
  }
}
