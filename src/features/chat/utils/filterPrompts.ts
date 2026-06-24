import type { StoredPrompt } from '../../../core/storage/PromptLibraryStorage';

export function filterPrompts(prompts: StoredPrompt[], query: string): StoredPrompt[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  return prompts.filter(p =>
    p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
  );
}
