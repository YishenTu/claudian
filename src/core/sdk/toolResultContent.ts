interface ToolResultContentOptions {
  fallbackIndent?: number;
}

/**
 * Agent/Subagent tool results can arrive as text blocks instead of a plain string.
 * Keep streaming and history parsing aligned so live output matches reloaded output.
 */
export function extractToolResultContent(
  content: unknown,
  options?: ToolResultContentOptions
): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const textParts = content.filter(isTextBlock).map((block) => block.text);
    if (textParts.length > 0) return textParts.join('\n');
    if (content.length > 0) return JSON.stringify(content, null, options?.fallbackIndent);
    return '';
  }
  return JSON.stringify(content, null, options?.fallbackIndent);
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}
