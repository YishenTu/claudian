import { setIcon } from 'obsidian';

import { getToolIcon, TOOL_TASK } from '../../../core/tools';
import type { SubagentInfo, ToolCallInfo } from '../../../core/types';
import { setupCollapsible } from './collapsible';
import {
  getToolLabel,
  getToolName,
  getToolSummary,
  renderExpandedContent,
  setToolIcon,
} from './ToolCallRenderer';

interface SubagentToolView {
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
  countEl: HTMLElement;
  statusEl: HTMLElement;
  promptSectionEl: HTMLElement;
  promptBodyEl: HTMLElement;
  toolsContainerEl: HTMLElement;
  resultSectionEl: HTMLElement | null;
  resultBodyEl: HTMLElement | null;
  toolElements: Map<string, SubagentToolView>;
  info: SubagentInfo;
}

const SUBAGENT_TOOL_STATUS_ICONS: Partial<Record<ToolCallInfo['status'], string>> = {
  completed: 'check',
  error: 'x',
  blocked: 'shield-off',
};

function extractTaskDescription(input: Record<string, unknown>): string {
  return (input.description as string) || 'Subagent task';
}

function extractTaskPrompt(input: Record<string, unknown>): string {
  return (input.prompt as string) || '';
}

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
  textEl.setText(prompt || 'No prompt provided');
}

function updateSyncHeaderAria(state: SubagentState): void {
  const toolCount = state.info.toolCalls.length;
  state.headerEl.setAttribute(
    'aria-label',
    `Subagent task: ${truncateDescription(state.info.description)} - ${toolCount} tool uses - Status: ${state.info.status} - click to expand`
  );
  state.statusEl.setAttribute('aria-label', `Status: ${state.info.status}`);
}

function renderSubagentToolContent(contentEl: HTMLElement, toolCall: ToolCallInfo): void {
  contentEl.empty();

  if (!toolCall.result) {
    const emptyEl = contentEl.createDiv({ cls: 'claudian-subagent-tool-empty' });
    emptyEl.setText(toolCall.status === 'running' ? 'Running...' : 'No output recorded');
    return;
  }

  renderExpandedContent(contentEl, toolCall.name, toolCall.result);
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
    onToggle: (expanded) => {
      toolCall.isExpanded = expanded;
    },
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

function ensureResultSection(state: SubagentState): SubagentSection {
  if (state.resultSectionEl && state.resultBodyEl) {
    return { wrapperEl: state.resultSectionEl, bodyEl: state.resultBodyEl };
  }

  const section = createSection(state.contentEl, 'Result', 'claudian-subagent-result-body');
  section.wrapperEl.addClass('claudian-subagent-section-result');
  state.resultSectionEl = section.wrapperEl;
  state.resultBodyEl = section.bodyEl;
  return section;
}

function setResultText(state: SubagentState, text: string): void {
  const section = ensureResultSection(state);
  section.bodyEl.empty();
  const resultEl = section.bodyEl.createDiv({ cls: 'claudian-subagent-result-output' });
  resultEl.setText(text);
}

function hydrateSyncSubagentStateFromStored(state: SubagentState, subagent: SubagentInfo): void {
  state.info.description = subagent.description;
  state.info.prompt = subagent.prompt;
  state.info.mode = subagent.mode;
  state.info.status = subagent.status;
  state.info.result = subagent.result;

  state.labelEl.setText(truncateDescription(subagent.description));
  setPromptText(state.promptBodyEl, subagent.prompt || '');

  for (const originalToolCall of subagent.toolCalls) {
    const toolCall: ToolCallInfo = {
      ...originalToolCall,
      input: { ...originalToolCall.input },
    };
    addSubagentToolCall(state, toolCall);
    if (toolCall.status !== 'running' || toolCall.result) {
      updateSubagentToolResult(state, toolCall.id, toolCall);
    }
  }

  if (subagent.status === 'completed' || subagent.status === 'error') {
    const fallback = subagent.status === 'error' ? 'ERROR' : 'DONE';
    finalizeSubagentBlock(state, subagent.result || fallback, subagent.status === 'error');
  } else {
    state.statusEl.className = 'claudian-subagent-status status-running';
    state.statusEl.empty();
    updateSyncHeaderAria(state);
  }
}

export function createSubagentBlock(
  parentEl: HTMLElement,
  taskToolId: string,
  taskInput: Record<string, unknown>
): SubagentState {
  const description = extractTaskDescription(taskInput);
  const prompt = extractTaskPrompt(taskInput);

  const info: SubagentInfo = {
    id: taskToolId,
    description,
    prompt,
    status: 'running',
    toolCalls: [],
    isExpanded: false,
  };

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  wrapperEl.dataset.subagentId = taskToolId;

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(TOOL_TASK));

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  countEl.setText('0 tool uses');

  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });

  const promptSection = createSection(contentEl, 'Prompt', 'claudian-subagent-prompt-body');
  promptSection.wrapperEl.addClass('claudian-subagent-section-prompt');
  setPromptText(promptSection.bodyEl, prompt);

  const toolsContainerEl = contentEl.createDiv({ cls: 'claudian-subagent-tools' });

  setupCollapsible(wrapperEl, headerEl, contentEl, info);

  const state: SubagentState = {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    countEl,
    statusEl,
    promptSectionEl: promptSection.wrapperEl,
    promptBodyEl: promptSection.bodyEl,
    toolsContainerEl,
    resultSectionEl: null,
    resultBodyEl: null,
    toolElements: new Map<string, SubagentToolView>(),
    info,
  };

  updateSyncHeaderAria(state);
  return state;
}

