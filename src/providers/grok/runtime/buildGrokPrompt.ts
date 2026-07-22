import type { ChatTurnRequest } from '../../../core/runtime/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendCurrentNote } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import type { AcpContentBlock } from '../../acp';

export function buildGrokPromptText(request: ChatTurnRequest): string {
  let prompt = request.text;
  if (request.currentNotePath) prompt = appendCurrentNote(prompt, request.currentNotePath);
  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }
  if (request.browserSelection) prompt = appendBrowserContext(prompt, request.browserSelection);
  if (request.canvasSelection) prompt = appendCanvasContext(prompt, request.canvasSelection);
  return prompt;
}

export function buildGrokPromptBlocks(request: ChatTurnRequest): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [{
    text: buildGrokPromptText(request),
    type: 'text',
  }];
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
