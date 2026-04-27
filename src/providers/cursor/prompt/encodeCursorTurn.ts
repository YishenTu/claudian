import type { ChatTurnRequest, PreparedChatTurn } from '../../../core/runtime/types';

function isCompactCommand(text: string): boolean {
  return /^\/compact(\s|$)/i.test(text);
}

export function encodeCursorTurn(request: ChatTurnRequest): PreparedChatTurn {
  const isCompact = isCompactCommand(request.text);

  if (isCompact) {
    return {
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: true,
      mcpMentions: new Set(),
    };
  }

  const sections: string[] = [];
  sections.push(request.text);

  if (request.images?.length) {
    sections.push(
      `\n[The user attached ${request.images.length} image(s) in Claudian. Use vault paths or ask which files to read if you need the image bytes.]`,
    );
  }

  if (request.currentNotePath) {
    sections.push(`\n[Current note: ${request.currentNotePath}]`);
  }

  if (request.editorSelection?.selectedText) {
    sections.push(
      `\n[Editor selection from ${request.editorSelection.notePath || 'current note'}:\n${request.editorSelection.selectedText}\n]`,
    );
  }

  if (request.browserSelection?.selectedText) {
    sections.push(
      `\n[Browser selection from ${request.browserSelection.url ?? 'unknown page'}:\n${request.browserSelection.selectedText}\n]`,
    );
  }

  if (request.canvasSelection) {
    const nodeList = request.canvasSelection.nodeIds.join(', ');
    if (nodeList) {
      sections.push(
        `\n[Canvas selection from ${request.canvasSelection.canvasPath}:\n${nodeList}\n]`,
      );
    }
  }

  const prompt = sections.join('');

  return {
    request,
    persistedContent: request.text,
    prompt,
    isCompact: false,
    mcpMentions: new Set(),
  };
}