export function addSubagentToolCall(
  state: SubagentState,
  toolCall: ToolCallInfo
): void {
  state.info.toolCalls.push(toolCall);

  const toolCount = state.info.toolCalls.length;
  state.countEl.setText(`${toolCount} tool uses`);

  const toolView = createSubagentToolView(state.toolsContainerEl, toolCall);
  state.toolElements.set(toolCall.id, toolView);

  updateSyncHeaderAria(state);
}

export function updateSubagentToolResult(
  state: SubagentState,
  toolId: string,
  toolCall: ToolCallInfo
): void {
  const idx = state.info.toolCalls.findIndex(tc => tc.id === toolId);
  if (idx !== -1) {
    state.info.toolCalls[idx] = toolCall;
  }

  const toolView = state.toolElements.get(toolId);
  if (!toolView) {
    return;
  }

  updateSubagentToolView(toolView, toolCall);
}

export function finalizeSubagentBlock(
  state: SubagentState,
  result: string,
  isError: boolean
): void {
  state.info.status = isError ? 'error' : 'completed';
  state.info.result = result;

  state.labelEl.setText(truncateDescription(state.info.description));
  state.countEl.setText(`${state.info.toolCalls.length} tool uses`);

  state.statusEl.className = 'claudian-subagent-status';
  state.statusEl.addClass(`status-${state.info.status}`);
  state.statusEl.empty();
  if (state.info.status === 'completed') {
    setIcon(state.statusEl, 'check');
    state.wrapperEl.removeClass('error');
    state.wrapperEl.addClass('done');
  } else {
    setIcon(state.statusEl, 'x');
    state.wrapperEl.removeClass('done');
    state.wrapperEl.addClass('error');
  }

  const finalText = result?.trim() ? result : (isError ? 'ERROR' : 'DONE');
  setResultText(state, finalText);

  updateSyncHeaderAria(state);
}

export function renderStoredSubagent(
  parentEl: HTMLElement,
  subagent: SubagentInfo
): HTMLElement {
  const state = createSubagentBlock(parentEl, subagent.id, {
    description: subagent.description,
    prompt: subagent.prompt,
  });

  hydrateSyncSubagentStateFromStored(state, subagent);
  return state.wrapperEl;
}

