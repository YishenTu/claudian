import { setIcon } from 'obsidian';
import { SubagentInfo, ToolCallInfo } from '../types';
import { getToolLabel } from './ToolCallRenderer';

/**
 * State for a streaming subagent block
 */
export interface SubagentState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  countEl: HTMLElement;
  statusEl: HTMLElement;
  chevronEl: HTMLElement;
  info: SubagentInfo;
  currentToolEl: HTMLElement | null;
  currentResultEl: HTMLElement | null;
}

/**
 * Extract the description from Task tool input
 */
function extractTaskDescription(input: Record<string, unknown>): string {
  // Task tool has 'description' (short) and 'prompt' (detailed)
  return (input.description as string) || 'Subagent task';
}

/**
 * Truncate description for display in header
 */
function truncateDescription(description: string, maxLength = 40): string {
  if (description.length <= maxLength) return description;
  return description.substring(0, maxLength) + '...';
}

/**
 * Truncate result to max 2 lines
 */
function truncateResult(result: string): string {
  const lines = result.split('\n').filter(line => line.trim());
  if (lines.length <= 2) {
    return lines.join('\n');
  }
  return lines.slice(0, 2).join('\n') + '...';
}


/**
 * Create a subagent block for a Task tool call (streaming)
 * Follows TodoListRenderer pattern - expanded by default
 */
export function createSubagentBlock(
  parentEl: HTMLElement,
  taskToolId: string,
  taskInput: Record<string, unknown>
): SubagentState {
  const description = extractTaskDescription(taskInput);

  const info: SubagentInfo = {
    id: taskToolId,
    description,
    status: 'running',
    toolCalls: [],
    isExpanded: true, // Expanded by default
  };

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list expanded' });
  wrapperEl.dataset.subagentId = taskToolId;

  // Header (clickable to collapse/expand)
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });

  // Chevron
  const chevronEl = headerEl.createDiv({ cls: 'claudian-subagent-chevron' });
  setIcon(chevronEl, 'chevron-down'); // Expanded by default

  // Robot icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  setIcon(iconEl, 'bot');

  // Label (description only)
  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  // Tool count badge
  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  countEl.setText('0 tool uses');

  // Status indicator (spinner initially)
  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.createSpan({ cls: 'claudian-spinner' });

  // Content (expanded by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  // No display:none since expanded by default

  // Toggle collapse on header click
  headerEl.addEventListener('click', () => {
    info.isExpanded = !info.isExpanded;
    if (info.isExpanded) {
      wrapperEl.addClass('expanded');
      setIcon(chevronEl, 'chevron-down');
      contentEl.style.display = 'block';
    } else {
      wrapperEl.removeClass('expanded');
      setIcon(chevronEl, 'chevron-right');
      contentEl.style.display = 'none';
    }
  });

  return {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    countEl,
    statusEl,
    chevronEl,
    info,
    currentToolEl: null,
    currentResultEl: null,
  };
}

/**
 * Add a tool call to a subagent's content area
 * Only shows the current tool (replaces previous)
 */
export function addSubagentToolCall(
  state: SubagentState,
  toolCall: ToolCallInfo
): void {
  state.info.toolCalls.push(toolCall);

  // Update count badge
  const toolCount = state.info.toolCalls.length;
  state.countEl.setText(`${toolCount} tool uses`);

  // Clear previous tool and result
  state.contentEl.empty();
  state.currentResultEl = null;

  // Render current tool item with tree branch
  const itemEl = state.contentEl.createDiv({
    cls: `claudian-subagent-tool-item claudian-subagent-tool-${toolCall.status}`
  });
  itemEl.dataset.toolId = toolCall.id;
  state.currentToolEl = itemEl;

  // Tool row (branch + label)
  const toolRowEl = itemEl.createDiv({ cls: 'claudian-subagent-tool-row' });

  // Tree branch indicator
  const branchEl = toolRowEl.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');

  // Tool label
  const labelEl = toolRowEl.createDiv({ cls: 'claudian-subagent-tool-text' });
  labelEl.setText(getToolLabel(toolCall.name, toolCall.input));
}

/**
 * Update a nested tool call with its result
 */
export function updateSubagentToolResult(
  state: SubagentState,
  toolId: string,
  toolCall: ToolCallInfo
): void {
  // Update the tool call in our info
  const idx = state.info.toolCalls.findIndex(tc => tc.id === toolId);
  if (idx !== -1) {
    state.info.toolCalls[idx] = toolCall;
  }

  // Update current tool element if it matches
  if (state.currentToolEl && state.currentToolEl.dataset.toolId === toolId) {
    // Update class for styling (no status icon change)
    state.currentToolEl.className = `claudian-subagent-tool-item claudian-subagent-tool-${toolCall.status}`;

    // Add or update result area nested under tool (max 2 lines)
    if (toolCall.result) {
      if (!state.currentResultEl) {
        // Create result row nested inside tool item
        state.currentResultEl = state.currentToolEl.createDiv({ cls: 'claudian-subagent-tool-result' });
        // Add tree branch for result (indented)
        const branchEl = state.currentResultEl.createDiv({ cls: 'claudian-subagent-branch' });
        branchEl.setText('└─');
        const textEl = state.currentResultEl.createDiv({ cls: 'claudian-subagent-result-text' });
        textEl.setText(truncateResult(toolCall.result));
      } else {
        const textEl = state.currentResultEl.querySelector('.claudian-subagent-result-text');
        if (textEl) {
          textEl.setText(truncateResult(toolCall.result));
        }
      }
    }
  }
  // Note: Don't revert label to description here - wait for next tool or finalize
}

