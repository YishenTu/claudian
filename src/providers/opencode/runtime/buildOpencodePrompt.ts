import type { ChatMessage, ImageAttachment } from '../../../core/types';
import {
  appendBrowserContext,
  type BrowserSelectionContext,
} from '../../../utils/browser';
import {
  appendCanvasContext,
  type CanvasSelectionContext,
} from '../../../utils/canvas';
import { appendCurrentNote } from '../../../utils/context';
import {
  appendEditorContext,
  type EditorSelectionContext,
} from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export interface OpencodePromptRequest {
  text: string;
  images?: ImageAttachment[];
  currentNotePath?: string;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
  externalContextPaths?: string[];
}

export function buildOpencodePromptText(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = appendCurrentNote(prompt, request.currentNotePath);
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

export function buildOpencodePromptBlocks(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [
    { type: 'text', text: buildOpencodePromptText(request, conversationHistory) },
  ];

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

  return blocks;
}
