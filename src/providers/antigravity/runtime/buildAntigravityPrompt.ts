import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '@/core/prompt/historyContext';
import {
  appendLinkedContent,
  appendLinkedContentBody,
  appendSelectionContexts,
  appendSessionReferences,
} from '@/core/prompt/promptContext';
import type {
  ProviderLinkedContentContext,
  ProviderSelectionSnapshot,
  ProviderSessionReference,
} from '@/core/execution/ProviderExecutionRequest';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import type { ACPContentBlock } from '@/providers/acp';

export interface AntigravityPromptRequest {
  selections?: readonly ProviderSelectionSnapshot[];
  sessionReferences?: readonly ProviderSessionReference[];
  text: string;
  images?: ImageAttachment[];
  linkedContent?: ProviderLinkedContentContext;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
}

export function buildAntigravityPromptText(
  request: AntigravityPromptRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  let prompt = request.text;

  if (request.linkedContent) {
    prompt = request.linkedContent.content === undefined
      ? appendLinkedContent(prompt, request.linkedContent.path)
      : appendLinkedContentBody(
        prompt,
        request.linkedContent.path,
        request.linkedContent.content,
      );
  }

  prompt = appendSelectionContexts(prompt, request);
  prompt = appendSessionReferences(prompt, request.sessionReferences);

  if (conversationHistory.length > 0) {
    const historyContext = buildContextFromHistory(conversationHistory);
    prompt = buildPromptWithHistoryContext(
      historyContext,
      prompt,
      prompt,
      conversationHistory,
    );
  }

  return prompt;
}

export function buildAntigravityPromptBlocks(
  request: AntigravityPromptRequest,
  conversationHistory: ChatMessage[] = [],
): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [
    { type: 'text', text: buildAntigravityPromptText(request, conversationHistory) },
  ];

  for (const image of request.images ?? []) {
    if (!image.data) continue;
    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return blocks;
}
