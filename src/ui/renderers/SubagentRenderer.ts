/**
 * Claudian - Subagent renderer
 *
 * Renders sync and async subagent blocks with nested tool tracking.
 */

import { setIcon } from 'obsidian';

import type { SubagentInfo, ToolCallInfo } from '../../core/types';
import { getToolLabel } from './ToolCallRenderer';

/** State for a streaming subagent block. */
export interface SubagentState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  countEl: HTMLElement;
  statusEl: HTMLElement;
  info: SubagentInfo;
  currentToolEl: HTMLElement | null;
  currentResultEl: HTMLElement | null;
}

/** Extract the description from Task tool input. */
function extractTaskDescription(input: Record<string, unknown>): string {
  // Task tool has 'description' (short) and 'prompt' (detailed)
  return (input.description as string) || 'Subagent task';
}

/** Truncate description for display in header. */
function truncateDescription(description: string, maxLength = 40): string {
  if (description.length <= maxLength) return description;
  return description.substring(0, maxLength) + '...';
}

/** Truncate result to max 2 lines. */
function truncateResult(result: string): string {
  const lines = result.split(/\r?\n/).filter(line => line.trim());
  if (lines.length <= 2) {
    return lines.join('\n');
  }
  return lines.slice(0, 2).join('\n') + '...';
}


/** Create a subagent block for a Task tool call (streaming). Collapsed by default. */
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
    isExpanded: false, // Collapsed by default
  };

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  wrapperEl.dataset.subagentId = taskToolId;

  // Header (clickable to collapse/expand)
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', `Subagent task: ${truncateDescription(description)} - click to expand`);

  // Robot icon (decorative)
  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'bot');

  // Label (description only)
  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  // Tool count badge
  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  countEl.setText('0 tool uses');

  // Status indicator (icon updated on completion/error; empty while running)
  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  contentEl.style.display = 'none';

  // Toggle collapse handler
  const toggleExpand = () => {
    info.isExpanded = !info.isExpanded;
    if (info.isExpanded) {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    } else {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    countEl,
    statusEl,
    info,
    currentToolEl: null,
    currentResultEl: null,
  };
}

/** Add a tool call to a subagent's content area. Only shows current tool. */
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

/** Update a nested tool call with its result. */
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

/** Finalize a subagent when its Task tool_result is received. */
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

/** Render a stored subagent from conversation history. Collapsed by default. */
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

  // Tool count
  const toolCount = subagent.toolCalls.length;

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  headerEl.setAttribute('aria-label', `Subagent task: ${truncateDescription(subagent.description)} - ${toolCount} tool uses - Status: ${subagent.status}`);

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'bot');

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(subagent.description));

  // Tool count badge
  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  countEl.setText(`${toolCount} tool uses`);

  // Status indicator
  const statusEl = headerEl.createDiv({ cls: `claudian-subagent-status status-${subagent.status}` });
  statusEl.setAttribute('aria-label', `Status: ${subagent.status}`);
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

  // Toggle collapse handler
  const toggleExpand = () => {
    const expanded = wrapperEl.hasClass('expanded');
    if (expanded) {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    }
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return wrapperEl;
}

/** State for an async subagent block. */
export interface AsyncSubagentState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  statusTextEl: HTMLElement;  // Running / Completed / Error / Orphaned
  statusEl: HTMLElement;
  info: SubagentInfo;
}

function setAsyncWrapperStatus(wrapperEl: HTMLElement, status: string): void {
  const classes = ['pending', 'running', 'awaiting', 'completed', 'error', 'orphaned', 'async'];
  classes.forEach(cls => wrapperEl.removeClass(cls));
  wrapperEl.addClass('async');
  wrapperEl.addClass(status);
}

/** Normalize async status for display. */
function getAsyncDisplayStatus(asyncStatus: string | undefined): 'running' | 'completed' | 'error' | 'orphaned' {
  if (asyncStatus === 'completed') return 'completed';
  if (asyncStatus === 'error') return 'error';
  if (asyncStatus === 'orphaned') return 'orphaned';
  return 'running';
}

function getAsyncStatusText(asyncStatus: string | undefined): string {
  const display = getAsyncDisplayStatus(asyncStatus);
  if (display === 'completed') return 'Completed';
  if (display === 'error') return 'Error';
  if (display === 'orphaned') return 'Orphaned';
  return 'Running';
}

