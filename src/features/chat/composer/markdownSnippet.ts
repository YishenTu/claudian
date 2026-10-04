/**
 * Claudian - Markdown Utilities
 *
 * Markdown manipulation helpers.
 */

/** Appends a Markdown snippet to an existing prompt with sensible spacing. */
export function appendMarkdownSnippet(existingPrompt: string, snippet: string): string {
  const trimmedSnippet = snippet.trim();
  if (!trimmedSnippet) {
    return existingPrompt;
  }

  if (!existingPrompt.trim()) {
    return trimmedSnippet;
  }

  const separator = existingPrompt.endsWith('\n\n')
    ? ''
    : existingPrompt.endsWith('\n')
      ? '\n'
      : '\n\n';

  return existingPrompt + separator + trimmedSnippet;
}
