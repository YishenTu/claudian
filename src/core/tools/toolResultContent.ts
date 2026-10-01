import type { WebSearchResultItem } from '../types/tools';

export interface ToolResultContentOptions {
  fallbackIndent?: number;
}

export function extractToolResultContent(
  content: unknown,
  options?: ToolResultContentOptions,
): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    const textParts = content.filter(isTextBlock).map((block) => block.text);
    if (textParts.length > 0) return textParts.join('\n');
    if (content.length > 0) {
      return JSON.stringify(content, omitToolResultImageData, options?.fallbackIndent);
    }
    return '';
  }

  return JSON.stringify(content, omitToolResultImageData, options?.fallbackIndent);
}

/**
 * Drops base64 payloads from image blocks. Tool results only display them as text, and the
 * native transcript keeps the bytes. Works as a JSON.stringify replacer or a JSON.parse reviver.
 */
export function omitToolResultImageData(_key: string, value: unknown): unknown {
  if (!isBase64ImageBlock(value)) return value;
  return { ...value, source: { ...value.source, data: '' } };
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}

function isBase64ImageBlock(
  block: unknown,
): block is { type: 'image'; source: { type: 'base64'; data: string } } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  if (record.type !== 'image' || !record.source || typeof record.source !== 'object') return false;
  const source = record.source as Record<string, unknown>;
  return source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0;
}

/** Reads provider-normalized `webSearchResults` from a tool's structured result. */
export function extractWebSearchResults(toolUseResult: unknown): WebSearchResultItem[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const items = (toolUseResult as Record<string, unknown>).webSearchResults;
  if (!Array.isArray(items)) return undefined;
  const results = items.flatMap((item): WebSearchResultItem[] => {
    if (!item || typeof item !== 'object') return [];
    const { title, url, snippet, publishedAt } = item as Record<string, unknown>;
    if (typeof title !== 'string' || typeof url !== 'string' || !url) return [];
    return [{
      title: title || url,
      url,
      ...(typeof snippet === 'string' && snippet ? { snippet } : {}),
      ...(typeof publishedAt === 'string' && publishedAt ? { publishedAt } : {}),
    }];
  });
  return results.length > 0 ? results : undefined;
}
