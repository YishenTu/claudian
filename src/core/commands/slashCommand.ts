import type { SlashCommand } from '@/core/types';

export function extractFirstParagraph(content: string): string | undefined {
  const paragraph = content.split(/\n\s*\n/).find(p => p.trim());
  if (!paragraph) return undefined;
  return paragraph.trim().replace(/\n/g, ' ');
}

export function isSkill(cmd: SlashCommand): boolean {
  if (cmd.kind) return cmd.kind === 'skill';
  return cmd.id.startsWith('skill-');
}

export function normalizeArgumentHint(hint: string): string {
  if (!hint) return hint;
  if (hint.includes('[') || hint.includes('<')) return hint;
  return `[${hint}]`;
}
