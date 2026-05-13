export function extractAssistantText(
  message: { type: string; message?: { content?: unknown } }
): string {
  const content = message.message?.content;
  if (message.type !== 'assistant' || !Array.isArray(content)) {
    return '';
  }

  return (content as unknown[])
    .filter((block): block is { type: 'text'; text: string } => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return false;
      }
      const record = block as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string';
    })
    .map((block) => block.text)
    .join('');
}
