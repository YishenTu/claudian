import { setIcon } from 'obsidian';
import { ToolCallInfo } from '../types';

/**
 * Tool icon mapping
 */
const TOOL_ICONS: Record<string, string> = {
  'Read': 'file-text',
  'Write': 'edit-3',
  'Edit': 'edit',
  'Bash': 'terminal',
  'Glob': 'folder-search',
  'Grep': 'search',
  'LS': 'list',
  'TodoWrite': 'list-checks',
};

/**
 * Get the appropriate icon for a tool
 */
export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || 'wrench';
}

/**
 * Set the tool icon on an element
 */
export function setToolIcon(el: HTMLElement, name: string) {
  setIcon(el, getToolIcon(name));
}

/**
 * Generate a human-readable label for a tool call
 */
export function getToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Read ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Write':
      return `Write ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Edit':
      return `Edit ${shortenPath(input.file_path as string) || 'file'}`;
    case 'Bash': {
      const cmd = (input.command as string) || 'command';
      return `Bash: ${cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd}`;
    }
    case 'Glob':
      return `Glob: ${input.pattern || 'files'}`;
    case 'Grep':
      return `Grep: ${input.pattern || 'pattern'}`;
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
    default:
      return name;
  }
}

/**
 * Shorten a file path for display
 */
function shortenPath(path: string | undefined): string {
  if (!path) return '';
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}

/**
 * Format tool input for display
 */
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
    default:
      return JSON.stringify(input, null, 2);
  }
}

/**
 * Truncate a result string for display
 */
export function truncateResult(result: string, maxLines = 20, maxLength = 2000): string {
  if (result.length > maxLength) {
    result = result.substring(0, maxLength) + '\n... (truncated)';
  }
  const lines = result.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
  }
  return result;
}

/**
 * Check if a tool result indicates a blocked action
 */
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

/**
 * Renders a tool call UI element (for streaming)
 */
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

  // Chevron icon
  const chevron = header.createSpan({ cls: 'claudian-tool-chevron' });
  setIcon(chevron, 'chevron-right');

  // Tool icon
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Status indicator
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  statusEl.addClass(`status-${toolCall.status}`);
  if (toolCall.status === 'running') {
    statusEl.createSpan({ cls: 'claudian-spinner' });
  }

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });
  content.style.display = 'none';

  // Input parameters
  const inputSection = content.createDiv({ cls: 'claudian-tool-input' });
  inputSection.createDiv({ cls: 'claudian-tool-section-label', text: 'Input' });
  const inputCode = inputSection.createEl('pre', { cls: 'claudian-tool-code' });
  inputCode.setText(formatToolInput(toolCall.name, toolCall.input));

  // Result placeholder
  const resultSection = content.createDiv({ cls: 'claudian-tool-result' });
  resultSection.createDiv({ cls: 'claudian-tool-section-label', text: 'Result' });
  const resultCode = resultSection.createEl('pre', { cls: 'claudian-tool-code claudian-tool-result-code' });
  resultCode.setText('Running...');

  // Toggle expand/collapse on header click
  header.addEventListener('click', () => {
    toolCall.isExpanded = !toolCall.isExpanded;
    if (toolCall.isExpanded) {
      content.style.display = 'block';
      toolEl.addClass('expanded');
      setIcon(chevron, 'chevron-down');
    } else {
      content.style.display = 'none';
      toolEl.removeClass('expanded');
      setIcon(chevron, 'chevron-right');
    }
  });

  return toolEl;
}

/**
 * Update a tool call element with result
 */
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

  // Update result content
  const resultCode = toolEl.querySelector('.claudian-tool-result-code');
  if (resultCode && toolCall.result) {
    const truncated = truncateResult(toolCall.result);
    resultCode.setText(truncated);
  }
}

/**
 * Render a stored tool call (non-streaming, already completed)
 */
export function renderStoredToolCall(parentEl: HTMLElement, toolCall: ToolCallInfo): HTMLElement {
  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });

  // Header
  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });

  // Chevron icon
  const chevron = header.createSpan({ cls: 'claudian-tool-chevron' });
  setIcon(chevron, 'chevron-right');

  // Tool icon
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  setToolIcon(iconEl, toolCall.name);

  // Tool label
  const labelEl = header.createSpan({ cls: 'claudian-tool-label' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));

  // Status indicator (already completed)
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  statusEl.addClass(`status-${toolCall.status}`);
  if (toolCall.status === 'completed') {
    setIcon(statusEl, 'check');
  } else if (toolCall.status === 'error') {
    setIcon(statusEl, 'x');
  } else if (toolCall.status === 'blocked') {
    setIcon(statusEl, 'shield-off');
  }

  // Collapsible content
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });
  content.style.display = 'none';

  // Input parameters
  const inputSection = content.createDiv({ cls: 'claudian-tool-input' });
  inputSection.createDiv({ cls: 'claudian-tool-section-label', text: 'Input' });
  const inputCode = inputSection.createEl('pre', { cls: 'claudian-tool-code' });
  inputCode.setText(formatToolInput(toolCall.name, toolCall.input));

  // Result
  const resultSection = content.createDiv({ cls: 'claudian-tool-result' });
  resultSection.createDiv({ cls: 'claudian-tool-section-label', text: 'Result' });
  const resultCode = resultSection.createEl('pre', { cls: 'claudian-tool-code' });
  resultCode.setText(toolCall.result ? truncateResult(toolCall.result) : 'No result');

  // Toggle expand/collapse on header click
  let isExpanded = false;
  header.addEventListener('click', () => {
    isExpanded = !isExpanded;
    if (isExpanded) {
      content.style.display = 'block';
      toolEl.addClass('expanded');
      setIcon(chevron, 'chevron-down');
    } else {
      content.style.display = 'none';
      toolEl.removeClass('expanded');
      setIcon(chevron, 'chevron-right');
    }
  });

  return toolEl;
}
