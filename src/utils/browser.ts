export interface BrowserSelectionContext {
  source: string;
  selectedText: string;
  title?: string;
  url?: string;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildAttributeList(context: BrowserSelectionContext): string {
  const attrs: string[] = [];
  const source = context.source.trim() || 'unknown';
  attrs.push(`source="${escapeXmlAttribute(source)}"`);

  if (context.title?.trim()) {
    attrs.push(`title="${escapeXmlAttribute(context.title.trim())}"`);
  }

  if (context.url?.trim()) {
    attrs.push(`url="${escapeXmlAttribute(context.url.trim())}"`);
  }

  return attrs.join(' ');
}

function escapeXmlBody(text: string): string {
  return text.replace(/<\/browser_selection>/gi, '&lt;/browser_selection&gt;');
}

export function formatBrowserContext(context: BrowserSelectionContext): string {
  const selectedText = context.selectedText.trim();
  if (!selectedText) return '';
  const attrs = buildAttributeList(context);
  return `<browser_selection ${attrs}>\n${escapeXmlBody(selectedText)}\n</browser_selection>`;
}

export function appendBrowserContext(prompt: string, context: BrowserSelectionContext): string {
  const formatted = formatBrowserContext(context);
  return formatted ? `${prompt}\n\n${formatted}` : prompt;
}
