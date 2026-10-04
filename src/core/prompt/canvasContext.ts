import { escapePromptXMLAttribute, formatPromptXMLCdata } from './promptXML';

export interface CanvasSelectionContext {
  canvasPath: string;
  nodeIds: string[];
}

function formatCanvasContext(context: CanvasSelectionContext): string {
  if (context.nodeIds.length === 0) return '';
  return `<canvas_selection path="${escapePromptXMLAttribute(context.canvasPath)}">\n${formatPromptXMLCdata(
    context.nodeIds.join(', '),
  )}\n</canvas_selection>`;
}

export function appendCanvasContext(prompt: string, context: CanvasSelectionContext): string {
  const formatted = formatCanvasContext(context);
  return formatted ? `${prompt}\n\n${formatted}` : prompt;
}
