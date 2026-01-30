import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';
import { getToolIcon, MCP_ICON_MARKER } from '../../../core/tools/toolIcons';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
  TOOL_SKILL,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { ToolCallInfo } from '../../../core/types';
import { MCP_ICON_SVG } from '../../../shared/icons';
import { setupCollapsible } from './collapsible';
import { renderTodoItems } from './todoUtils';

export function setToolIcon(el: HTMLElement, name: string) {
  const icon = getToolIcon(name);
  if (icon === MCP_ICON_MARKER) {
    el.innerHTML = MCP_ICON_SVG;
  } else {
    setIcon(el, icon);
  }
}

export function getToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case TOOL_READ:
      return `Read: ${shortenPath(input.file_path as string) || 'file'}`;
    case TOOL_WRITE:
      return `Write: ${shortenPath(input.file_path as string) || 'file'}`;
    case TOOL_EDIT:
      return `Edit: ${shortenPath(input.file_path as string) || 'file'}`;
    case TOOL_BASH: {
      const cmd = (input.command as string) || 'command';
      return `Bash: ${cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd}`;
    }
    case TOOL_GLOB:
      return `Glob: ${input.pattern || 'files'}`;
    case TOOL_GREP:
      return `Grep: ${input.pattern || 'pattern'}`;
    case TOOL_WEB_SEARCH: {
      const query = (input.query as string) || 'search';
      return `WebSearch: ${query.length > 40 ? query.substring(0, 40) + '...' : query}`;
    }
    case TOOL_WEB_FETCH: {
      const url = (input.url as string) || 'url';
      return `WebFetch: ${url.length > 40 ? url.substring(0, 40) + '...' : url}`;
    }
    case TOOL_LS:
      return `LS: ${shortenPath(input.path as string) || '.'}`;
    case TOOL_TODO_WRITE: {
      const todos = input.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos)) {
        const completed = todos.filter(t => t.status === 'completed').length;
        return `Tasks (${completed}/${todos.length})`;
      }
      return 'Tasks';
    }
    case TOOL_SKILL: {
      const skillName = (input.skill as string) || 'skill';
      return `Skill: ${skillName}`;
    }
    default:
      return name;
  }
}

function shortenPath(filePath: string | undefined): string {
  if (!filePath) return '';
  // Normalize path separators for cross-platform support
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return '.../' + parts.slice(-2).join('/');
}

export function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
      return input.file_path as string || JSON.stringify(input, null, 2);
    case TOOL_BASH:
      return (input.command as string) || JSON.stringify(input, null, 2);
    case TOOL_GLOB:
    case TOOL_GREP:
      return (input.pattern as string) || JSON.stringify(input, null, 2);
    case TOOL_WEB_SEARCH:
      return (input.query as string) || JSON.stringify(input, null, 2);
    case TOOL_WEB_FETCH:
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

export function renderReadResult(container: HTMLElement, result: string): void {
  container.empty();
  const lines = result.split(/\r?\n/).filter(line => line.trim() !== '');
  const item = container.createSpan({ cls: 'claudian-tool-result-item' });
  item.setText(`${lines.length} lines read`);
}

function getTodos(input: Record<string, unknown>): TodoItem[] | undefined {
  const todos = input.todos;
  if (!todos || !Array.isArray(todos)) return undefined;
  return todos as TodoItem[];
}

export function getCurrentTask(input: Record<string, unknown>): TodoItem | undefined {
  const todos = getTodos(input);
  if (!todos) return undefined;
  return todos.find(t => t.status === 'in_progress');
}

export function areAllTodosCompleted(input: Record<string, unknown>): boolean {
  const todos = getTodos(input);
  if (!todos || todos.length === 0) return false;
  return todos.every(t => t.status === 'completed');
}

function resetStatusElement(statusEl: HTMLElement, statusClass: string, ariaLabel: string): void {
  statusEl.className = 'claudian-tool-status';
  statusEl.empty();
  statusEl.addClass(statusClass);
  statusEl.setAttribute('aria-label', ariaLabel);
}

const STATUS_ICONS: Record<string, string> = {
  completed: 'check',
  error: 'x',
  blocked: 'shield-off',
};

function setTodoWriteStatus(statusEl: HTMLElement, input: Record<string, unknown>): void {
  const isComplete = areAllTodosCompleted(input);
  const status = isComplete ? 'completed' : 'running';
  const ariaLabel = isComplete ? 'Status: completed' : 'Status: in progress';
  resetStatusElement(statusEl, `status-${status}`, ariaLabel);
  if (isComplete) setIcon(statusEl, 'check');
}