export interface AsyncSubagentState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  countEl: HTMLElement;
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

  const isFinished = state.info.asyncStatus === 'completed' || state.info.asyncStatus === 'error' || state.info.asyncStatus === 'orphaned';
  const countText = isFinished ? `${state.info.toolCalls.length} tool uses` : '';
  state.countEl.setText(countText);

  const statusLabel = getAsyncStatusAriaLabel(state.info.asyncStatus);
  const ariaCount = isFinished ? `${state.info.toolCalls.length} tool uses - ` : '';
  state.headerEl.setAttribute(
    'aria-label',
    `Background task: ${truncateDescription(state.info.description)} - ${ariaCount}${statusLabel} - click to expand`
  );
}

function renderAsyncContentLikeSync(
  contentEl: HTMLElement,
  subagent: SubagentInfo,
  displayStatus: 'running' | 'completed' | 'error' | 'orphaned'
): void {
  contentEl.empty();

  const promptSection = createSection(contentEl, 'Prompt', 'claudian-subagent-prompt-body');
  promptSection.wrapperEl.addClass('claudian-subagent-section-prompt');
  setPromptText(promptSection.bodyEl, subagent.prompt || '');

  const toolsContainerEl = contentEl.createDiv({ cls: 'claudian-subagent-tools' });
  for (const originalToolCall of subagent.toolCalls) {
    const toolCall: ToolCallInfo = {
      ...originalToolCall,
      input: { ...originalToolCall.input },
    };
    createSubagentToolView(toolsContainerEl, toolCall);
  }

  if (displayStatus === 'running') {
    return;
  }

  const resultSection = createSection(contentEl, 'Result', 'claudian-subagent-result-body');
  resultSection.wrapperEl.addClass('claudian-subagent-section-result');
  const resultEl = resultSection.bodyEl.createDiv({ cls: 'claudian-subagent-result-output' });

  if (displayStatus === 'orphaned') {
    resultEl.setText(subagent.result || 'Conversation ended before task completed');
    return;
  }

  const fallback = displayStatus === 'error' ? 'ERROR' : 'DONE';
  const finalText = subagent.result?.trim() ? subagent.result : fallback;
  resultEl.setText(finalText);
}

/**
 * Create an async subagent block for a background Task tool call.
 * Expandable to show the task prompt. Collapsed by default.
 */
export function createAsyncSubagentBlock(
  parentEl: HTMLElement,
  taskToolId: string,
  taskInput: Record<string, unknown>
): AsyncSubagentState {
  const description = (taskInput.description as string) || 'Background task';
  const prompt = (taskInput.prompt as string) || '';

  const info: SubagentInfo = {
    id: taskToolId,
    description,
    prompt,
    mode: 'async',
    status: 'running',
    toolCalls: [],
    isExpanded: false,
    asyncStatus: 'pending',
  };

  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  setAsyncWrapperStatus(wrapperEl, 'pending');
  wrapperEl.dataset.asyncSubagentId = taskToolId;

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', `Background task: ${description} - Initializing - click to expand`);

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(TOOL_TASK));

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(description));

  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });

  const statusTextEl = headerEl.createDiv({ cls: 'claudian-subagent-status-text' });
  statusTextEl.setText('Initializing');

  const statusEl = headerEl.createDiv({ cls: 'claudian-subagent-status status-running' });
  statusEl.setAttribute('aria-label', 'Status: running');

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  renderAsyncContentLikeSync(contentEl, info, 'running');

  setupCollapsible(wrapperEl, headerEl, contentEl, info);

  return {
    wrapperEl,
    contentEl,
    headerEl,
    labelEl,
    countEl,
    statusTextEl,
    statusEl,
    info,
  };
}

export function updateAsyncSubagentRunning(
  state: AsyncSubagentState,
  agentId: string
): void {
  state.info.asyncStatus = 'running';
  state.info.agentId = agentId;

  setAsyncWrapperStatus(state.wrapperEl, 'running');
  updateAsyncLabel(state);

  state.statusTextEl.setText('Running in background');

  renderAsyncContentLikeSync(state.contentEl, state.info, 'running');
}

