import type { ChatMessage } from '../../../core/types';
import { getResponseSegments } from './NotificationBoundaries';

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

/** Shared live/replay policy. Renderers only map these decisions to existing elements. */
export function getResponseLayout(message: ChatMessage, messages: ChatMessage[], collapse: boolean) {
  const blocks = message.contentBlocks?.length
    ? message.contentBlocks : [{ type: 'text' as const, content: message.content }];
  let finalStart = blocks.length;
  while (finalStart > 0 && ['text', 'citations'].includes(blocks[finalStart - 1].type)) finalStart--;
  const finalBlocks = blocks.slice(finalStart);
  const finalText = finalBlocks.flatMap(block => block.type === 'text' ? [block.content] : []).join('\n\n');
  const canCollapse = collapse && !message.isInterrupt && finalText.trim().length > 0
    && !blocks.some(block => block.type === 'context_compacted');
  const hasNotification = blocks.some(block => block.type === 'task_notification');
  const end = messages.indexOf(message);
  const previous = messages[end - 1];
  const notificationPredecessor = !hasNotification && message.isAutomaticResponse === true
    && isStandaloneTaskNotification(previous) ? previous : undefined;
  const automaticNotification = message.isAutomaticResponse === true
    && (hasNotification || notificationPredecessor !== undefined);
  const segments = getResponseSegments(message, messages);
  let start = end;
  while (start > 0 && messages[start - 1].role === 'assistant'
    && messages[start - 1].durationSeconds === undefined
    && !messages[start - 1].isInterrupt
    && !messages[start - 1].contentBlocks?.some(block =>
      block.type === 'task_notification' || block.type === 'context_compacted')) start--;
  return {
    blocks, finalText, canCollapse, hasNotification, notificationPredecessor, automaticNotification,
    earlierMessages: segments.length > 1 ? segments.slice(0, -1) : messages.slice(start, end),
    keepEarlierCommentary: segments.length > 1,
    finalBlockCount: finalBlocks.filter(block => block.type === 'citations'
      || (block.type === 'text' && block.content.trim())).length,
  };
}
