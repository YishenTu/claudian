/** Consumed task-notification content shared by native replay and live user echoes. */
export function parseClaudeTaskNotification(content: unknown): { taskId: string; content: string } | null {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((block: unknown): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string' && block.text.trim() !== '(no content)')
      .map(block => block.text).join('\n') : '';
  if (!text.trimStart().startsWith('<task-notification>')) return null;
  const taskId = extractXMLTag(text, 'task-id');
  if (!taskId) return null;
  const status = extractXMLTag(text, 'status');
  if (!status) return null;
  return { taskId, content: extractXMLTag(text, 'result')
    ?? extractXMLTag(text, 'summary')
    ?? `Background task ${status}.` };
}

export function extractXMLTag(content: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match || !match[1]) {
    return null;
  }

  const trimmed = match[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}
