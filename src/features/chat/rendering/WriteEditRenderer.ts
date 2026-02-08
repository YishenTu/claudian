import { setIcon } from 'obsidian';

import { getToolIcon } from '../../../core/tools';
import type { ToolCallInfo, ToolDiffData } from '../../../core/types';
import type { DiffLine, DiffStats } from '../../../core/types/diff';
import { setupCollapsible } from './collapsible';
import { renderDiffContent } from './DiffRenderer';
import { fileNameOnly } from './ToolCallRenderer';

export interface WriteEditState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  statsEl: HTMLElement;
  statusEl: HTMLElement;
  toolCall: ToolCallInfo;
  isExpanded: boolean;
  diffLines?: DiffLine[];
}

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

function renderDiffStats(statsEl: HTMLElement, stats: DiffStats): void {
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

export function createWriteEditBlock(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): WriteEditState {
  const filePath = (toolCall.input.file_path as string) || 'file';
  const toolName = toolCall.name; // 'Write' or 'Edit'

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-write-edit-block' });
  wrapperEl.dataset.toolId = toolCall.id;

  // Header (clickable to collapse/expand)
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-label', `${toolName}: ${shortenPath(filePath)} - click to expand`);

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(toolName));

  const nameEl = headerEl.createDiv({ cls: 'claudian-write-edit-name' });
  nameEl.setText(toolName);
  const summaryEl = headerEl.createDiv({ cls: 'claudian-write-edit-summary' });
  summaryEl.setText(fileNameOnly(filePath) || 'file');

  // Populated when diff is computed
  const statsEl = headerEl.createDiv({ cls: 'claudian-write-edit-stats' });

  const statusEl = headerEl.createDiv({ cls: 'claudian-write-edit-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  // Content area (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-content' });

  // Initial loading state
  const loadingRow = contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
  const loadingEl = loadingRow.createDiv({ cls: 'claudian-write-edit-loading' });
  loadingEl.setText('Writing...');

  // Create state object
  const state: WriteEditState = {
    wrapperEl,
    contentEl,
    headerEl,
    nameEl,
    summaryEl,
    statsEl,
    statusEl,
    toolCall,
    isExpanded: false,
  };

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  setupCollapsible(wrapperEl, headerEl, contentEl, state);

  return state;
}

export function updateWriteEditWithDiff(state: WriteEditState, diffData: ToolDiffData): void {
  state.statsEl.empty();
  state.contentEl.empty();

  const { diffLines, stats } = diffData;
  state.diffLines = diffLines;

  // Update stats
  renderDiffStats(state.statsEl, stats);

  // Render diff content
  const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
  const diffEl = row.createDiv({ cls: 'claudian-write-edit-diff' });
  renderDiffContent(diffEl, diffLines);
}

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
  } else if (!state.diffLines) {
    // Success but no diff data - clear the "Writing..." loading text and show DONE
    state.contentEl.empty();
    const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const doneEl = row.createDiv({ cls: 'claudian-write-edit-done-text' });
    doneEl.setText('DONE');
  }

  // Update wrapper class
  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }
}

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

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'claudian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(toolName));

  const nameEl = headerEl.createDiv({ cls: 'claudian-write-edit-name' });
  nameEl.setText(toolName);
  const summaryEl = headerEl.createDiv({ cls: 'claudian-write-edit-summary' });
  summaryEl.setText(fileNameOnly(filePath) || 'file');

  const statsEl = headerEl.createDiv({ cls: 'claudian-write-edit-stats' });
  if (toolCall.diffData) {
    renderDiffStats(statsEl, toolCall.diffData.stats);
  }

  // Status indicator - only show icon on error
  const statusEl = headerEl.createDiv({ cls: 'claudian-write-edit-status' });
  if (isError) {
    statusEl.addClass('status-error');
    setIcon(statusEl, 'x');
  }

  // Content
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-content' });

  // Render diff if available
  const row = contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });

  if (toolCall.diffData && toolCall.diffData.diffLines.length > 0) {
    const diffEl = row.createDiv({ cls: 'claudian-write-edit-diff' });
    renderDiffContent(diffEl, toolCall.diffData.diffLines);
  } else if (isError && toolCall.result) {
    const errorEl = row.createDiv({ cls: 'claudian-write-edit-error' });
    errorEl.setText(toolCall.result);
  } else {
    const doneEl = row.createDiv({ cls: 'claudian-write-edit-done-text' });
    doneEl.setText(isError ? 'ERROR' : 'DONE');
  }

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, headerEl, contentEl, state);

  return wrapperEl;
}
