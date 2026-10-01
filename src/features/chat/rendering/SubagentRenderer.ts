import { setIcon } from 'obsidian';

import { getToolIcon } from '../../../core/tools/toolIcons';
import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import type { SubagentInfo, SubagentProgress, ToolCallInfo } from '../../../core/types';
import { formatDurationMmSs } from '../../../utils/date';
import { setupCollapsible } from './collapsible';
import {
  getToolLabel,
  getToolName,
  getToolSummary,
  renderExpandedContent,
  setToolIcon,
} from './ToolCallRenderer';

interface SubagentToolView {
  renderedToolCall?: Readonly<ToolCallInfo>;
  wrapperEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  statusEl: HTMLElement;
  contentEl: HTMLElement;
}

interface SubagentSection {
  wrapperEl: HTMLElement;
  bodyEl: HTMLElement;
}

export interface SubagentState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  statusEl: HTMLElement;
  promptSectionEl: HTMLElement;
  promptBodyEl: HTMLElement;
  toolsContainerEl: HTMLElement;
  resultSectionEl: HTMLElement | null;
  resultBodyEl: HTMLElement | null;
  toolElements: Map<string, SubagentToolView>;
  info: Readonly<SubagentInfo>;
  progressEl: HTMLElement | null;
  progress: SubagentProgress | null;
}

const SUBAGENT_TOOL_STATUS_ICONS: Partial<Record<ToolCallInfo['status'], string>> = {
  completed: 'check',
  error: 'x',
  blocked: 'shield-off',
};

function truncateDescription(description: string, maxLength = 40): string {
  if (description.length <= maxLength) return description;
  return description.substring(0, maxLength) + '...';
}

function createSection(parentEl: HTMLElement, title: string, bodyClass?: string): SubagentSection {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-section' });

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-section-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  const titleEl = headerEl.createDiv({ cls: 'claudian-subagent-section-title' });
  titleEl.setText(title);

  const bodyEl = wrapperEl.createDiv({ cls: 'claudian-subagent-section-body' });
  if (bodyClass) bodyEl.addClass(bodyClass);

  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, headerEl, bodyEl, state, {
    baseAriaLabel: title,
  });

  return { wrapperEl, bodyEl };
}

function setPromptText(promptBodyEl: HTMLElement, prompt: string): void {
  promptBodyEl.empty();
  const textEl = promptBodyEl.createDiv({ cls: 'claudian-subagent-prompt-text' });
  textEl.setText(prompt);
}

function updateSyncHeaderAria(state: SubagentState): void {
  state.headerEl.setAttribute(
    'aria-label',
    `Subagent task: ${state.info.description} - Status: ${state.info.status} - click to expand`
  );
  state.statusEl.setAttribute('aria-label', `Status: ${state.info.status}`);
}

function renderSubagentToolContent(contentEl: HTMLElement, toolCall: ToolCallInfo): void {
  contentEl.empty();

  if (!toolCall.result && toolCall.status === 'running') {
    const emptyEl = contentEl.createDiv({ cls: 'claudian-subagent-tool-empty' });
    emptyEl.setText('Running...');
    return;
  }

  renderExpandedContent(contentEl, toolCall);
}

function setSubagentToolStatus(view: SubagentToolView, status: ToolCallInfo['status']): void {
  view.statusEl.className = 'claudian-subagent-tool-status';
  view.statusEl.addClass(`status-${status}`);
  view.statusEl.empty();
  view.statusEl.setAttribute('aria-label', `Status: ${status}`);

  const statusIcon = SUBAGENT_TOOL_STATUS_ICONS[status];
  if (statusIcon) {
    setIcon(view.statusEl, statusIcon);
  }
}

function updateSubagentToolView(view: SubagentToolView, toolCall: ToolCallInfo): void {
  if (view.renderedToolCall === toolCall) return;
  view.renderedToolCall = toolCall;
  view.wrapperEl.className = `claudian-subagent-tool-item claudian-subagent-tool-${toolCall.status}`;
  view.nameEl.setText(getToolName(toolCall.name, toolCall.input));
  view.summaryEl.setText(getToolSummary(toolCall.name, toolCall.input));
  setSubagentToolStatus(view, toolCall.status);
  renderSubagentToolContent(view.contentEl, toolCall);
}

