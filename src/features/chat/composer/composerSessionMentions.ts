import { isValidSessionMetadataId } from '@/core/bootstrap/storagePaths';
import { filterMarkdownTextTokens } from '@/utils/markdownTextTokens';

export interface ComposerSessionMention {
  index: number;
  fullMatch: string;
  title: string;
  conversationId: string;
}

export function formatComposerSessionMention(title: string, conversationId: string): string {
  const escaped = title.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  return `@[${escaped}](claudian-session:${conversationId}) `;
}

export function findComposerSessionMentions(text: string): ComposerSessionMention[] {
  if (!text.includes('@[')) return [];
  const pattern = /@\[((?:\\[\\\]]|[^\]\\\r\n])*)\]\(claudian-session:([^)\r\n]+)\)/g;
  return filterMarkdownTextTokens(text, [...text.matchAll(pattern)]
    .filter(match => isValidSessionMetadataId(match[2]))
    .map(match => ({
      index: match.index,
      fullMatch: match[0],
      title: match[1].replace(/\\([\\\]])/g, '$1'),
      conversationId: match[2],
    })), true);
}
