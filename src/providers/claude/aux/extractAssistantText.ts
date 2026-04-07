export function extractAssistantText(
  message: { type: string; message?: { content?: unknown } }
): string {
  const content = message.message?.content;
  if (message.type !== 'assistant' || !Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block &&
      typeof block === 'object' &&
      'type' in block &&
      'text' in block &&
      block.type === 'text' &&
      typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('');
}