function setToolStatus(statusEl: HTMLElement, status: ToolCallInfo['status']): void {
  resetStatusElement(statusEl, `status-${status}`, `Status: ${status}`);
  const icon = STATUS_ICONS[status];
  if (icon) setIcon(statusEl, icon);
}

function renderToolResultContent(
  container: HTMLElement,
  toolName: string,
  result: string | undefined
): void {
  if (!result) {
    container.setText('No result');
    return;
  }
  if (toolName === TOOL_WEB_SEARCH) {
    if (!renderWebSearchResult(container, result, 3)) {
      renderResultLines(container, result, 3);
    }
  } else if (toolName === TOOL_READ) {
    renderReadResult(container, result);
  } else {
    renderResultLines(container, result, 3);
  }
}

function createCurrentTaskPreview(
  header: HTMLElement,
  input: Record<string, unknown>
): HTMLElement {
  const currentTaskEl = header.createSpan({ cls: 'claudian-tool-current' });
  const currentTask = getCurrentTask(input);
  if (currentTask) {
    currentTaskEl.setText(currentTask.activeForm);
  }
  return currentTaskEl;
}

function createTodoToggleHandler(
  currentTaskEl: HTMLElement | null,
  statusEl: HTMLElement | null,
  onExpandChange?: (expanded: boolean) => void
): (expanded: boolean) => void {
  return (expanded: boolean) => {
    if (onExpandChange) onExpandChange(expanded);
    if (currentTaskEl) {
      currentTaskEl.style.display = expanded ? 'none' : '';
    }
    if (statusEl) {
      statusEl.style.display = expanded ? 'none' : '';
    }
  };
}

export function renderTodoWriteResult(
  container: HTMLElement,
  input: Record<string, unknown>
): void {
  container.empty();
  container.addClass('claudian-todo-panel-content');
  container.addClass('claudian-todo-list-container');

  const todos = input.todos as TodoItem[] | undefined;
  if (!todos || !Array.isArray(todos)) {
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText('Tasks updated');
    return;
  }

  renderTodoItems(container, todos);
}

/** Strips line number prefixes (e.g., "  1→"). */
export function renderResultLines(container: HTMLElement, result: string, maxLines = 3): void {
  container.empty();

  const lines = result.split(/\r?\n/);
  const displayLines = lines.slice(0, maxLines);

  displayLines.forEach(line => {
    const stripped = line.replace(/^\s*\d+→/, '');
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText(stripped);
  });

  if (lines.length > maxLines) {
    const more = container.createSpan({ cls: 'claudian-tool-result-item' });
    more.setText(`${lines.length - maxLines} more lines`);
  }
}

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

interface ToolElementStructure {
  toolEl: HTMLElement;
  header: HTMLElement;
  labelEl: HTMLElement;
  statusEl: HTMLElement;
  content: HTMLElement;
  currentTaskEl: HTMLElement | null;
}

function createToolElementStructure(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): ToolElementStructure {
  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });

  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  // aria-label is set dynamically by setupCollapsible based on expand state

  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  const currentTaskEl = toolCall.name === TOOL_TODO_WRITE
    ? createCurrentTaskPreview(header, toolCall.input)
    : null;

  // Caller sets the status after creation
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });

  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });

  return { toolEl, header, labelEl, statusEl, content, currentTaskEl };
}

function formatAnswer(raw: unknown): string {
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') return raw;
  return '';
}

function renderAskUserQuestionResult(container: HTMLElement, toolCall: ToolCallInfo): void {
  container.empty();
  const questions = toolCall.input.questions as Array<{ question: string }> | undefined;
  const answers = toolCall.resolvedAnswers as Record<string, unknown> | undefined;
  if (!questions || !Array.isArray(questions) || !answers) return;

  const reviewEl = container.createDiv({ cls: 'claudian-ask-review' });
  for (const q of questions) {
    const answer = formatAnswer(answers[q.question]);
    const qLine = reviewEl.createDiv({ cls: 'claudian-ask-review-q' });
    qLine.createSpan({ text: q.question, cls: 'claudian-ask-review-q-text' });
    const aLine = reviewEl.createDiv({ cls: 'claudian-ask-review-a' });
    aLine.createSpan({ text: '\u2192 ', cls: 'claudian-ask-review-arrow' });
    aLine.createSpan({
      text: answer || 'Not answered',
      cls: answer ? 'claudian-ask-review-a-text' : 'claudian-ask-review-empty',
    });
  }
}

