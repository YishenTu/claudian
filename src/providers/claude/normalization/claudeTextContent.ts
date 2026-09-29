/** Placeholder the Claude CLI writes for an empty text block; it is never user-visible content. */
const NO_CONTENT_PLACEHOLDER = '(no content)';

export function isClaudeNoContentPlaceholder(text: string): boolean {
  return text.trim() === NO_CONTENT_PLACEHOLDER;
}

/**
 * Joins the visible text of Claude message content: a plain string passes through, an array
 * contributes its text blocks except the empty-content placeholder, anything else is empty.
 */
export function extractClaudeTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: unknown): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      && !isClaudeNoContentPlaceholder((block as { text: string }).text))
    .map(block => block.text)
    .join('\n');
}
