import type { ChatMessage, ContentBlock } from '@/core/types';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';
import { t } from '@/i18n/i18n';

/** Semantic roles survive streaming updates and DOM reparenting without depending on CSS. */
type ResponseElementKind = 'text' | 'citations' | 'notification' | 'interrupt' | 'hook' | 'work';
const elementKinds = new WeakMap<HTMLElement, ResponseElementKind>();
const stopHookElapsed = new WeakMap<HTMLElement, number>();

export function markResponseElement<T extends HTMLElement>(element: T, kind: ResponseElementKind): T {
  elementKinds.set(element, kind);
  return element;
}

export function getResponseElementKind(element: HTMLElement): ResponseElementKind {
  return elementKinds.get(element) ?? 'work';
}

export function createResponseTextBlock(parent: HTMLElement): HTMLElement {
  return markResponseElement(parent.createDiv({ cls: 'claudian-text-block' }), 'text');
}

/**
 * A Stop hook's feedback, shown between the reply it sent back and the work after it.
 * Hook output is plain text, never Markdown.
 */
export function renderStopHook(parent: HTMLElement, content: string, elapsedSeconds?: number): HTMLElement {
  const element = markResponseElement(parent.createDiv({ cls: 'claudian-stop-hook' }), 'hook');
  element.createDiv({ cls: 'claudian-stop-hook-label', text: t('chat.stopHook') });
  if (content) element.createDiv({ cls: 'claudian-stop-hook-content', text: content });
  if (elapsedSeconds !== undefined) stopHookElapsed.set(element, elapsedSeconds);
  return element;
}

/** The turn time at a rendered Stop hook, when known. */
export function getStopHookElapsedSeconds(element: HTMLElement): number | undefined {
  return stopHookElapsed.get(element);
}

/** The interrupt indicator's text, shared by its plain line and the interrupted turn's disclosure header. */
export function appendInterruptLabel(parent: HTMLElement): void {
  parent.createSpan({ cls: 'claudian-interrupted', text: t('chat.zen.interrupted') });
  parent.appendText(' ');
  parent.createSpan({ cls: 'claudian-interrupted-hint', text: t('chat.interruptedHint') });
}

/** Live session notifications are separate from the automatic response they precede. */
export function isStandaloneTaskNotification(message: ChatMessage | undefined): message is ChatMessage {
  return message?.role === 'assistant' && message.isAutomaticResponse === true
    && Boolean(message.contentBlocks?.length)
    && message.contentBlocks?.every(block => block.type === 'task_notification') === true;
}

/** Keep an automatic response's notification binding across requested DOM splits. */
export function getAutomaticNotificationPredecessor(message: ChatMessage, messages: ChatMessage[]): ChatMessage | undefined {
  if (!message.isAutomaticResponse || message.contentBlocks?.some(block => block.type === 'task_notification')) return undefined;
  const first = getResponseSegments(message, messages)[0];
  if (isStandaloneTaskNotification(first)) return first;
  const previous = messages[messages.indexOf(message) - 1];
  return isStandaloneTaskNotification(previous) ? previous : undefined;
}

function isAnswerBlock(block: ContentBlock): boolean {
  return block.type === 'text' || block.type === 'citations';
}

function joinText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.content] : []).join('\n\n');
}

function getResponseBlocks(message: ChatMessage) {
  const blocks = message.contentBlocks?.length
    ? message.contentBlocks : [{ type: 'text' as const, content: message.content }];
  let finalStart = blocks.length;
  while (finalStart > 0 && isAnswerBlock(blocks[finalStart - 1])) finalStart--;
  const finalBlocks = blocks.slice(finalStart);
  return { blocks, finalBlocks, finalText: joinText(finalBlocks) };
}