function renderToolContent(
  content: HTMLElement,
  toolCall: ToolCallInfo,
  initialText?: string
): void {
  if (toolCall.name === TOOL_TODO_WRITE) {
    content.addClass('claudian-tool-content-todo');
    renderTodoWriteResult(content, toolCall.input);
  } else if (toolCall.name === TOOL_ASK_USER_QUESTION) {
    content.addClass('claudian-tool-content-ask');
    if (initialText || !toolCall.resolvedAnswers) {
      const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
      const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
      resultText.setText('Waiting for answer...');
    } else {
      renderAskUserQuestionResult(content, toolCall);
    }
  } else {
    const resultRow = content.createDiv({ cls: 'claudian-tool-result-row' });
    const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
    if (initialText) {
      resultText.setText(initialText);
    } else {
      renderToolResultContent(resultText, toolCall.name, toolCall.result);
    }
  }
}

/** For streaming — collapsed by default, registered in map for later updates. */
export function renderToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>
): HTMLElement {
  const { toolEl, header, statusEl, content, currentTaskEl } =
    createToolElementStructure(parentEl, toolCall);

  toolEl.dataset.toolId = toolCall.id;
  toolCallElements.set(toolCall.id, toolEl);

  statusEl.addClass(`status-${toolCall.status}`);
  statusEl.setAttribute('aria-label', `Status: ${toolCall.status}`);

  renderToolContent(content, toolCall, 'Running...');

  const state = { isExpanded: false };
  toolCall.isExpanded = false;
  const todoStatusEl = toolCall.name === TOOL_TODO_WRITE ? statusEl : null;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded: false,
    onToggle: createTodoToggleHandler(currentTaskEl, todoStatusEl, (expanded) => {
      toolCall.isExpanded = expanded;
    }),
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
  });

  return toolEl;
}

export function updateToolCallResult(
  toolId: string,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>
) {
  const toolEl = toolCallElements.get(toolId);
  if (!toolEl) return;

  if (toolCall.name === TOOL_TODO_WRITE) {
    const statusEl = toolEl.querySelector('.claudian-tool-status') as HTMLElement;
    if (statusEl) {
      setTodoWriteStatus(statusEl, toolCall.input);
    }
    const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
    if (content) {
      renderTodoWriteResult(content, toolCall.input);
    }
    const labelEl = toolEl.querySelector('.claudian-tool-label') as HTMLElement;
    if (labelEl) {
      labelEl.setText(getToolLabel(toolCall.name, toolCall.input));
    }
    const currentTaskEl = toolEl.querySelector('.claudian-tool-current') as HTMLElement;
    if (currentTaskEl) {
      const currentTask = getCurrentTask(toolCall.input);
      currentTaskEl.setText(currentTask ? currentTask.activeForm : '');
    }
    return;
  }

  const statusEl = toolEl.querySelector('.claudian-tool-status') as HTMLElement;
  if (statusEl) {
    setToolStatus(statusEl, toolCall.status);
  }

  if (toolCall.name === TOOL_ASK_USER_QUESTION) {
    const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
    if (content) {
      content.addClass('claudian-tool-content-ask');
      renderAskUserQuestionResult(content, toolCall);
    }
    return;
  }

  const resultText = toolEl.querySelector('.claudian-tool-result-text') as HTMLElement;
  if (resultText) {
    renderToolResultContent(resultText, toolCall.name, toolCall.result);
  }
}

/** For stored (non-streaming) tool calls — collapsed by default. */
export function renderStoredToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): HTMLElement {
  const { toolEl, header, statusEl, content, currentTaskEl } =
    createToolElementStructure(parentEl, toolCall);

  if (toolCall.name === TOOL_TODO_WRITE) {
    setTodoWriteStatus(statusEl, toolCall.input);
  } else {
    setToolStatus(statusEl, toolCall.status);
  }

  renderToolContent(content, toolCall);

  const state = { isExpanded: false };
  const todoStatusEl = toolCall.name === TOOL_TODO_WRITE ? statusEl : null;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded: false,
    onToggle: createTodoToggleHandler(currentTaskEl, todoStatusEl),
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
  });

  return toolEl;
}
