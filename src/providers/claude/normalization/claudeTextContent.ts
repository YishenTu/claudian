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

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:';

/**
 * The feedback of a blocking Stop hook, which Claude adds to the conversation as user-role
 * text under a fixed prefix (live as a synthetic message, in the transcript as a meta record).
 */
export function parseClaudeStopHookFeedback(content: unknown): string | null {
  const text = extractClaudeTextContent(content);
  return text.startsWith(STOP_HOOK_FEEDBACK_PREFIX) ? text.slice(STOP_HOOK_FEEDBACK_PREFIX.length).trim() : null;
}
