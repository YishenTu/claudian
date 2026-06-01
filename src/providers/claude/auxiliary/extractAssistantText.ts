export function extractAssistantText(
  message: { type: string; message?: unknown }
): string {
  if (message.type !== 'assistant') {
    return '';
  }

  const payload = message.message;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
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