/** Each reply that ended the turn before a Stop hook sent it back: the text right before the hook. */
function getStopHookAnswers(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block, index) => {
    if (block.type !== 'stop_hook') return [];
    let start = index;
    // A task notification that arrived after the reply does not end it.
    while (start > 0 && blocks[start - 1].type === 'task_notification') start--;
    while (start > 0 && isAnswerBlock(blocks[start - 1])) start--;
    const text = joinText(blocks.slice(start, index));
    return text.trim() ? [text] : [];
  });
}

/** The answer: every reply that ended the turn, in order, each after its work. */
function joinAnswers(blocks: readonly ContentBlock[], finalText: string): string {
  return [...getStopHookAnswers(blocks), finalText].filter(text => text.trim()).join('\n\n');
}

/** The final answer: the response's trailing text, after its work, with any reply a Stop hook sent back before it. */
export function getFinalResponseText(message: ChatMessage): string {
  const { blocks, finalText } = getResponseBlocks(message);
  return joinAnswers(blocks, finalText);
}

/** The mm:ss duration of a finished response's work. */
export function formatWorkDuration(durationSeconds: number): string {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Output beyond blank text: any tool call, non-text block, or text with content. */
export function hasResponseOutput(message: ChatMessage): boolean {
  return message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0
    || message.contentBlocks?.some(block => (block.type !== 'text' && block.type !== 'thinking') || block.content.trim()) === true;
}

/** A bare interrupt record: Claude's user-role bracket entry or an output-free assistant interrupt. */
export function isInterruptMarker(message: ChatMessage): boolean {
  return message.isInterrupt === true && (message.role === 'user' || !hasResponseOutput(message));
}

/** A marker records its own turn's stop; one without a turn predates turn identity. */
function isMarkerOf(marker: ChatMessage, message: ChatMessage): boolean {
  return marker.turnId === undefined || marker.turnId === message.turnId;
}

/** Ended by its own interrupt, or by a bare marker of its turn. */
function endsWithInterrupt(message: ChatMessage, messages: ChatMessage[], index: number): boolean {
  const next = messages[index + 1];
  return message.isInterrupt === true || (next !== undefined && isInterruptMarker(next) && isMarkerOf(next, message));
}

/** A bare marker the interrupted reply before it shows inside its own fold, so it renders nothing itself. */
export function isConsumedInterruptMarker(message: ChatMessage, messages: ChatMessage[], index?: number): boolean {
  const previousIndex = (index ?? messages.indexOf(message)) - 1;
  const previous = messages[previousIndex];
  return isInterruptMarker(message) && previous !== undefined && isMarkerOf(message, previous)
    && isInterruptedResponse(previous, messages, previousIndex);
}

/**
 * The native turn `owner` ends, back to the user message bounding it: the messages sharing
 * its turn identity, and the notifications between them that no other response consumed.
 * The turn was prompted when its first message follows that user message directly, unless
 * it is an interrupt marker, which prompts nothing; an automatic turn's notifications before
 * its first other message triggered it, like a prompt.
 */
function getStoppedTurn(owner: ChatMessage, messages: ChatMessage[], end: number) {
  let boundary = end;
  while (boundary > 0 && messages[boundary - 1].role !== 'user') boundary--;
  const span = messages.slice(boundary, end + 1);
  const members = owner.turnId === undefined ? [owner] : span.filter(item => item.turnId === owner.turnId);
  const first = span.indexOf(members[0]);
  const consumedElsewhere = new Set(messages.filter(item => !members.includes(item))
    .map(item => getAutomaticNotificationPredecessor(item, messages)));
  const turn = span.slice(first).filter(item => members.includes(item)
    || (isStandaloneTaskNotification(item) && !consumedElsewhere.has(item)));
  const prompted = boundary > 0 && first === 0 && !messages[boundary - 1].isInterrupt;
  const trigger = prompted ? 0 : turn.findIndex(item => item === owner || !isStandaloneTaskNotification(item));
  return { messages: turn.slice(trigger), prompted };
}

/**
 * A reply ended by an interrupt, flagged on the reply itself or recorded as the
 * marker after it, which then belongs inside this reply. A notification alone is
 * no reply: an automatic turn stopped before output keeps a plain indicator. A
 * notification ending a turn that includes a reply owns that turn's fold.
 */
export function isInterruptedResponse(message: ChatMessage, messages: ChatMessage[], index?: number): boolean {
  const end = index ?? messages.indexOf(message);
  if (message.role !== 'assistant' || isInterruptMarker(message) || !endsWithInterrupt(message, messages, end)) return false;
  return !isStandaloneTaskNotification(message)
    || getStoppedTurn(message, messages, end).messages.some(item => !isStandaloneTaskNotification(item));
}

/** An earlier message of a turn a later message ends interrupted folds there, not on its own. */
export function isFoldedByLaterInterrupt(message: ChatMessage, messages: ChatMessage[], index?: number): boolean {
  for (let next = (index ?? messages.indexOf(message)) + 1; next < messages.length; next++) {
    const item = messages[next];
    if (item.role === 'user') return false;
    if (isInterruptedResponse(item, messages, next) && getStoppedTurn(item, messages, next).messages.includes(message)) return true;
  }
  return false;
}

/**
 * Shared live/replay policy. Renderers only map these decisions to existing elements.
 * An interrupted turn has no answer: every message of its native turn folds under
 * "Interrupted"; a steer's user message still bounds it, and an automatic turn keeps
 * the notification that triggered it outside. Failed turns (`collapse` false) stay expanded.
 */
export function getResponseLayout(message: ChatMessage, messages: ChatMessage[], collapse: boolean, index?: number) {
  const { blocks, finalBlocks, finalText } = getResponseBlocks(message);
  const end = index ?? messages.indexOf(message);
  const interrupted = isInterruptedResponse(message, messages, end);
  const canCollapse = collapse && !endsWithInterrupt(message, messages, end) && finalText.trim().length > 0;
  const hasNotification = blocks.some(block => block.type === 'task_notification');
  const notificationPredecessor = getAutomaticNotificationPredecessor(message, messages);
  const automaticNotification = message.isAutomaticResponse === true
    && (hasNotification || notificationPredecessor !== undefined);
  const segments = getResponseSegments(message, messages);
  let start = end;
  while (start > 0 && messages[start - 1].role === 'assistant'
    && messages[start - 1].durationSeconds === undefined
    && !messages[start - 1].isInterrupt
    && !messages[start - 1].contentBlocks?.some(block => block.type === 'task_notification')) start--;
  const hasContinuation = segments.length > 1;
  let earlierMessages = messages.slice(start, end);
  if (hasContinuation) {
    const backgroundNotifications = new Set(messages.map(item => getAutomaticNotificationPredecessor(item, messages)));
    earlierMessages = messages.slice(messages.indexOf(segments[0]), end)
      .filter(item => segments.includes(item)
        || (isStandaloneTaskNotification(item) && !backgroundNotifications.has(item)));
  }
  let automaticTurn = false;
  if (interrupted) {
    // A stopped turn folds whole, from its first message. An automatic turn's notifications
    // before its first message triggered it and stay outside, like a prompt.
    const turn = getStoppedTurn(message, messages, end);
    automaticTurn = !turn.prompted;
    earlierMessages = turn.messages.slice(0, -1);
  }
  const turnBlocks = [...earlierMessages.flatMap(item => item.contentBlocks ?? []), ...blocks];
  return {
    blocks, finalText, answer: joinAnswers(turnBlocks, finalText), canCollapse, interrupted, automaticTurn, notificationPredecessor, automaticNotification,
    earlierMessages, hasContinuation: interrupted ? earlierMessages.length > 0 : hasContinuation,
    finalBlockCount: finalBlocks.filter(block => block.type === 'citations'
      || (block.type === 'text' && block.content.trim())).length,
  };
}
