/**
 * Claudian - Tool call renderer
 *
 * Renders tool call UI elements with expand/collapse and status indicators.
 */

import { setIcon } from 'obsidian';

import { getToolIcon } from '../../core/tools/toolIcons';
import type { ToolCallInfo } from '../../core/types';

// Note: getToolIcon is now exported from src/tools/index.ts
// This module uses it internally but does not re-export it.

/** Set the tool icon on an element. */
export function setToolIcon(el: HTMLElement, name: string) {
  setIcon(el, getToolIcon(name));
}

/** Generate a human-readable label for a tool call. */
export function getToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Read: ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Write':
      return `Write: ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Edit':
      return `Edit: ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Bash': {
      const cmd = (input.command as string) || 'command';
      return `Bash: ${cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd}`;
    }
    case 'Glob':
      return `Glob: ${input.pattern || 'files'}`;
    case 'Grep':
      return `Grep: ${input.pattern || 'pattern'}`;
    case 'WebSearch': {
      const query = (input.query as string) || 'search';
      return `WebSearch: ${query.length > 40 ? query.substring(0, 40) + '...' : query}`;
    }
    case 'WebFetch': {
      const url = (input.url as string) || 'url';
      return `WebFetch: ${url.length > 40 ? url.substring(0, 40) + '...' : url}`;
    }
    case 'LS':
      return `LS: ${shortenPath(input.path as string) || '.'}`;
    case 'TodoWrite': {
      const todos = input.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos)) {
        const completed = todos.filter(t => t.status === 'completed').length;
        return `Tasks (${completed}/${todos.length})`;
      }
      return 'Tasks';
    }
    case 'Skill': {
      const skillName = (input.skill as string) || 'skill';
      return `Skill: ${skillName}`;
    }
    default:
      return name;
  }
}

/** Shorten a file path for display. */
function shortenPath(filePath: string | undefined): string {
  if (!filePath) return '';
  // Normalize path separators for cross-platform support
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return '.../' + parts.slice(-2).join('/');
}

/** Format tool input for display. */
export function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return input.file_path as string || JSON.stringify(input, null, 2);
    case 'Bash':
      return (input.command as string) || JSON.stringify(input, null, 2);
    case 'Glob':
    case 'Grep':
      return (input.pattern as string) || JSON.stringify(input, null, 2);
    case 'WebSearch':
      return (input.query as string) || JSON.stringify(input, null, 2);
    case 'WebFetch':
      return (input.url as string) || JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
  }
}

interface WebSearchLink {
  title: string;
  url: string;
}

function parseWebSearchResult(result: string): WebSearchLink[] | null {
  const linksMatch = result.match(/Links:\s*(\[[\s\S]*\])/);
  if (!linksMatch) return null;

  try {
    const links = JSON.parse(linksMatch[1]) as WebSearchLink[];
    if (!Array.isArray(links) || links.length === 0) return null;
    return links;
  } catch {
    return null;
  }
}

/** Render WebSearch result as DOM elements. */
export function renderWebSearchResult(container: HTMLElement, result: string, maxItems = 3): boolean {
  const links = parseWebSearchResult(result);
  if (!links) return false;

  container.empty();

  const displayItems = links.slice(0, maxItems);
  displayItems.forEach(link => {
    const item = container.createSpan({ cls: 'claudian-tool-result-bullet' });
    item.setText(`• ${link.title}`);
  });

  if (links.length > maxItems) {
    const more = container.createSpan({ cls: 'claudian-tool-result-item' });
    more.setText(`${links.length - maxItems} more results`);
  }

  return true;
}

/** Render Read tool result showing line count. */
export function renderReadResult(container: HTMLElement, result: string): void {
  container.empty();
  const lines = result.split(/\r?\n/).filter(line => line.trim() !== '');
  const item = container.createSpan({ cls: 'claudian-tool-result-item' });
  item.setText(`${lines.length} lines read`);
}

/** Render generic result as DOM elements. Strips line number prefixes. */
export function renderResultLines(container: HTMLElement, result: string, maxLines = 3): void {
  container.empty();

  const lines = result.split(/\r?\n/);
  const displayLines = lines.slice(0, maxLines);

  displayLines.forEach(line => {
    // Strip line number prefix (e.g., "  1→" or "123→")
    const stripped = line.replace(/^\s*\d+→/, '');
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText(stripped);
  });

  if (lines.length > maxLines) {
    const more = container.createSpan({ cls: 'claudian-tool-result-item' });
    more.setText(`${lines.length - maxLines} more lines`);
  }
}

/** Truncate a result string for display. */
export function truncateResult(result: string, maxLines = 20, maxLength = 2000): string {
  if (result.length > maxLength) {
    result = result.substring(0, maxLength);
  }
  const lines = result.split(/\r?\n/);
  if (lines.length > maxLines) {
    const moreLines = lines.length - maxLines;
    return lines.slice(0, maxLines).join('\n') + `\n${moreLines} more lines`;
  }
  return result;
}

/** Check if a tool result indicates a blocked action. */
export function isBlockedToolResult(content: string, isError?: boolean): boolean {
  const lower = content.toLowerCase();
  if (lower.includes('blocked by blocklist')) return true;
  if (lower.includes('outside the vault')) return true;
  if (lower.includes('access denied')) return true;
  if (lower.includes('user denied')) return true;
  if (lower.includes('approval')) return true;
  if (isError && lower.includes('deny')) return true;
  return false;
}

