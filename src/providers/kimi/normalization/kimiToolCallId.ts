// Kimi ACP prefixes tool call ids with `<turnId>:` (integer turn id) so re-emitted
// LLM tool call ids stay unique across turns. Raw tool ids (`tool_*`) may contain
// colons themselves, so only a numeric first segment is treated as a turn prefix.
export function stripKimiToolCallPrefix(toolCallId: string): string {
  const colonIndex = toolCallId.indexOf(':');
  if (colonIndex <= 0) {
    return toolCallId;
  }

  const prefix = toolCallId.slice(0, colonIndex);
  return /^\d+$/.test(prefix) ? toolCallId.slice(colonIndex + 1) : toolCallId;
}
