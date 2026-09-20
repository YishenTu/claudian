import type { ProviderLinkedContentContext } from '../../../core/execution';
import type { ChatMessage, ImageAttachment } from '../../../core/types';
import {
  appendBrowserContext,
  type BrowserSelectionContext,
} from '../../../utils/browser';
import {
  appendCanvasContext,
  type CanvasSelectionContext,
} from '../../../utils/canvas';
import {
  appendLinkedContent,
  appendLinkedContentBody,
} from '../../../utils/context';
import {
  appendEditorContext,
  type EditorSelectionContext,
} from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext, getHistoryImages } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export interface OpencodePromptRequest {
  text: string;
  images?: ImageAttachment[];
  linkedContent?: ProviderLinkedContentContext;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
}

export function buildOpencodePromptText(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
  preserveCapturedContext = false,
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

  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }

  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }

  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }

  if (conversationHistory.length > 0) {
    const historyContext = buildContextFromHistory(conversationHistory, { preserveCapturedContext });
    prompt = buildPromptWithHistoryContext(
      historyContext,
      prompt,
      prompt,
      conversationHistory,
    );
  }

  return prompt;
}

export function buildOpencodePromptBlocks(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
  preserveCapturedContext = false,
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [
    { type: 'text', text: buildOpencodePromptText(request, conversationHistory, preserveCapturedContext) },
  ];

  const historyImages = preserveCapturedContext ? getHistoryImages(conversationHistory) : [];
  for (const image of [...historyImages, ...(request.images ?? [])]) {
    if (!image.data) {
      continue;
    }

    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return blocks;
}