/**
 * Finalize a subagent when its Task tool_result is received
 */
export function finalizeSubagentBlock(
  state: SubagentState,
  result: string,
  isError: boolean
): void {
  state.info.status = isError ? 'error' : 'completed';
  state.info.result = result;

  // Update header label
  state.labelEl.setText(truncateDescription(state.info.description));

  // Keep showing tool count
  const toolCount = state.info.toolCalls.length;
  state.countEl.setText(`${toolCount} tool uses`);

  // Update status indicator
  state.statusEl.className = 'claudian-subagent-status';
  state.statusEl.addClass(`status-${state.info.status}`);
  state.statusEl.empty();
  if (state.info.status === 'completed') {
    setIcon(state.statusEl, 'check');
  } else {
    setIcon(state.statusEl, 'x');
  }

  // Add done class for styling if needed
  if (state.info.status === 'completed') {
    state.wrapperEl.addClass('done');
  } else if (state.info.status === 'error') {
    state.wrapperEl.addClass('error');
  }

  // Replace content with "DONE" or error message
  state.contentEl.empty();
  state.currentToolEl = null;
  state.currentResultEl = null;

  const doneEl = state.contentEl.createDiv({ cls: 'claudian-subagent-done' });
  const branchEl = doneEl.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = doneEl.createDiv({ cls: 'claudian-subagent-done-text' });
  textEl.setText(isError ? 'ERROR' : 'DONE');
}

/**
 * Render a stored subagent from conversation history
 * Collapsed by default (like stored todos)
 */
export function renderStoredSubagent(
  parentEl: HTMLElement,
  subagent: SubagentInfo
): HTMLElement {
  const isExpanded = false; // Collapsed by default for stored

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  if (isExpanded) {
    wrapperEl.addClass('expanded');
  }
  if (subagent.status === 'completed') {
    wrapperEl.addClass('done');
  } else if (subagent.status === 'error') {
    wrapperEl.addClass('error');
  }
  wrapperEl.dataset.subagentId = subagent.id;

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });

  const chevronEl = headerEl.createDiv({ cls: 'claudian-subagent-chevron' });
  setIcon(chevronEl, isExpanded ? 'chevron-down' : 'chevron-right');

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  setIcon(iconEl, 'bot');

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(subagent.description));

  // Tool count badge
  const toolCount = subagent.toolCalls.length;
  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  countEl.setText(`${toolCount} tool uses`);

  // Status indicator
  const statusEl = headerEl.createDiv({ cls: `claudian-subagent-status status-${subagent.status}` });
  if (subagent.status === 'completed') {
    setIcon(statusEl, 'check');
  } else if (subagent.status === 'error') {
    setIcon(statusEl, 'x');
  } else {
    statusEl.createSpan({ cls: 'claudian-spinner' });
  }

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  if (!isExpanded) {
    contentEl.style.display = 'none';
  }

  // Show "DONE" or "ERROR" for completed subagents
  if (subagent.status === 'completed' || subagent.status === 'error') {
    const doneEl = contentEl.createDiv({ cls: 'claudian-subagent-done' });
    const branchEl = doneEl.createDiv({ cls: 'claudian-subagent-branch' });
    branchEl.setText('└─');
    const textEl = doneEl.createDiv({ cls: 'claudian-subagent-done-text' });
    textEl.setText(subagent.status === 'error' ? 'ERROR' : 'DONE');
  } else {
    // For running subagents, show the last tool call
    const lastTool = subagent.toolCalls[subagent.toolCalls.length - 1];
    if (lastTool) {
      const itemEl = contentEl.createDiv({
        cls: `claudian-subagent-tool-item claudian-subagent-tool-${lastTool.status}`
      });

      // Tool row (branch + label)
      const toolRowEl = itemEl.createDiv({ cls: 'claudian-subagent-tool-row' });
      const branchEl = toolRowEl.createDiv({ cls: 'claudian-subagent-branch' });
      branchEl.setText('└─');
      const toolLabelEl = toolRowEl.createDiv({ cls: 'claudian-subagent-tool-text' });
      toolLabelEl.setText(getToolLabel(lastTool.name, lastTool.input));

      // Show result if available (nested under tool)
      if (lastTool.result) {
        const resultEl = itemEl.createDiv({ cls: 'claudian-subagent-tool-result' });
        const resultBranchEl = resultEl.createDiv({ cls: 'claudian-subagent-branch' });
        resultBranchEl.setText('└─');
        const textEl = resultEl.createDiv({ cls: 'claudian-subagent-result-text' });
        textEl.setText(truncateResult(lastTool.result));
      }
    }
  }

  // Toggle collapse on header click
  headerEl.addEventListener('click', () => {
    const expanded = wrapperEl.hasClass('expanded');
    if (expanded) {
      wrapperEl.removeClass('expanded');
      setIcon(chevronEl, 'chevron-right');
      contentEl.style.display = 'none';
    } else {
      wrapperEl.addClass('expanded');
      setIcon(chevronEl, 'chevron-down');
      contentEl.style.display = 'block';
    }
  });

  return wrapperEl;
}
