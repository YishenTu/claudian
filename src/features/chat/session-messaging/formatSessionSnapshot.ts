import { getUserDisplayText } from '@/core/prompt/promptContext';
import { type ChatMessage, type Conversation, isCanonicalUserMessage } from '@/core/types';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';
import { getFinalResponseText, isStandaloneTaskNotification } from '@/features/chat/rendering/ResponseLayout';

/** Keeps one read within what native tool results accept. */
const DEFAULT_MAX_CHARS = 40_000;
const TRUNCATED = '\n(truncated)';

export interface SessionSnapshotPage {
  readonly content: string;
  /** First and last returned turn numbers; both 0 when no turn is returned. */
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly totalTurns: number;
}

interface Turn {
  readonly user: ChatMessage;
  readonly responses: ChatMessage[];
}

/** Turns in order, without one still running. */
function splitFinishedTurns(messages: readonly ChatMessage[], running: boolean): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.isRebuiltContext) continue;
    if (isCanonicalUserMessage(message)) turns.push({ user: message, responses: [] });
    else turns.at(-1)?.responses.push(message);
  }
  const tail = turns.at(-1)?.responses.at(-1);
  if (running && tail?.completedAt === undefined && !tail?.isInterrupt) turns.pop();
  return turns;
}

function getChainFinalText(last: ChatMessage, segments: readonly ChatMessage[]): string {
  const blocks = segments.flatMap(segment => segment.contentBlocks?.length
    ? segment.contentBlocks : [{ type: 'text' as const, content: segment.content }]);
  return getFinalResponseText({ ...last, contentBlocks: blocks });
}

function formatReply(responses: ChatMessage[]): string {
  const seen = new Set<ChatMessage>();
  const replies: Array<{ start: number; text: string }> = [];
  // The last segment owns final-text extraction; its chain occupies the original response's slot.
  for (let index = responses.length - 1; index >= 0; index--) {
    const message = responses[index];
    const notification: boolean = isStandaloneTaskNotification(message);
    if (message.role !== 'assistant' || notification || seen.has(message)) continue;
    const segments = getResponseSegments(message, responses);
    for (const segment of segments) seen.add(segment);
    replies.push({ start: responses.indexOf(segments[0]), text: getChainFinalText(message, segments) });
  }
  const final = replies.sort((left, right) => left.start - right.start)
    .map(reply => reply.text).filter(text => text.trim()).join('\n\n');
  return final || formatEmptyReply(responses);
}

function formatEmptyReply(responses: readonly ChatMessage[]): string {
  return responses.some(message => message.isInterrupt) ? '(interrupted)'
    : responses.some(message => message.toolCalls?.some(tool => tool.status === 'error')) ? '(error)' : '(no reply)';
}

/**
 * The last finished turn's final answer as Markdown: the trailing text of its last response,
 * across that response's continuation segments. Empty when no turn has finished.
 */
export function formatLastReply(messages: readonly ChatMessage[], running: boolean): string {
  const turn = splitFinishedTurns(messages, running).at(-1);
  if (!turn) return '';
  const last = turn.responses.filter(message => {
    const notification: boolean = isStandaloneTaskNotification(message);
    return message.role === 'assistant' && !notification;
  }).at(-1);
  if (!last) return formatEmptyReply(turn.responses);
  const segments = getResponseSegments(last, turn.responses);
  const final = getChainFinalText(last, segments);
  return final.trim() ? final : formatEmptyReply(turn.responses);
}

/** Each turn's prompt and final reply, latest turns first to fit `maxChars`. */
export function formatSessionSnapshot(
  metadata: Pick<Conversation, 'id' | 'title' | 'providerId' | 'createdAt' | 'lastActivityAt'>,
  messages: readonly ChatMessage[],
  running: boolean,
  options: { beforeTurn?: number; maxChars?: number } = {},
): SessionSnapshotPage {
  const turns = splitFinishedTurns(messages, running);
  const header = `# ${metadata.title}\n\nID: ${metadata.id}\nProvider: ${metadata.providerId}\nCreated: ${new Date(metadata.createdAt).toISOString()}\nUpdated: ${new Date(metadata.lastActivityAt).toISOString()}`;
  const formatTurn = (index: number): string => {
    const { user, responses } = turns[index];
    return `## T${index + 1} user\n${getUserDisplayText(user)}\n\n## T${index + 1} assistant\n${formatReply(responses)}`;
  };

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const end = Math.min(turns.length, (options.beforeTurn ?? Infinity) - 1);
  const body: string[] = [];
  let used = 0;
  for (let index = end - 1; index >= 0; index--) {
    const text = formatTurn(index);
    const cost = text.length + (body.length ? 2 : 0);
    if (body.length && used + cost > maxChars) break;
    // The newest turn is always returned, cut to the budget if it alone exceeds it.
    let limit = maxChars;
    if (text.length > limit) {
      const before = text.charCodeAt(limit - 1);
      const after = text.charCodeAt(limit);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) limit--;
    }
    body.unshift(text.length > maxChars ? text.slice(0, limit) + TRUNCATED : text);
    used += cost;
  }
  return {
    content: [header, ...body].join('\n\n') + '\n',
    fromTurn: body.length ? end - body.length + 1 : 0,
    toTurn: body.length ? end : 0,
    totalTurns: turns.length,
  };
}
