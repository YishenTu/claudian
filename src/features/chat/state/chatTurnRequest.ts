import { captureSelectionSnapshots } from '@/core/prompt/promptContext';
import type { ChatTurnRequest, QueuedMessage } from '@/features/chat/state/types';

export function cloneChatTurnRequest(request: ChatTurnRequest): ChatTurnRequest {
  return {
    ...request,
    ...(request.selections !== undefined ? { selections: captureSelectionSnapshots(request) } : {}),
    ...(request.editorSelection ? { editorSelection: { ...request.editorSelection,
      ...(request.editorSelection.cursorContext ? { cursorContext: { ...request.editorSelection.cursorContext } } : {}),
    } } : {}),
    ...(request.browserSelection ? { browserSelection: { ...request.browserSelection } } : {}),
    ...(request.canvasSelection ? { canvasSelection: { ...request.canvasSelection, nodeIds: [...request.canvasSelection.nodeIds] } } : {}),
    images: request.images ? [...request.images] : undefined,
    ...(request.sessionReferences ? { sessionReferences: request.sessionReferences.map(reference => ({ ...reference })) } : {}),
  };
}

export function createQueuedMessage(displayContent: string, turnRequest: ChatTurnRequest): QueuedMessage {
  return { content: displayContent, turnRequest: cloneChatTurnRequest(turnRequest) };
}

export function cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
  return { ...message, turnRequest: cloneChatTurnRequest(message.turnRequest) };
}

/** Later input joins earlier queued input as one turn; both delivery observers settle together. */
export function mergeQueuedMessages(existing: QueuedMessage | null, incoming: QueuedMessage): QueuedMessage {
  if (!existing) return cloneQueuedMessage(incoming);

  const mergeText = (first: string, second: string) => (
    [first, second].map(value => value.trim()).filter(Boolean).join('\n\n')
  );
  const earlier = existing.turnRequest;
  const later = incoming.turnRequest;
  const images = [...(earlier.images ?? []), ...(later.images ?? [])];
  const request: ChatTurnRequest = {
    ...cloneChatTurnRequest(later),
    selections: [...captureSelectionSnapshots(earlier), ...captureSelectionSnapshots(later)],
    editorSelection: undefined,
    browserSelection: undefined,
    canvasSelection: undefined,
    sessionReferences: [...(earlier.sessionReferences ?? []), ...(later.sessionReferences ?? [])],
    ...(earlier.draftContent !== undefined || later.draftContent !== undefined ? {
      draftContent: mergeText(earlier.draftContent ?? existing.content, later.draftContent ?? incoming.content),
    } : {}),
    images: images.length > 0 ? images : undefined,
    text: mergeText(earlier.text, later.text),
  };
  return {
    ...createQueuedMessage(mergeText(existing.content, incoming.content), request),
    onDelivery: accepted => {
      existing.onDelivery?.(accepted);
      incoming.onDelivery?.(accepted);
    },
  };
}
