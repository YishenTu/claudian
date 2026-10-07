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
  const pattern = /@\[((?:\\[\\\]]|[^\]\\\r\n])*)\]\(claudian-session:(conv-[0-9]+-[a-z0-9]+)\)/g;
  return filterMarkdownTextTokens(text, [...text.matchAll(pattern)].map(match => ({
    index: match.index,
    fullMatch: match[0],
    title: match[1].replace(/\\([\\\]])/g, '$1'),
    conversationId: match[2],
  })), true);
}
