/**
 * WriteEditRenderer - Subagent-style renderer for Write/Edit tool calls
 *
 * Displays file modifications with inline diff view:
 * - Header: "Write: filename.md +15 -20" with collapse/expand
 * - Content: Diff view with hunks and "..." separators
 * - Expanded by default during streaming, collapsed for stored
 */

import { setIcon } from 'obsidian';

import { TOOL_EDIT } from '../../core/tools/toolNames';
import type { ToolCallInfo, ToolDiffData } from '../../core/types';
import type {
  DiffLine} from './DiffRenderer';
import {
  computeLineDiff,
  countLineChanges,
  isBinaryContent,
  renderDiffContent,
} from './DiffRenderer';

/** State for a streaming Write/Edit block. */
export interface WriteEditState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  statsEl: HTMLElement;
  statusEl: HTMLElement;
  toolCall: ToolCallInfo;
  isExpanded: boolean;
  diffLines?: DiffLine[];
}

/** Shorten file path for display. */
function shortenPath(filePath: string, maxLength = 40): string {
  if (!filePath) return 'file';
  // Normalize path separators for cross-platform support
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.length <= maxLength) return normalized;

  const parts = normalized.split('/');
  if (parts.length <= 2) {
    return '...' + normalized.slice(-maxLength + 3);
  }

  // Show first dir + ... + filename
  const filename = parts[parts.length - 1];
  const firstDir = parts[0];
  const available = maxLength - firstDir.length - filename.length - 5; // 5 for ".../.../"

  if (available < 0) {
    return '...' + filename.slice(-maxLength + 3);
  }

  return `${firstDir}/.../${filename}`;
}

/** Create a Write/Edit block during streaming (collapsed by default). */
export function createWriteEditBlock(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): WriteEditState {
  const filePath = (toolCall.input.file_path as string) || 'file';
  const toolName = toolCall.name; // 'Write' or 'Edit'
  const isExpanded = false;

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-write-edit-block' });
  wrapperEl.dataset.toolId = toolCall.id;

  // Header (clickable to collapse/expand)
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', `${toolName}: ${shortenPath(filePath)} - click to expand`);

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, toolName === TOOL_EDIT ? 'file-pen' : 'file-plus');

  // Label: "Write: filename.md" or "Edit: filename.md"
  const labelEl = headerEl.createDiv({ cls: 'claudian-write-edit-label' });
  labelEl.setText(`${toolName}: ${shortenPath(filePath)}`);

  // Stats (will be updated when diff is ready): "+15 -20"
  const statsEl = headerEl.createDiv({ cls: 'claudian-write-edit-stats' });
  // Empty initially, populated when diff is computed

  // Status indicator (spinner while running)
  const statusEl = headerEl.createDiv({ cls: 'claudian-write-edit-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');
  statusEl.createSpan({ cls: 'claudian-spinner' });

  // Content area (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-content' });
  contentEl.style.display = 'none';

  // Initial loading state
  const loadingRow = contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
  const loadingEl = loadingRow.createDiv({ cls: 'claudian-write-edit-loading' });
  loadingEl.setText('Writing...');

  // Toggle collapse handler
  const state: WriteEditState = {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    statsEl,
    statusEl,
    toolCall,
    isExpanded,
  };

  const toggleExpand = () => {
    state.isExpanded = !state.isExpanded;
    if (state.isExpanded) {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    } else {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    }
  };

  headerEl.addEventListener('click', toggleExpand);
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return state;
}

/** Update Write/Edit block with diff data. */
export function updateWriteEditWithDiff(state: WriteEditState, diffData: ToolDiffData): void {
  state.statsEl.empty();
  state.contentEl.empty();

  // Handle skipped reasons or missing content
  if (diffData.skippedReason === 'too_large') {
    const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const skipEl = row.createDiv({ cls: 'claudian-write-edit-binary' });
    skipEl.setText('Diff skipped: file too large');
    return;
  }

  if (
    diffData.skippedReason === 'unavailable' ||
    diffData.originalContent === undefined ||
    diffData.newContent === undefined
  ) {
    const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const skipEl = row.createDiv({ cls: 'claudian-write-edit-binary' });
    skipEl.setText('Diff unavailable');
    return;
  }

  const { originalContent, newContent } = diffData;

  // Check for binary content
  if (isBinaryContent(originalContent) || isBinaryContent(newContent)) {
    const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const binaryEl = row.createDiv({ cls: 'claudian-write-edit-binary' });
    binaryEl.setText('Binary file');
    return;
  }

  // Compute diff
  const diffLines = computeLineDiff(originalContent, newContent);
  state.diffLines = diffLines;

  // Update stats
  const stats = countLineChanges(diffLines);
  if (stats.added > 0) {
    const addedEl = state.statsEl.createSpan({ cls: 'added' });
    addedEl.setText(`+${stats.added}`);
  }
  if (stats.removed > 0) {
    if (stats.added > 0) {
      state.statsEl.createSpan({ text: ' ' });
    }
    const removedEl = state.statsEl.createSpan({ cls: 'removed' });
    removedEl.setText(`-${stats.removed}`);
  }

  // Render diff content
  const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
  const diffEl = row.createDiv({ cls: 'claudian-write-edit-diff' });
  renderDiffContent(diffEl, diffLines);
}

