import { setIcon } from 'obsidian';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { ToolCallInfo, ToolDiffData } from '@/core/types';
import type { DiffLine } from '@/core/types/diff';
import { setupCollapsible } from '@/features/chat/rendering/collapsible';
import { renderDiffContent, renderDiffStats } from '@/features/chat/rendering/tools/DiffRenderer';
import { fileNameOnly } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { getToolLabel } from '@/features/chat/rendering/tools/toolPresentation';

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
  diffDirty?: boolean;
}

export interface WriteEditRenderOptions {
  initiallyExpanded?: boolean;
}

interface WriteEditElements {
  wrapperEl: HTMLElement;
  headerEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  statsEl: HTMLElement;
  statusEl: HTMLElement;
  contentEl: HTMLElement;
  baseAriaLabel: string;
}

function createWriteEditElements(parentEl: HTMLElement, toolCall: ToolCallInfo): WriteEditElements {
  const filePath = (toolCall.input.file_path as string) || 'file';
  const toolName = toolCall.name; // 'Write' or 'Edit'

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-write-edit-block' });
  wrapperEl.dataset.toolId = toolCall.id;

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-header' });
  const iconEl = headerEl.createDiv({ cls: 'claudian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(toolName));

  const nameEl = headerEl.createDiv({ cls: 'claudian-write-edit-name' });
  nameEl.setText(toolName);
  const summaryEl = headerEl.createDiv({ cls: 'claudian-write-edit-summary' });
  summaryEl.setText(fileNameOnly(filePath) || 'file');

  const statsEl = headerEl.createDiv({ cls: 'claudian-write-edit-stats' });
  const statusEl = headerEl.createDiv({ cls: 'claudian-write-edit-status' });
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-write-edit-content' });

  return {
    wrapperEl,
    headerEl,
    nameEl,
    summaryEl,
    statsEl,
    statusEl,
    contentEl,
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input),
  };
}

export function createWriteEditBlock(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: WriteEditRenderOptions = {}
): WriteEditState {
  const {
    wrapperEl, headerEl, nameEl, summaryEl, statsEl, statusEl, contentEl, baseAriaLabel,
  } = createWriteEditElements(parentEl, toolCall);

  statusEl.addClass('status-running');
  statusEl.setAttribute('aria-label', 'Status: running');

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
  setupCollapsible(wrapperEl, headerEl, contentEl, state, {
    initiallyExpanded: options.initiallyExpanded ?? false,
    baseAriaLabel,
    onToggle: expanded => { if (expanded) renderCurrentDiff(state); },
  });

  return state;
}

export function updateWriteEditWithDiff(state: WriteEditState, diffData: ToolDiffData): void {
  state.statsEl.empty();
  const { diffLines, stats } = diffData;
  state.diffLines = diffLines;

  // Update stats
  renderDiffStats(state.statsEl, stats);

  state.diffDirty = true;
  if (state.isExpanded) renderCurrentDiff(state);
}

function renderCurrentDiff(state: WriteEditState): void {
  if (!state.diffDirty || !state.diffLines) return;
  state.contentEl.empty();
  const row = state.contentEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
  const diffEl = row.createDiv({ cls: 'claudian-write-edit-diff' });
  renderDiffContent(diffEl, state.diffLines);
  state.diffDirty = false;
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

export function renderStoredWriteEdit(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: WriteEditRenderOptions = {}
): HTMLElement {
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';
  const { wrapperEl, headerEl, statsEl, statusEl, contentEl, baseAriaLabel } = createWriteEditElements(parentEl, toolCall);
  if (isError) {
    wrapperEl.addClass('error');
  } else if (toolCall.status === 'completed') {
    wrapperEl.addClass('done');
  }

  if (toolCall.diffData) {
    renderDiffStats(statsEl, toolCall.diffData.stats);
  }

  // Status indicator - only show icon on error
  if (isError) {
    statusEl.addClass('status-error');
    setIcon(statusEl, 'x');
  }

  const renderContent = () => {
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
  };
  const eager = toolCall.status === 'running';
  if (eager) renderContent();

  setupCollapsible(wrapperEl, headerEl, contentEl, { isExpanded: false }, {
    initiallyExpanded: options.initiallyExpanded ?? false,
    onFirstExpand: eager ? undefined : renderContent,
    baseAriaLabel,
  });

  return wrapperEl;
}
