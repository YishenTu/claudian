/** Extracts text blocks from SDK assistant messages (used by all cold-start queries). */
export function extractAssistantText(
  message: { type: string; message?: { content?: Array<{ type: string; text?: string }> } }
): string {
  if (message.type !== 'assistant' || !message.message?.content) {
    return '';
  }

  return message.message.content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && !!block.text
    )
    .map((block) => block.text)
    .join('');
}
