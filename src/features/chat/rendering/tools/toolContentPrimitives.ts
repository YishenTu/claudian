import { setIcon } from 'obsidian';

import { getToolIcon, MCP_ICON_MARKER } from '@/core/tools/toolIcons';
import { appendMCPIcon } from '@/shared/icons';

export function setToolIcon(el: HTMLElement, name: string): void {
  const icon = getToolIcon(name);
  if (icon === MCP_ICON_MARKER) {
    appendMCPIcon(el);
  } else {
    setIcon(el, icon);
  }
}

export function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function getInputText(input: Record<string, unknown>, key: string, fallback = ''): string {
  return stringifyToolValue(input[key]) || fallback;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export function fileNameOnly(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

/** Keeps the last two segments of deep paths for accessible labels. */
export function shortenPath(filePath: string | undefined): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return '.../' + parts.slice(-2).join('/');
}

export function formatToolDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value, null, 2);
}

export function renderEmptyResult(container: HTMLElement, text = 'No result'): void {
  container.createDiv({ cls: 'claudian-tool-empty', text });
}

export function contentFallback(container: HTMLElement, text: string): void {
  const resultRow = container.createDiv({ cls: 'claudian-tool-result-row' });
  const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
  resultText.setText(text);
}

export function renderLinesExpanded(
  container: HTMLElement,
  result: string,
  maxLines: number,
  hoverable = false
): void {
  const displayLines = result.split(/\r?\n/, maxLines);
  let lineCount = 1;
  for (let offset = result.indexOf('\n'); offset !== -1; offset = result.indexOf('\n', offset + 1)) lineCount++;
  const truncated = lineCount > maxLines;

  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
  for (const line of displayLines) {
    const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
    if (hoverable) lineEl.addClass('hoverable');
    lineEl.setText(line || ' ');
  }

  if (truncated) {
    linesEl.createDiv({
      cls: 'claudian-tool-truncated',
      text: `... ${lineCount - maxLines} more lines`,
    });
  }
}

/** Web URLs become external links; native page references stay plain text. */
export function appendToolLink(parent: HTMLElement, title: string, url: string): void {
  let isWebURL = false;
  try { isWebURL = ['https:', 'http:'].includes(new URL(url).protocol); } catch { /* Reference or malformed URL. */ }
  if (!isWebURL) {
    parent.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap', text: title });
    return;
  }
  const linkEl = parent.createEl('a', { cls: 'claudian-tool-link' });
  linkEl.setAttribute('href', url);
  linkEl.setAttribute('target', '_blank');
  linkEl.setAttribute('rel', 'noopener noreferrer');

  const iconEl = linkEl.createSpan({ cls: 'claudian-tool-link-icon' });
  setIcon(iconEl, 'external-link');

  linkEl.createSpan({ cls: 'claudian-tool-link-title', text: title });
}
