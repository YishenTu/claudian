import { Platform } from 'obsidian';

import type { ToolResultImage } from '@/core/types';
import {
  contentFallback,
  fileNameOnly,
  formatToolDisplayValue,
  getInputText,
  renderEmptyResult,
  renderLinesExpanded,
  setToolIcon,
} from '@/features/chat/rendering/tools/toolContentPrimitives';

/** Shared expanded bodies for tools whose result is plain or lightly structured text. */

export function renderBashContent(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string,
  pendingText?: string,
): void {
  const command = (input.command as string) || '';
  if (command) {
    const cmdEl = container.createDiv({ cls: 'claudian-tool-bash-command' });
    cmdEl.setText(`$ ${command}`);
  }
  if (pendingText) {
    contentFallback(container, pendingText);
  } else if (result) {
    renderLinesExpanded(container, result, 20);
  } else {
    renderEmptyResult(container);
  }
}

/** Strips `N→` line-number gutters only when every leading line carries the next consecutive number. */
function stripLegacyLineNumberGutters(result: string): string {
  const lines = result.split(/\r?\n/);
  const first = lines[0]?.match(/^\s*(\d+)→/);
  const second = lines[1]?.match(/^\s*(\d+)→/);
  if (!first || (lines.length > 1 && lines[1] !== '' && Number(second?.[1]) !== Number(first[1]) + 1)) return result;
  const start = Number(first[1]);
  return lines.map((line, index) => {
    const gutter = line.match(/^\s*(\d+)→/);
    return gutter && Number(gutter[1]) === start + index ? line.slice(gutter[0].length) : line;
  }).join('\n');
}

export function renderReadExpanded(container: HTMLElement, result: string, resultFormat: string | undefined): void {
  renderLinesExpanded(container, resultFormat === 'plain' ? result : stripLegacyLineNumberGutters(result), 15);
}

export function renderFileSearchExpanded(container: HTMLElement, result: string): void {
  if (!result.trim()) {
    renderEmptyResult(container, 'No matches found');
    return;
  }
  renderLinesExpanded(container, result, 15, true);
}

export function renderToolSearchExpanded(container: HTMLElement, result: string): void {
  let toolNames: string[] = [];
  try {
    const parsed = JSON.parse(result) as Array<{ type: string; tool_name: string }>;
    if (Array.isArray(parsed)) {
      toolNames = parsed
        .filter(item => item.type === 'tool_reference' && item.tool_name)
        .map(item => item.tool_name);
    }
  } catch {
    // Fall back to showing raw result
  }

  if (toolNames.length === 0) {
    renderLinesExpanded(container, result, 20);
    return;
  }

  for (const name of toolNames) {
    const lineEl = container.createDiv({ cls: 'claudian-tool-search-item' });
    const iconEl = lineEl.createSpan({ cls: 'claudian-tool-search-icon' });
    setToolIcon(iconEl, name);
    lineEl.createSpan({ text: name });
  }
}

export function renderWebFetchExpanded(container: HTMLElement, result: string): void {
  const maxChars = 500;
  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
  const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap' });

  if (result.length > maxChars) {
    lineEl.setText(result.slice(0, maxChars));
    linesEl.createDiv({
      cls: 'claudian-tool-truncated',
      text: `... ${result.length - maxChars} more characters`,
    });
  } else {
    lineEl.setText(result);
  }
}

export function renderAgentLifecycleExpanded(
  container: HTMLElement,
  result: string,
  input: Record<string, unknown>,
  pendingText?: string,
): void {
  const target = getInputText(input, 'target');
  const message = getInputText(input, 'message');
  if (target || message) {
    const inputEl = container.createDiv({ cls: 'claudian-tool-lines' });
    if (target) inputEl.createDiv({ cls: 'claudian-tool-line', text: `Agent: ${target}` });
    if (message) inputEl.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap', text: message });
  }
  if (!result) {
    contentFallback(container, pendingText ?? 'No output');
    return;
  }
  // Try to parse as JSON for structured display
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
      for (const [key, value] of Object.entries(parsed)) {
        const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
        lineEl.setText(`${key}: ${formatToolDisplayValue(value)}`);
      }
      return;
    } catch { /* fall through to plain text */ }
  }
  renderLinesExpanded(container, result, 20);
}

/** Resolves a provider image to a URL the host webview can load. */
function getResultImageSource(image: ToolResultImage): string {
  if (image.kind === 'data') return `data:${image.mediaType};base64,${image.data}`;
  const segments = image.path.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  return Platform.resourcePathPrefix + segments
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
}

export function renderResultImages(container: HTMLElement, images: ToolResultImage[]): void {
  const imagesEl = container.createDiv({ cls: 'claudian-tool-result-images' });
  for (const image of images) {
    const alt = image.alt ?? (image.kind === 'file' ? fileNameOnly(image.path) : image.mediaType);
    imagesEl.createEl('img', { cls: 'claudian-tool-result-image', attr: { alt, loading: 'lazy', src: getResultImageSource(image) } });
  }
}
