import { escapePromptXMLAttribute, formatPromptXMLCdata } from '@/core/prompt/promptXML';
import { TOOL_CLAUDIAN_SEND_MESSAGE } from '@/core/tools/toolNames';

/** A message delivered from another Claudian session, as carried in the recipient's native prompt. */
export interface SessionMessage {
  /** Sender session title. */
  readonly from: string;
  /** Sender conversation id; the recipient replies to it. */
  readonly sessionId: string;
  readonly text: string;
}

const REPLY_HINT = `Replying is optional. If a response is needed, call ${TOOL_CLAUDIAN_SEND_MESSAGE} with this session_id.`;

/**
 * The body is CDATA-wrapped, so a body containing `]]>` cannot end it early; every
 * `]]>` inside the escaped body is followed by `<![CDATA[`, never by the closing tag.
 */
const ENVELOPE_PATTERN = /^\s*<session_message from="([^"]*)" session_id="([^"]*)">\r?\n<!\[CDATA\[([\s\S]*?)\]\]>\r?\n<\/session_message>/;
/** Prompt context appended after the envelope uses the shared `\n\n<tag` or `\n[label` separators. */
const TRAILING_CONTEXT_PATTERN = /^(?:\s*$|\r?\n\r?\n<|\r?\n\[)/;
const SPLIT_CDATA_END = /\]\]\]\]><!\[CDATA\[>/g;
const XML_ATTRIBUTE_ENTITY = /&(amp|quot|lt|gt|#9|#10|#13);/g;
const XML_ATTRIBUTE_ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', lt: '<', gt: '>', '#9': '\t', '#10': '\n', '#13': '\r',
};

export function encodeSessionMessage(envelope: SessionMessage): string {
  const from = escapePromptXMLAttribute(envelope.from);
  const sessionId = escapePromptXMLAttribute(envelope.sessionId);
  return `<session_message from="${from}" session_id="${sessionId}">\n`
    + `${formatPromptXMLCdata(envelope.text)}\n</session_message>\n${REPLY_HINT}`;
}

/** Decodes a prompt that starts with a session message envelope, ignoring appended prompt context. */
export function decodeSessionMessage(prompt: string): SessionMessage | null {
  if (!prompt) return null;
  const match = ENVELOPE_PATTERN.exec(prompt);
  if (!match) return null;

  let rest = prompt.slice(match[0].length);
  const hint = /^\r?\n/.exec(rest);
  if (hint && rest.startsWith(REPLY_HINT, hint[0].length)) {
    rest = rest.slice(hint[0].length + REPLY_HINT.length);
  }
  if (!TRAILING_CONTEXT_PATTERN.test(rest)) return null;

  return {
    from: unescapeXMLAttribute(match[1]),
    sessionId: unescapeXMLAttribute(match[2]),
    text: match[3].replace(SPLIT_CDATA_END, ']]>'),
  };
}

function unescapeXMLAttribute(value: string): string {
  return value.replace(XML_ATTRIBUTE_ENTITY, (_, entity: string) => XML_ATTRIBUTE_ENTITIES[entity]);
}
