import {
  createGrokHistoryParser,
  createGrokPromptIndexResolver,
  type GrokHistoryLineConsumer,
  type ParsedGrokHistory,
} from '@/providers/grok/history/GrokHistoryStore';

function consumeLines<T>(content: string, consumer: GrokHistoryLineConsumer<T>): T {
  for (const line of content.split(/\r?\n/)) {
    if (consumer.pushLine(line) === false) break;
  }
  return consumer.finish();
}

/** Feeds in-memory `updates.jsonl` content through the streaming history parser. */
export function parseGrokHistoryContent(
  content: string,
  sessionId: string,
  resumeAt?: string,
): ParsedGrokHistory {
  return consumeLines(content, createGrokHistoryParser(sessionId, resumeAt));
}

export function resolveGrokPromptIndexAfterAssistant(
  content: string,
  sessionId: string,
  resumeAt: string,
): number | null {
  return consumeLines(content, createGrokPromptIndexResolver(sessionId, resumeAt));
}
