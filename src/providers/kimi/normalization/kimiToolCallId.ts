// Kimi ACP prefixes tool call ids with `<turn-uuid>/` so re-emitted LLM tool call ids
// stay unique across turns. Within one ACP prompt the prefix is constant, and the
// normalizer state resets per turn, so stripping it keeps tool_use/tool_result pairing stable.
export function stripKimiToolCallPrefix(toolCallId: string): string {
  const slashIndex = toolCallId.indexOf('/');
  return slashIndex > 0 ? toolCallId.slice(slashIndex + 1) : toolCallId;
}