function updateAsyncLabel(state: AsyncSubagentState, _displayStatus: 'running' | 'completed' | 'error' | 'orphaned'): void {
  // Always show label (description) for immediate visibility
  state.labelEl.setText(truncateDescription(state.info.description));
}

/** Create an async subagent block for a background Task tool call. */
export function createAsyncSubagentBlock(
  parentEl: HTMLElement,
  taskToolId: string,
  taskInput: Record<string, unknown>
): AsyncSubagentState {
  const description = (taskInput.description as string) || 'Background task';

  const info: SubagentInfo = {
    id: taskToolId,
    description,
    mode: 'async',
    status: 'running',
    toolCalls: [],
    isExpanded: false, // Collapsed by default for async
    asyncStatus: 'pending',
  };

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  setAsyncWrapperStatus(wrapperEl, 'pending');
  wrapperEl.dataset.asyncSubagentId = taskToolId;

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', `Background task: ${description} - Status: running`);

  // Robot icon (decorative)
  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'bot');

  // Label (description) - show immediately for visibility
  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  // Status text (instead of tool count)
  const statusTextEl = headerEl.createDiv({ cls: 'claudian-subagent-status-text' });
  statusTextEl.setText('Running');

  // Status indicator (spinner initially)
  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  contentEl.style.display = 'none';

  // Initial content
  const statusRow = contentEl.createDiv({ cls: 'claudian-subagent-done' });
  const branchEl = statusRow.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = statusRow.createDiv({ cls: 'claudian-subagent-done-text' });
  textEl.setText('run in background');

  // Toggle collapse handler
  const toggleExpand = () => {
    info.isExpanded = !info.isExpanded;
    if (info.isExpanded) {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    } else {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    statusTextEl,
    statusEl,
    info,
  };
}

/** Update async subagent to running state (agent_id received). */
export function updateAsyncSubagentRunning(
  state: AsyncSubagentState,
  agentId: string
): void {
  state.info.asyncStatus = 'running';
  state.info.agentId = agentId;

  setAsyncWrapperStatus(state.wrapperEl, 'running');
  updateAsyncLabel(state, 'running');

  // Update status text
  state.statusTextEl.setText('Running');

  // Update content
  state.contentEl.empty();
  const statusRow = state.contentEl.createDiv({ cls: 'claudian-subagent-done' });
  const branchEl = statusRow.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = statusRow.createDiv({ cls: 'claudian-subagent-done-text claudian-async-agent-id' });
  const shortId = agentId.length > 12 ? agentId.substring(0, 12) + '...' : agentId;
  textEl.setText(`run in background (${shortId})`);
}

/** Finalize async subagent with AgentOutputTool result. */
export function finalizeAsyncSubagent(
  state: AsyncSubagentState,
  result: string,
  isError: boolean
): void {
  state.info.asyncStatus = isError ? 'error' : 'completed';
  state.info.status = isError ? 'error' : 'completed';
  state.info.result = result;

  setAsyncWrapperStatus(state.wrapperEl, isError ? 'error' : 'completed');
  updateAsyncLabel(state, isError ? 'error' : 'completed');

  // Update status text
  state.statusTextEl.setText(isError ? 'Error' : 'Completed');

  // Update status indicator
  state.statusEl.className = 'claudian-subagent-status';
  state.statusEl.addClass(`status-${isError ? 'error' : 'completed'}`);
  state.statusEl.empty();
  if (isError) {
    setIcon(state.statusEl, 'x');
  } else {
    setIcon(state.statusEl, 'check');
  }

  // Update wrapper class
  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }

  // Show result in content
  state.contentEl.empty();
  const resultEl = state.contentEl.createDiv({ cls: 'claudian-subagent-done' });
  const branchEl = resultEl.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = resultEl.createDiv({ cls: 'claudian-subagent-done-text' });

  if (isError && result) {
    // Show truncated error message for debugging
    const truncated = result.length > 80 ? result.substring(0, 80) + '...' : result;
    textEl.setText(`ERROR: ${truncated}`);
  } else {
    textEl.setText(isError ? 'ERROR' : 'DONE');
  }
}