/** Finalize Write/Edit block (update status icon). */
export function finalizeWriteEditBlock(state: WriteEditState, isError: boolean): void {
  // Update status icon - only show icon on error
  state.statusEl.className = 'claudian-write-edit-status';
  state.statusEl.empty();

  if (isError) {
    state.statusEl.addClass('status-error');
    setIcon(state.statusEl, 'x');
    state.statusEl.setAttribute('aria-label', 'Status: error');

    // Show error in content if no diff was shown
    if (!state.diffLines) {
      state.contentEl.empty();
      const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
      const errorEl = row.createDiv({ cls: 'claudian-write-edit-error' });
      errorEl.setText(state.toolCall.result || 'Error');
    }
  }

  // Update wrapper class
  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }
}

/** Render a stored Write/Edit block from conversation history. Collapsed by default. */
export function renderStoredWriteEdit(parentEl: HTMLElement, toolCall: ToolCallInfo): HTMLElement {
  const filePath = (toolCall.input.file_path as string) || 'file';
  const toolName = toolCall.name;
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-write-edit-block' });
  if (isError) {
    wrapperEl.addClass('error');
  } else if (toolCall.status === 'completed') {
    wrapperEl.addClass('done');
  }
  wrapperEl.dataset.toolId = toolCall.id;

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, toolName === TOOL_EDIT ? 'file-pen' : 'file-plus');

  // Label
  const labelEl = headerEl.createDiv({ cls: 'claudian-write-edit-label' });
  labelEl.setText(`${toolName}: ${shortenPath(filePath)}`);

  // Stats (compute from stored diffData if available)
  const statsEl = headerEl.createDiv({ cls: 'claudian-write-edit-stats' });
  if (
    toolCall.diffData &&
    !toolCall.diffData.skippedReason &&
    toolCall.diffData.originalContent !== undefined &&
    toolCall.diffData.newContent !== undefined
  ) {
    const diffLines = computeLineDiff(toolCall.diffData.originalContent, toolCall.diffData.newContent);
    const stats = countLineChanges(diffLines);
    if (stats.added > 0) {
      const addedEl = statsEl.createSpan({ cls: 'added' });
      addedEl.setText(`+${stats.added}`);
    }
    if (stats.removed > 0) {
      if (stats.added > 0) {
        statsEl.createSpan({ text: ' ' });
      }
      const removedEl = statsEl.createSpan({ cls: 'removed' });
      removedEl.setText(`-${stats.removed}`);
    }
  }

  // Status indicator - only show icon on error
  const statusEl = headerEl.createDiv({ cls: 'claudian-write-edit-status' });
  if (isError) {
    statusEl.addClass('status-error');
    setIcon(statusEl, 'x');
  }

  // Content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-content' });
  contentEl.style.display = 'none';

  // Render diff if available
  const row = contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });

  if (toolCall.diffData) {
    if (toolCall.diffData.skippedReason === 'too_large') {
      const skipEl = row.createDiv({ cls: 'claudian-write-edit-binary' });
      skipEl.setText('Diff skipped: file too large');
    } else if (
      toolCall.diffData.skippedReason === 'unavailable' ||
      toolCall.diffData.originalContent === undefined ||
      toolCall.diffData.newContent === undefined
    ) {
      const skipEl = row.createDiv({ cls: 'claudian-write-edit-binary' });
      skipEl.setText('Diff unavailable');
    } else {
      const diffEl = row.createDiv({ cls: 'claudian-write-edit-diff' });
      const diffLines = computeLineDiff(toolCall.diffData.originalContent, toolCall.diffData.newContent);
      renderDiffContent(diffEl, diffLines);
    }
  } else if (isError && toolCall.result) {
    const errorEl = row.createDiv({ cls: 'claudian-write-edit-error' });
    errorEl.setText(toolCall.result);
  } else {
    const doneEl = row.createDiv({ cls: 'claudian-write-edit-done-text' });
    doneEl.setText(isError ? 'ERROR' : 'DONE');
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

  headerEl.addEventListener('click', toggleExpand);
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return wrapperEl;
}
