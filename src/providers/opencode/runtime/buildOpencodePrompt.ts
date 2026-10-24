import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';
import { buildContextFromHistory } from '@/core/prompt/historyContext';
import {
  appendLinkedContent,
  appendLinkedContentBody,
  appendSelectionContexts,
  appendSessionReferences,
} from '@/core/prompt/promptContext';
import { buildRecoveryPrompt, decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';

import type { ProviderLinkedContentContext } from '../../../core/execution';
import type { ProviderSelectionSnapshot, ProviderSessionReference } from '../../../core/execution/ProviderExecutionRequest';
import type { ChatMessage, ImageAttachment } from '../../../core/types';

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

/** A native attachment, sent by URI. */
export interface OpencodePromptFile {
  readonly uri: string;
}

/** Native prompt input: composed text plus attached files. */
export interface OpencodePrompt {
  readonly text: string;
  readonly files: readonly OpencodePromptFile[];
  /** Absent when replayed history already ends with this turn's query. */
  readonly userText: OpencodeTextRange | null;
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

  const historyContext = buildContextFromHistory(conversationHistory);
  if (!historyContext) {
    return { text: prompt, userText: { start: 0, end: request.text.length } };
  }
  // Replayed history stays in an envelope that history readers strip.
  const text = buildRecoveryPrompt(historyContext, prompt, conversationHistory);
  const start = text.length - prompt.length;
  return {
    text,
    userText: decodeRecoveryPrompt(text)?.currentInput != null
      ? { start, end: start + request.text.length }
      : null,
  };
}

export function buildOpencodePrompt(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): OpencodePrompt {
  const { text, userText } = composeOpencodePromptText(request, conversationHistory);
  const files = (request.images ?? []).flatMap(image => (
    image.data ? [{ uri: `data:${image.mediaType};base64,${image.data}` }] : []
  ));
  return { text, files, userText };
}
