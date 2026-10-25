import type { ProviderSelectionSnapshot } from '@/core/execution/ProviderExecutionRequest';
import type { ChatTurnRequest, QueuedMessage } from '@/features/chat/state/types';

/**
 * A turn's selections in capture order. Singular composer fields normalize only when no
 * ordered capture exists; an explicit empty capture wins.
 */
export function captureSelectionSnapshots(
  source?: Pick<ChatTurnRequest, 'selections' | 'editorSelection' | 'browserSelection' | 'canvasSelection'>,
): readonly ProviderSelectionSnapshot[] {
  return source?.selections ?? [
    ...(source?.editorSelection ? [{ kind: 'editor' as const, selection: source.editorSelection }] : []),
    ...(source?.browserSelection ? [{ kind: 'browser' as const, selection: source.browserSelection }] : []),
    ...(source?.canvasSelection ? [{ kind: 'canvas' as const, selection: source.canvasSelection }] : []),
  ];
}

export function createQueuedMessage(displayContent: string, turnRequest: ChatTurnRequest): QueuedMessage {
  return { content: displayContent, turnRequest };
}

/** Later input joins earlier queued input as one turn; both delivery observers settle together. */
export function mergeQueuedMessages(existing: QueuedMessage | null, incoming: QueuedMessage): QueuedMessage {
  if (!existing) return incoming;

  const mergeText = (first: string, second: string) => (
    [first, second].map(value => value.trim()).filter(Boolean).join('\n\n')
  );
  const earlier = existing.turnRequest;
  const later = incoming.turnRequest;
  const images = [...(earlier.images ?? []), ...(later.images ?? [])];
  const request: ChatTurnRequest = {
    ...later,
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