function createSubagentToolView(parentEl: HTMLElement, toolCall: ToolCallInfo): SubagentToolView {
  const wrapperEl = parentEl.createDiv({
    cls: `claudian-subagent-tool-item claudian-subagent-tool-${toolCall.status}`,
  });
  wrapperEl.dataset.toolId = toolCall.id;

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-tool-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  const nameEl = headerEl.createDiv({ cls: 'claudian-subagent-tool-name' });
  const summaryEl = headerEl.createDiv({ cls: 'claudian-subagent-tool-summary' });
  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-tool-status' });

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-tool-content' });

  const collapseState = { isExpanded: toolCall.isExpanded ?? false };
  setupCollapsible(wrapperEl, headerEl, contentEl, collapseState, {
    initiallyExpanded: toolCall.isExpanded ?? false,
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input),
  });

  const view: SubagentToolView = {
    wrapperEl,
    nameEl,
    summaryEl,
    statusEl,
    contentEl,
  };
  updateSubagentToolView(view, toolCall);

  return view;
}

type SubagentProgressView = Pick<SubagentState, 'wrapperEl' | 'headerEl' | 'progressEl' | 'progress'>;

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  const thousands = tokens / 1000;
  const value = thousands >= 100 ? String(Math.round(thousands)) : thousands.toFixed(1).replace(/\.0$/, '');
  return `${value}k tokens`;
}

function formatProgressMeta(progress: SubagentProgress): string {
  const parts: string[] = [];
  if (progress.toolUses !== undefined) {
    parts.push(`${progress.toolUses} ${progress.toolUses === 1 ? 'tool use' : 'tool uses'}`);
  }
  if (progress.totalTokens) parts.push(formatTokenCount(progress.totalTokens));
  if (progress.durationMs) parts.push(formatDurationMmSs(Math.round(progress.durationMs / 1000)));
  return parts.join(' · ');
}

/**
 * Shows a running subagent's latest activity under its header. Fields missing
 * from an update keep their previous values, so a summary stays visible
 * between the provider's periodic summary refreshes.
 */
export function updateSubagentProgress(state: SubagentProgressView, update: SubagentProgress): void {
  const progress: SubagentProgress = { ...state.progress, ...update };
  state.progress = progress;

  const activity = progress.summary
    ?? (progress.lastToolName ? `Last tool: ${progress.lastToolName}` : '');
  const meta = formatProgressMeta(progress);
  if (!activity && !meta) return;

  if (!state.progressEl) {
    state.progressEl = state.wrapperEl.createDiv({ cls: 'claudian-subagent-progress' });
    state.headerEl.after(state.progressEl);
  }
  state.progressEl.empty();
  if (activity) {
    state.progressEl.createDiv({ cls: 'claudian-subagent-progress-summary', text: activity });
  }
  if (meta) {
    state.progressEl.createDiv({ cls: 'claudian-subagent-progress-meta', text: meta });
  }
}

function clearSubagentProgress(state: SubagentProgressView): void {
  state.progressEl?.remove();
  state.progressEl = null;
  state.progress = null;
}

function ensureResultSection(state: SubagentState): SubagentSection {
  if (state.resultSectionEl && state.resultBodyEl) {
    return { wrapperEl: state.resultSectionEl, bodyEl: state.resultBodyEl };
  }

  const section = createSection(state.contentEl, 'Result', 'claudian-subagent-result-body');
  section.wrapperEl.addClass('claudian-subagent-section-result');
  // Earlier runs stay below the current run's result.
  const history = state.contentEl.querySelector(':scope > .claudian-subagent-history');
  if (history) state.contentEl.insertBefore(section.wrapperEl, history);
  state.resultSectionEl = section.wrapperEl;
  state.resultBodyEl = section.bodyEl;
  return section;
}

