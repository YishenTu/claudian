import { parseWikilinks } from '@/utils/fileLink';
import { filterMarkdownTextTokens } from '@/utils/markdownTextTokens';

export function formatComposerWikilink(path: string): string {
  const displayName = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return `[[${path}|${displayName}]] `;
}

export function findComposerWikilinks(text: string): ReturnType<typeof parseWikilinks> {
  if (!text.includes('[[')) return [];
  return filterMarkdownTextTokens(text, parseWikilinks(text));
}