/** Renders a tool call UI element (for streaming). Collapsed by default unless overridden. */
export function renderToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>,
  expandedByDefault = false
): HTMLElement {
  const isExpanded = expandedByDefault;
  const toolEl = parentEl.createDiv({ cls: `claudian-tool-call${isExpanded ? ' expanded' : ''}` });
  toolEl.dataset.toolId = toolCall.id;
  toolCallElements.set(toolCall.id, toolEl);
  toolCall.isExpanded = isExpanded;

  // Header (clickable to expand/collapse)
  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  header.setAttribute('aria-label', `${getToolLabel(toolCall.name, toolCall.input)} - click to ${isExpanded ? 'collapse' : 'expand'}`);

  // Tool icon (decorative)
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Status indicator
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  statusEl.addClass(`status-${toolCall.status}`);
  statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);
  if (toolCall.status === 'running') {
    statusEl.createSpan({ cls: 'claudian-spinner' });
  }

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });
  if (!isExpanded) {
    content.style.display = 'none';
  }

  // Tree-branch result row
  const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
  const branch = resultRow.createSpan({ cls: 'claudian-tool-branch' });
  branch.setText('└─');
  const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
  resultText.setText('Running...');

  // Toggle expand/collapse handler
  const toggleExpand = () => {
    toolCall.isExpanded = !toolCall.isExpanded;
    if (toolCall.isExpanded) {
      content.style.display = 'block';
      toolEl.addClass('expanded');
      header.setAttribute('aria-expanded', 'true');
    } else {
      content.style.display = 'none';
      toolEl.removeClass('expanded');
      header.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  header.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return toolEl;
}

/** Update a tool call element with result. */
export function updateToolCallResult(
  toolId: string,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>
) {
  const toolEl = toolCallElements.get(toolId);
  if (!toolEl) return;

  // Update status indicator
  const statusEl = toolEl.querySelector('.claudian-tool-status');
  if (statusEl) {
    statusEl.className = 'claudian-tool-status';
    statusEl.addClass(`status-${toolCall.status}`);
    statusEl.empty();
    if (toolCall.status === 'completed') {
      setIcon(statusEl as HTMLElement, 'check');
    } else if (toolCall.status === 'error') {
      setIcon(statusEl as HTMLElement, 'x');
    } else if (toolCall.status === 'blocked') {
      setIcon(statusEl as HTMLElement, 'shield-off');
    }
  }

  // Update result text (max 3 lines)
  const resultText = toolEl.querySelector('.claudian-tool-result-text') as HTMLElement;
  if (resultText && toolCall.result) {
    // Try special rendering for WebSearch/Read, otherwise use generic line renderer
    if (toolCall.name === 'WebSearch') {
      if (!renderWebSearchResult(resultText, toolCall.result, 3)) {
        renderResultLines(resultText, toolCall.result, 3);
      }
    } else if (toolCall.name === 'Read') {
      renderReadResult(resultText, toolCall.result);
    } else {
      renderResultLines(resultText, toolCall.result, 3);
    }
  }
}

/** Render a stored tool call (non-streaming). Collapsed by default unless overridden. */
export function renderStoredToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  expandedByDefault = false
): HTMLElement {
  const toolEl = parentEl.createDiv({ cls: `claudian-tool-call${expandedByDefault ? ' expanded' : ''}` });

  // Header
  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', expandedByDefault ? 'true' : 'false');
  header.setAttribute('aria-label', `${getToolLabel(toolCall.name, toolCall.input)} - click to ${expandedByDefault ? 'collapse' : 'expand'}`);

  // Tool icon (decorative)
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Status indicator (already completed)
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  statusEl.addClass(`status-${toolCall.status}`);
  statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);
  if (toolCall.status === 'completed') {
    setIcon(statusEl, 'check');
  } else if (toolCall.status === 'error') {
    setIcon(statusEl, 'x');
  } else if (toolCall.status === 'blocked') {
    setIcon(statusEl, 'shield-off');
  }

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });
  if (!expandedByDefault) {
    content.style.display = 'none';
  }

  // Tree-branch result row
  const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
  const branch = resultRow.createSpan({ cls: 'claudian-tool-branch' });
  branch.setText('└─');
  const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
  if (toolCall.result) {
    // Try special rendering for WebSearch/Read, otherwise use generic line renderer
    if (toolCall.name === 'WebSearch') {
      if (!renderWebSearchResult(resultText, toolCall.result, 3)) {
        renderResultLines(resultText, toolCall.result, 3);
      }
    } else if (toolCall.name === 'Read') {
      renderReadResult(resultText, toolCall.result);
    } else {
      renderResultLines(resultText, toolCall.result, 3);
    }
  } else {
    resultText.setText('No result');
  }

  // Toggle expand/collapse handler
  let isExpanded = expandedByDefault;
  const toggleExpand = () => {
    isExpanded = !isExpanded;
    if (isExpanded) {
      content.style.display = 'block';
      toolEl.addClass('expanded');
      header.setAttribute('aria-expanded', 'true');
    } else {
      content.style.display = 'none';
      toolEl.removeClass('expanded');
      header.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  header.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return toolEl;
}
