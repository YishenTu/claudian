import type { ChatTurnRequest } from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendCurrentNote } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export function buildKimiPromptText(
  request: ChatTurnRequest,
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

export function buildKimiPromptBlocks(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [
    { type: 'text', text: buildKimiPromptText(request, conversationHistory) },
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

  // External context paths as embedded resource links (text bodies come via FS if needed).
  for (const contextPath of request.externalContextPaths ?? []) {
    const trimmed = typeof contextPath === 'string' ? contextPath.trim() : '';
    if (!trimmed) {
      continue;
    }
    const uri = trimmed.startsWith('file://') || trimmed.includes('://')
      ? trimmed
      : `file://${trimmed}`;
    blocks.push({
      name: trimmed.split(/[\\/]/).pop() || trimmed,
      type: 'resource_link',
      uri,
    });
  }

  return blocks;
}
