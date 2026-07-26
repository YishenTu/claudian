import type { MemoryEntry } from './types';

/**
 * Format memory entries into a system prompt appendix section.
 *
 * Use this when you have raw MemoryEntry objects and need to format them
 * for injection. For pre-formatted injection text from MemoryStore.buildInjectionText(),
 * use wrapMemoryInjection() instead.
 */
export function formatMemoryAppendix(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return '';
  }

  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const items = grouped.get(entry.category) || [];
    items.push(entry.content);
    grouped.set(entry.category, items);
  }

  let text = '## Long-term Memory\n\n';
  text += 'The following user preferences and context have been saved from previous conversations:\n\n';

  for (const [category, items] of grouped) {
    text += `### ${category}\n`;
    for (const item of items) {
      text += `- ${item}\n`;
    }
    text += '\n';
  }

  return text.trim();
}

/**
 * Wrap pre-formatted injection text with the Long-term Memory header.
 *
 * Use this with the output of MemoryStore.buildInjectionText() which already
 * contains the category-grouped content.
 */
export function wrapMemoryInjection(injectionText: string): string {
  if (!injectionText.trim()) {
    return '';
  }

  return `## Long-term Memory\n\nThe following user preferences and context have been saved from previous conversations:\n\n${injectionText}`;
}