/** Mark async subagent as orphaned (conversation ended before completion). */
export function markAsyncSubagentOrphaned(state: AsyncSubagentState): void {
  state.info.asyncStatus = 'orphaned';
  state.info.status = 'error';
  state.info.result = 'Conversation ended before task completed';

  setAsyncWrapperStatus(state.wrapperEl, 'orphaned');
  updateAsyncLabel(state, 'orphaned');

  // Update status text
  state.statusTextEl.setText('Orphaned');

  // Update status indicator
  state.statusEl.className = 'claudian-subagent-status status-error';
  state.statusEl.empty();
  setIcon(state.statusEl, 'alert-circle');

  // Update wrapper class
  state.wrapperEl.addClass('error');
  state.wrapperEl.addClass('orphaned');

  // Show orphaned message
  state.contentEl.empty();
  const orphanEl = state.contentEl.createDiv({ cls: 'claudian-subagent-done claudian-async-orphaned' });
  const branchEl = orphanEl.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = orphanEl.createDiv({ cls: 'claudian-subagent-done-text' });
  textEl.setText('⚠️ Task orphaned');
}

/** Render a stored async subagent from conversation history. Collapsed by default. */
export function renderStoredAsyncSubagent(
  parentEl: HTMLElement,
  subagent: SubagentInfo
): HTMLElement {
  const isExpanded = false; // Always collapsed for stored

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  const statusClass = getAsyncDisplayStatus(subagent.asyncStatus);
  setAsyncWrapperStatus(wrapperEl, statusClass);

  if (subagent.asyncStatus === 'completed') {
    wrapperEl.addClass('done');
  } else if (subagent.asyncStatus === 'error' || subagent.asyncStatus === 'orphaned') {
    wrapperEl.addClass('error');
  }
  wrapperEl.dataset.asyncSubagentId = subagent.id;

  // Status info
  const displayStatus = getAsyncDisplayStatus(subagent.asyncStatus);
  const statusText = getAsyncStatusText(subagent.asyncStatus);

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  headerEl.setAttribute('aria-label', `Background task: ${subagent.description} - Status: ${statusText}`);

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, 'bot');

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  // Always show description for visibility
  labelEl.setText(truncateDescription(subagent.description));

  // Status text
  const statusTextEl = headerEl.createDiv({ cls: 'claudian-subagent-status-text' });
  statusTextEl.setText(statusText);

  // Status indicator
  const statusIconClass = (displayStatus === 'error' || displayStatus === 'orphaned')
    ? 'status-error'
    : (displayStatus === 'completed' ? 'status-completed' : 'status-running');
  const statusEl = headerEl.createDiv({ cls: `claudian-subagent-status ${statusIconClass}` });
  statusEl.setAttribute('aria-label', `Status: ${statusText}`);

  if (subagent.asyncStatus === 'completed') {
    setIcon(statusEl, 'check');
  } else if (subagent.asyncStatus === 'error' || subagent.asyncStatus === 'orphaned') {
    setIcon(statusEl, subagent.asyncStatus === 'orphaned' ? 'alert-circle' : 'x');
  }

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  if (!isExpanded) {
    contentEl.style.display = 'none';
  }

  // Show status-appropriate content
  const statusRow = contentEl.createDiv({ cls: 'claudian-subagent-done' });
  const branchEl = statusRow.createDiv({ cls: 'claudian-subagent-branch' });
  branchEl.setText('└─');
  const textEl = statusRow.createDiv({ cls: 'claudian-subagent-done-text' });

  if (subagent.asyncStatus === 'completed') {
    textEl.setText('DONE');
  } else if (subagent.asyncStatus === 'error') {
    textEl.setText('ERROR');
  } else if (subagent.asyncStatus === 'orphaned') {
    textEl.setText('⚠️ Task orphaned');
  } else if (subagent.agentId) {
    const shortId = subagent.agentId.length > 12
      ? subagent.agentId.substring(0, 12) + '...'
      : subagent.agentId;
    textEl.setText(`run in background (${shortId})`);
  } else {
    textEl.setText('run in background');
  }

  // Toggle collapse handler
  const toggleExpand = () => {
    const expanded = wrapperEl.hasClass('expanded');
    if (expanded) {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    }
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return wrapperEl;
}
