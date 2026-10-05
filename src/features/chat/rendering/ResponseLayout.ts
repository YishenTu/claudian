import type { ChatMessage } from '@/core/types';
import { getResponseSegments } from '@/features/chat/rendering/NotificationBoundaries';

/** Semantic roles survive streaming updates and DOM reparenting without depending on CSS. */
type ResponseElementKind = 'text' | 'citations' | 'notification' | 'work';
const elementKinds = new WeakMap<HTMLElement, ResponseElementKind>();

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

function getResponseBlocks(message: ChatMessage) {
  const blocks = message.contentBlocks?.length
    ? message.contentBlocks : [{ type: 'text' as const, content: message.content }];
  let finalStart = blocks.length;
  while (finalStart > 0 && ['text', 'citations'].includes(blocks[finalStart - 1].type)) finalStart--;
  const finalBlocks = blocks.slice(finalStart);
  const finalText = finalBlocks.flatMap(block => block.type === 'text' ? [block.content] : []).join('\n\n');
  return { blocks, finalBlocks, finalText };
}

/** The final answer: the response's trailing text, after its work. */
export function getFinalResponseText(message: ChatMessage): string {
  return getResponseBlocks(message).finalText;
}

/** The mm:ss duration of a finished response's work. */
export function formatWorkDuration(durationSeconds: number): string {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Shared live/replay policy. Renderers only map these decisions to existing elements. */
export function getResponseLayout(message: ChatMessage, messages: ChatMessage[], collapse: boolean, index?: number) {
  const { blocks, finalBlocks, finalText } = getResponseBlocks(message);
  const canCollapse = collapse && !message.isInterrupt && finalText.trim().length > 0;
  const hasNotification = blocks.some(block => block.type === 'task_notification');
  const end = index ?? messages.indexOf(message);
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
  return {
    blocks, finalText, canCollapse, notificationPredecessor, automaticNotification,
    earlierMessages, hasContinuation,
    finalBlockCount: finalBlocks.filter(block => block.type === 'citations'
      || (block.type === 'text' && block.content.trim())).length,
  };
}