function setResultText(state: SubagentState, text: string): void {
  const section = ensureResultSection(state);
  if (section.bodyEl.textContent === text) return;
  section.bodyEl.empty();
  const resultEl = section.bodyEl.createDiv({ cls: 'claudian-subagent-result-output' });
  resultEl.setText(text);
}

function createSubagentView(
  parentEl: HTMLElement,
  info: Readonly<SubagentInfo>,
): SubagentState {
  const { id: taskToolId, description, prompt = '' } = info;

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  wrapperEl.dataset.subagentId = taskToolId;

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(TOOL_SUBAGENT));

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });

  const promptSection = createSection(contentEl, 'Prompt', 'claudian-subagent-prompt-body');
  promptSection.wrapperEl.addClass('claudian-subagent-section-prompt');
  setPromptText(promptSection.bodyEl, prompt);

  const toolsContainerEl = contentEl.createDiv({ cls: 'claudian-subagent-tools' });

  setupCollapsible(wrapperEl, headerEl, contentEl, { isExpanded: false });

  const state: SubagentState = {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    statusEl,
    promptSectionEl: promptSection.wrapperEl,
    promptBodyEl: promptSection.bodyEl,
    toolsContainerEl,
    resultSectionEl: null,
    resultBodyEl: null,
    toolElements: new Map<string, SubagentToolView>(),
    info,
    progressEl: null,
    progress: null,
  };

  return state;
}

export function createSubagentBlock(parentEl: HTMLElement, info: Readonly<SubagentInfo>): SubagentState {
  const state = createSubagentView(parentEl, info);
  updateSubagentBlock(state, info);
  return state;
}

function updateSubagentContent(state: SubagentState, info: Readonly<SubagentInfo>, result?: string): void {
  state.promptSectionEl.hidden = !info.prompt?.trim();
  if (state.promptBodyEl.textContent !== (info.prompt || '')) {
    setPromptText(state.promptBodyEl, info.prompt || '');
  }
  for (const toolCall of info.toolCalls) {
    const view = state.toolElements.get(toolCall.id);
    if (view) updateSubagentToolView(view, toolCall);
    else state.toolElements.set(toolCall.id, createSubagentToolView(state.toolsContainerEl, toolCall));
  }
  for (const [id, view] of state.toolElements) {
    if (!info.toolCalls.some(tool => tool.id === id)) {
      view.wrapperEl.remove();
      state.toolElements.delete(id);
    }
  }
  if (result !== undefined) {
    setResultText(state, result);
  } else {
    state.resultSectionEl?.remove();
    state.resultSectionEl = null;
    state.resultBodyEl = null;
  }
}

/** Applies a model snapshot without changing its lifecycle, result, or child tools. */
export function updateSubagentBlock(state: SubagentState, info: Readonly<SubagentInfo>): void {
  state.info = info;
  state.labelEl.setText(truncateDescription(info.description));
  state.headerEl.title = info.description;
  updateSubagentContent(state, info, info.status === 'running' ? undefined
    : info.result?.trim() ? info.result : (info.status === 'error' ? 'ERROR' : 'DONE'));
  state.statusEl.className = `claudian-subagent-status status-${info.status}`;
  state.statusEl.empty();
  state.wrapperEl.removeClass('done', 'error');
  if (info.status !== 'running') {
    setIcon(state.statusEl, info.status === 'error' ? 'x' : 'check');
    state.wrapperEl.addClass(info.status === 'error' ? 'error' : 'done');
    clearSubagentProgress(state);
  }
  updateSyncHeaderAria(state);
}

export function renderStoredSubagent(
  parentEl: HTMLElement,
  subagent: Readonly<SubagentInfo>
): HTMLElement {
  return createSubagentBlock(parentEl, subagent).wrapperEl;
}

export interface AsyncSubagentState extends SubagentState {
  statusTextEl: HTMLElement;  // Running / Completed / Error / Orphaned
}

