import { parser } from '@lezer/markdown';

import { parseWikilinks } from '@/utils/fileLink';

export function formatComposerWikilink(path: string): string {
  const displayName = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return `[[${path}|${displayName}]] `;
}

export function findComposerWikilinks(text: string): ReturnType<typeof parseWikilinks> {
  if (!text.includes('[[')) return [];
  const codeRanges: Array<{ from: number; to: number }> = [];
  parser.parse(text).iterate({
    enter(node) {
      if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') {
        codeRanges.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  return parseWikilinks(text).filter(link => {
    const precedingBackslashes = text.slice(0, link.index).match(/\\+$/)?.[0].length ?? 0;
    return precedingBackslashes % 2 === 0 && !/[\r\n]/.test(link.fullMatch)
      && !codeRanges.some(range => link.index < range.to && link.index + link.fullMatch.length > range.from);
  });
}
