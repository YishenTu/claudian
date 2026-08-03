import { escapePromptXmlAttribute, formatPromptXmlCdata } from './promptXml';

export interface CanvasSelectionContext {
  canvasPath: string;
  nodeIds: string[];
}

export function formatCanvasContext(context: CanvasSelectionContext): string {
  if (context.nodeIds.length === 0) return '';
  return `<canvas_selection path="${escapePromptXmlAttribute(context.canvasPath)}">\n${formatPromptXmlCdata(
    context.nodeIds.join(', '),
  )}\n</canvas_selection>`;
}

export function appendCanvasContext(prompt: string, context: CanvasSelectionContext): string {
  const formatted = formatCanvasContext(context);
  return formatted ? `${prompt}\n\n${formatted}` : prompt;
}