function setAsyncWrapperStatus(wrapperEl: HTMLElement, status: string): void {
  const classes = ['pending', 'running', 'awaiting', 'completed', 'error', 'orphaned', 'async'];
  classes.forEach(cls => wrapperEl.removeClass(cls));
  wrapperEl.addClass('async');
  wrapperEl.addClass(status);
}

function getAsyncDisplayStatus(asyncStatus: string | undefined): 'running' | 'completed' | 'error' | 'orphaned' {
  switch (asyncStatus) {
    case 'completed': return 'completed';
    case 'error': return 'error';
    case 'orphaned': return 'orphaned';
    default: return 'running';
  }
}

function getAsyncStatusText(asyncStatus: string | undefined): string {
  switch (asyncStatus) {
    case 'pending': return 'Initializing';
    case 'completed': return ''; // Just show tick icon, no text
    case 'error': return 'Error';
    case 'orphaned': return 'Orphaned';
    default: return 'Running in background';
  }
}

function getAsyncStatusAriaLabel(asyncStatus: string | undefined): string {
  switch (asyncStatus) {
    case 'pending': return 'Initializing';
    case 'completed': return 'Completed';
    case 'error': return 'Error';
    case 'orphaned': return 'Orphaned';
    default: return 'Running in background';
  }
}

function updateAsyncLabel(state: AsyncSubagentState): void {
  state.labelEl.setText(truncateDescription(state.info.description));
  state.headerEl.title = state.info.description;

  const statusLabel = getAsyncStatusAriaLabel(state.info.asyncStatus);
  state.headerEl.setAttribute(
    'aria-label',
    `Background task: ${state.info.description} - ${statusLabel} - click to expand`
  );
}

/** Create a background card with the same incremental content view as foreground tasks. */
export function createAsyncSubagentBlock(
  parentEl: HTMLElement,
  info: Readonly<SubagentInfo>,
): AsyncSubagentState {
  const view = createSubagentView(parentEl, info);
  delete view.wrapperEl.dataset.subagentId;
  view.wrapperEl.dataset.asyncSubagentId = info.id;
  const statusTextEl = view.headerEl.createDiv({ cls: 'claudian-subagent-status-text' });
  view.headerEl.insertBefore(statusTextEl, view.statusEl);
  const state: AsyncSubagentState = { ...view, statusTextEl };
  updateAsyncSubagentBlock(state, info);
  return state;
}

/** Live updates and history use the same passive card rendering. */
export function updateAsyncSubagentBlock(state: AsyncSubagentState, info: Readonly<SubagentInfo>): void {
  state.info = info;
  const displayStatus = getAsyncDisplayStatus(info.asyncStatus);
  setAsyncWrapperStatus(state.wrapperEl, info.asyncStatus ?? 'running');
  state.wrapperEl.removeClass('done', 'error');
  updateAsyncLabel(state);
  state.statusTextEl.setText(getAsyncStatusText(info.asyncStatus));
  const status = displayStatus === 'orphaned' ? 'error' : displayStatus;
  state.statusEl.className = `claudian-subagent-status status-${status}`;
  state.statusEl.setAttribute('aria-label', `Status: ${getAsyncStatusAriaLabel(info.asyncStatus)}`);
  state.statusEl.empty();
  if (displayStatus !== 'running') {
    setIcon(state.statusEl, displayStatus === 'orphaned' ? 'alert-circle' : displayStatus === 'error' ? 'x' : 'check');
    state.wrapperEl.addClass(displayStatus === 'completed' ? 'done' : 'error');
    clearSubagentProgress(state);
  }
  updateSubagentContent(state, info, displayStatus === 'running' ? undefined
    : displayStatus === 'orphaned' ? (info.result || 'Conversation ended before task completed')
      : info.result?.trim() ? info.result : (displayStatus === 'error' ? 'ERROR' : 'DONE'));
}

export function renderStoredAsyncSubagent(parentEl: HTMLElement, subagent: Readonly<SubagentInfo>): HTMLElement {
  return createAsyncSubagentBlock(parentEl, subagent).wrapperEl;
}