export function finalizeAsyncSubagent(
  state: AsyncSubagentState,
  result: string,
  isError: boolean
): void {
  state.info.asyncStatus = isError ? 'error' : 'completed';
  state.info.status = isError ? 'error' : 'completed';
  state.info.result = result;

  setAsyncWrapperStatus(state.wrapperEl, isError ? 'error' : 'completed');
  updateAsyncLabel(state);

  state.statusTextEl.setText(isError ? 'Error' : '');

  state.statusEl.className = 'claudian-subagent-status';
  state.statusEl.addClass(`status-${isError ? 'error' : 'completed'}`);
  state.statusEl.empty();
  if (isError) {
    setIcon(state.statusEl, 'x');
  } else {
    setIcon(state.statusEl, 'check');
  }

  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }

  renderAsyncContentLikeSync(state.contentEl, state.info, isError ? 'error' : 'completed');
}

export function markAsyncSubagentOrphaned(state: AsyncSubagentState): void {
  state.info.asyncStatus = 'orphaned';
  state.info.status = 'error';
  state.info.result = 'Conversation ended before task completed';

  setAsyncWrapperStatus(state.wrapperEl, 'orphaned');
  updateAsyncLabel(state);

  state.statusTextEl.setText('Orphaned');

  state.statusEl.className = 'claudian-subagent-status status-error';
  state.statusEl.empty();
  setIcon(state.statusEl, 'alert-circle');

  state.wrapperEl.addClass('error');
  state.wrapperEl.addClass('orphaned');

  renderAsyncContentLikeSync(state.contentEl, state.info, 'orphaned');
}

/**
 * Render a stored async subagent from conversation history.
 * Expandable to show the task prompt. Collapsed by default.
 */
export function renderStoredAsyncSubagent(
  parentEl: HTMLElement,
  subagent: SubagentInfo
): HTMLElement {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-subagent-list' });
  const displayStatus = getAsyncDisplayStatus(subagent.asyncStatus);
  setAsyncWrapperStatus(wrapperEl, displayStatus);

  if (displayStatus === 'completed') {
    wrapperEl.addClass('done');
  } else if (displayStatus === 'error' || displayStatus === 'orphaned') {
    wrapperEl.addClass('error');
  }
  wrapperEl.dataset.asyncSubagentId = subagent.id;

  const statusText = getAsyncStatusText(subagent.asyncStatus);
  const statusAriaLabel = getAsyncStatusAriaLabel(subagent.asyncStatus);

  const headerEl = wrapperEl.createDiv({ cls: 'claudian-subagent-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  const isFinished = displayStatus === 'completed' || displayStatus === 'error' || displayStatus === 'orphaned';
  const ariaCount = isFinished ? `${subagent.toolCalls.length} tool uses - ` : '';
  headerEl.setAttribute(
    'aria-label',
    `Background task: ${subagent.description} - ${ariaCount}${statusAriaLabel} - click to expand`
  );

  const iconEl = headerEl.createDiv({ cls: 'claudian-subagent-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(TOOL_TASK));

  const labelEl = headerEl.createDiv({ cls: 'claudian-subagent-label' });
  labelEl.setText(truncateDescription(subagent.description));

  const countEl = headerEl.createDiv({ cls: 'claudian-subagent-count' });
  if (isFinished) {
    countEl.setText(`${subagent.toolCalls.length} tool uses`);
  }

  const statusTextEl = headerEl.createDiv({ cls: 'claudian-subagent-status-text' });
  statusTextEl.setText(statusText);

  let statusIconClass: string;
  switch (displayStatus) {
    case 'error':
    case 'orphaned':
      statusIconClass = 'status-error';
      break;
    case 'completed':
      statusIconClass = 'status-completed';
      break;
    default:
      statusIconClass = 'status-running';
  }
  const statusEl = headerEl.createDiv({ cls: `claudian-subagent-status ${statusIconClass}` });
  statusEl.setAttribute('aria-label', `Status: ${statusAriaLabel}`);

  switch (displayStatus) {
    case 'completed':
      setIcon(statusEl, 'check');
      break;
    case 'error':
      setIcon(statusEl, 'x');
      break;
    case 'orphaned':
      setIcon(statusEl, 'alert-circle');
      break;
  }

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-subagent-content' });
  renderAsyncContentLikeSync(contentEl, subagent, displayStatus);

  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, headerEl, contentEl, state);

  return wrapperEl;
}
