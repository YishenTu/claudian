/**
 * Claudian - Tool call renderer
 *
 * Renders tool call UI elements with expand/collapse and status indicators.
 */

import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';
import { getToolIcon, MCP_ICON_MARKER } from '../../../core/tools/toolIcons';
import type { ToolCallInfo } from '../../../core/types';
import { MCP_ICON_SVG } from '../../../shared/icons';
import { setupCollapsible } from './collapsible';
import { renderTodoItems } from './todoUtils';

// Note: getToolIcon is now exported from src/core/tools/index.ts
// This module uses it internally but does not re-export it.

/** Set the tool icon on an element. */
export function setToolIcon(el: HTMLElement, name: string) {
  const icon = getToolIcon(name);
  if (icon === MCP_ICON_MARKER) {
    el.innerHTML = MCP_ICON_SVG;
  } else {
    setIcon(el, icon);
  }
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

/** Get the current in_progress task from todos. */
export function getCurrentTask(input: Record<string, unknown>): TodoItem | undefined {
  const todos = input.todos as TodoItem[] | undefined;
  if (!todos || !Array.isArray(todos)) return undefined;
  return todos.find(t => t.status === 'in_progress');
}

/** Check if all todos are completed. */
export function areAllTodosCompleted(input: Record<string, unknown>): boolean {
  const todos = input.todos as TodoItem[] | undefined;
  if (!todos || !Array.isArray(todos) || todos.length === 0) return false;
  return todos.every(t => t.status === 'completed');
}

/** Render TodoWrite result showing todo items (reuses panel CSS). */
export function renderTodoWriteResult(
  container: HTMLElement,
  input: Record<string, unknown>
): void {
  container.empty();
  container.addClass('claudian-todo-panel-content');

  const todos = input.todos as TodoItem[] | undefined;
  if (!todos || !Array.isArray(todos)) {
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText('Tasks updated');
    return;
  }

  renderTodoItems(container, todos);
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

/** Renders a tool call UI element (for streaming). Collapsed by default. */
export function renderToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>
): HTMLElement {
  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });
  toolEl.dataset.toolId = toolCall.id;
  toolCallElements.set(toolCall.id, toolEl);

  // Header (clickable to expand/collapse)
  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  // aria-label is set dynamically by setupCollapsible based on expand state

  // Tool icon (decorative)
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Current task preview (TodoWrite only, shown when collapsed)
  let currentTaskEl: HTMLElement | null = null;
  if (toolCall.name === 'TodoWrite') {
    currentTaskEl = header.createSpan({ cls: 'claudian-tool-current' });
    const currentTask = getCurrentTask(toolCall.input);
    if (currentTask) {
      currentTaskEl.setText(currentTask.activeForm);
    }
  }

  // Status indicator
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  statusEl.addClass(`status-${toolCall.status}`);
  statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });

  // TodoWrite: render todo list directly (same as panel, no border)
  if (toolCall.name === 'TodoWrite') {
    content.addClass('claudian-tool-content-todo');
    renderTodoWriteResult(content, toolCall.input);
  } else {
    // Result row for other tools (border-left styling via CSS)
    const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
    const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
    resultText.setText('Running...');
  }

  // Setup collapsible behavior and sync state to toolCall
  const state = { isExpanded: false };
  toolCall.isExpanded = false;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded: false,
    onToggle: (expanded) => {
      toolCall.isExpanded = expanded;
      // Hide current task preview when expanded (TodoWrite only)
      if (currentTaskEl) {
        currentTaskEl.style.display = expanded ? 'none' : '';
      }
    },
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
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

  // TodoWrite: special handling for status based on todo completion
  if (toolCall.name === 'TodoWrite') {
    const statusEl = toolEl.querySelector('.claudian-tool-status');
    if (statusEl) {
      statusEl.className = 'claudian-tool-status';
      statusEl.empty();
      // Show check only when all todos are completed
      if (areAllTodosCompleted(toolCall.input)) {
        statusEl.addClass('status-completed');
        setIcon(statusEl as HTMLElement, 'check');
      } else {
        statusEl.addClass('status-running');
      }
    }
    const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
    if (content) {
      renderTodoWriteResult(content, toolCall.input);
    }
    // Update label with new counts
    const labelEl = toolEl.querySelector('.claudian-tool-label') as HTMLElement;
    if (labelEl) {
      labelEl.setText(getToolLabel(toolCall.name, toolCall.input));
    }
    // Update current task preview
    const currentTaskEl = toolEl.querySelector('.claudian-tool-current') as HTMLElement;
    if (currentTaskEl) {
      const currentTask = getCurrentTask(toolCall.input);
      currentTaskEl.setText(currentTask ? currentTask.activeForm : '');
    }
    return;
  }

  // Update status indicator for other tools
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

  // Update result text (max 3 lines) for other tools
  const resultText = toolEl.querySelector('.claudian-tool-result-text') as HTMLElement;
  if (resultText && toolCall.result) {
    // Try special rendering for specific tools, otherwise use generic line renderer
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

/** Render a stored tool call (non-streaming). Collapsed by default. */
export function renderStoredToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): HTMLElement {
  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });

  // Header
  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  // aria-label is set dynamically by setupCollapsible based on expand state

  // Tool icon (decorative)
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Current task preview (TodoWrite only, shown when collapsed)
  let currentTaskEl: HTMLElement | null = null;
  if (toolCall.name === 'TodoWrite') {
    currentTaskEl = header.createSpan({ cls: 'claudian-tool-current' });
    const currentTask = getCurrentTask(toolCall.input);
    if (currentTask) {
      currentTaskEl.setText(currentTask.activeForm);
    }
  }

  // Status indicator
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  if (toolCall.name === 'TodoWrite') {
    // TodoWrite: show check only when all todos are completed
    if (areAllTodosCompleted(toolCall.input)) {
      statusEl.addClass('status-completed');
      statusEl.setAttribute('aria-label', 'Status: completed');
      setIcon(statusEl, 'check');
    } else {
      statusEl.addClass('status-running');
      statusEl.setAttribute('aria-label', 'Status: in progress');
    }
  } else {
    statusEl.addClass(`status-${toolCall.status}`);
    statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);
    if (toolCall.status === 'completed') {
      setIcon(statusEl, 'check');
    } else if (toolCall.status === 'error') {
      setIcon(statusEl, 'x');
    } else if (toolCall.status === 'blocked') {
      setIcon(statusEl, 'shield-off');
    }
  }

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });

  // TodoWrite: render todo list directly (same as panel, no border)
  if (toolCall.name === 'TodoWrite') {
    content.addClass('claudian-tool-content-todo');
    renderTodoWriteResult(content, toolCall.input);
  } else {
    // Result row for other tools (border-left styling via CSS)
    const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
    const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
    if (toolCall.result) {
      // Try special rendering for specific tools, otherwise use generic line renderer
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
  }

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  const state = { isExpanded: false };
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded: false,
    onToggle: (expanded) => {
      // Hide current task preview when expanded (TodoWrite only)
      if (currentTaskEl) {
        currentTaskEl.style.display = expanded ? 'none' : '';
      }
    },
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
  });

  return toolEl;
}
