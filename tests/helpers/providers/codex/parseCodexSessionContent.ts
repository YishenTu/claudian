import type { ChatMessage } from '@/core/types';
import { parseCodexSessionTurns } from '@/providers/codex/history/CodexHistoryStore';

export function parseCodexSessionContent(content: string): ChatMessage[] {
  const turns = parseCodexSessionTurns(content);
  return turns.flatMap(t => t.messages);
}
