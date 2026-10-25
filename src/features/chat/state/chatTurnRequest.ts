import type { ProviderSelectionSnapshot } from '@/core/execution/ProviderExecutionRequest';
import type { ChatTurnRequest, QueuedMessage } from '@/features/chat/state/types';

/**
 * Owned copies of a turn's selections in capture order. Singular composer fields
 * normalize only when no ordered capture exists; an explicit empty capture wins.
 */
export function captureSelectionSnapshots(
  source?: Pick<ChatTurnRequest, 'selections' | 'editorSelection' | 'browserSelection' | 'canvasSelection'>,
): ProviderSelectionSnapshot[] {
  const snapshots: readonly ProviderSelectionSnapshot[] = source?.selections ?? [
    ...(source?.editorSelection ? [{ kind: 'editor' as const, selection: source.editorSelection }] : []),
    ...(source?.browserSelection ? [{ kind: 'browser' as const, selection: source.browserSelection }] : []),
    ...(source?.canvasSelection ? [{ kind: 'canvas' as const, selection: source.canvasSelection }] : []),
  ];
  return snapshots.map(snapshot => {
    switch (snapshot.kind) {
      case 'editor':
        return { kind: 'editor', selection: {
          ...snapshot.selection,
          ...(snapshot.selection.cursorContext ? { cursorContext: { ...snapshot.selection.cursorContext } } : {}),
        } };
      case 'browser':
        return { kind: 'browser', selection: { ...snapshot.selection } };
      case 'canvas':
        return { kind: 'canvas', selection: { ...snapshot.selection, nodeIds: [...snapshot.selection.nodeIds] } };
    }
  });
}

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
