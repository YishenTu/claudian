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

import type { ProviderLinkedContentContext } from '../../../core/execution';
import type { ProviderSelectionSnapshot, ProviderSessionReference } from '../../../core/execution/ProviderExecutionRequest';
import type { ChatMessage, ImageAttachment } from '../../../core/types';
import type { ACPContentBlock } from '../../acp';

export interface OpencodePromptRequest {
  selections?: readonly ProviderSelectionSnapshot[];
  sessionReferences?: readonly ProviderSessionReference[];
  text: string;
  images?: ImageAttachment[];
  linkedContent?: ProviderLinkedContentContext;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
}

/** The span of the composed prompt text that the user typed. */
export interface OpencodeTextRange {
  readonly start: number;
  readonly end: number;
}

export interface OpencodePrompt {
  readonly blocks: ACPContentBlock[];
  /** Absent when replayed history already ends with this turn's query. */
  readonly userText: OpencodeTextRange | null;
}

export function buildOpencodePromptText(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  return composeOpencodePromptText(request, conversationHistory).text;
}

function composeOpencodePromptText(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[],
): { text: string; userText: OpencodeTextRange | null } {
  // Captured context always follows the typed text.
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

  if (conversationHistory.length === 0) {
    return { text: prompt, userText: { start: 0, end: request.text.length } };
  }
  const historyContext = buildContextFromHistory(conversationHistory);
  const text = buildPromptWithHistoryContext(
    historyContext,
    prompt,
    prompt,
    conversationHistory,
  );
  const start = text.length - prompt.length;
  return {
    text,
    userText: text === prompt || text.endsWith(`\n\nUser: ${prompt}`)
      ? { start, end: start + request.text.length }
      : null,
  };
}

export function buildOpencodePrompt(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): OpencodePrompt {
  const { text, userText } = composeOpencodePromptText(request, conversationHistory);
  const blocks: ACPContentBlock[] = [{ type: 'text', text }];

  for (const image of request.images ?? []) {
    if (!image.data) {
      continue;
    }

    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return { blocks, userText };
}

export function buildOpencodePromptBlocks(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): ACPContentBlock[] {
  return buildOpencodePrompt(request, conversationHistory).blocks;
}
