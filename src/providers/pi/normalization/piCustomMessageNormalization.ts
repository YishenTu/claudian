/**
 * Display text of an extension custom message (`pi.sendMessage`), shared by live output and
 * history replay so both render the same notification. Empty means nothing to display.
 */
export function getPiCustomMessageDisplayText(message: Record<string, unknown>): string {
  if (message.display === false) return '';
  const text = getCustomMessageText(message.content);
  return message.customType === PEEPS_RESULT_TYPE ? stripPeepsResultHeader(text) : text;
}

const PEEPS_RESULT_TYPE = 'peeps-result';
// Peeps prefixes results with a model-facing `[Peeps automated result — <runId> — <status>]` line.
const PEEPS_RESULT_HEADER = /^\[Peeps automated result — [^\]\n]+ — [^\]\n]+\]\n/;

function stripPeepsResultHeader(text: string): string {
  const body = text.replace(PEEPS_RESULT_HEADER, '');
  return body.trim() ? body : text;
}

/** Text of a string or block content, joined as session history joins it. */
function getCustomMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
