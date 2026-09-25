import { escapePromptXMLAttribute, formatPromptXMLCdata } from './promptXML';

export interface BrowserSelectionContext {
  source: string;
  selectedText: string;
  title?: string;
  url?: string;
}

function buildAttributeList(context: BrowserSelectionContext): string {
  const attrs: string[] = [];
  const source = context.source.trim() || 'unknown';
  attrs.push(`source="${escapePromptXMLAttribute(source)}"`);

  if (context.title?.trim()) {
    attrs.push(`title="${escapePromptXMLAttribute(context.title.trim())}"`);
  }

  if (context.url?.trim()) {
    attrs.push(`url="${escapePromptXMLAttribute(context.url.trim())}"`);
  }

  return attrs.join(' ');
}

export function formatBrowserContext(context: BrowserSelectionContext): string {
  const selectedText = context.selectedText.trim();
  if (!selectedText) return '';
  const attrs = buildAttributeList(context);
  return `<browser_selection ${attrs}>\n${formatPromptXMLCdata(
    selectedText,
  )}\n</browser_selection>`;
}

export function appendBrowserContext(prompt: string, context: BrowserSelectionContext): string {
  const formatted = formatBrowserContext(context);
  return formatted ? `${prompt}\n\n${formatted}` : prompt;
}
