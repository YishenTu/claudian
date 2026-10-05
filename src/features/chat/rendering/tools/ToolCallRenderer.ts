import { TOOL_BASH } from '@/core/tools/toolNames';
import type { ToolCallInfo } from '@/core/types';
import { setupCollapsible } from '@/features/chat/rendering/collapsible';
import { setToolIcon } from '@/features/chat/rendering/tools/toolContentPrimitives';
import {
  getToolLabel,
  getToolName,
  getToolPresentation,
  getToolSummary,
  renderToolCardContent,
} from '@/features/chat/rendering/tools/toolPresentation';
import { setToolStatus } from '@/features/chat/rendering/tools/toolStatus';

export interface ToolCallRenderOptions {
  initiallyExpanded?: boolean;
}

interface ToolCardOptions {
  /** Live placeholder shown until the first result update; also marks the card as live. */
  initialText?: string;
  initiallyExpanded?: boolean;
  /** Render the body before first expansion (cards with a card body always do). */
  eagerWhen?: boolean;
}

type ToolCardUpdate = (tool: ToolCallInfo) => void;

const toolCardUpdates = new WeakMap<HTMLElement, ToolCardUpdate>();

function setCardStatus(statusEl: HTMLElement, tool: ToolCallInfo, pending: boolean): void {
  const setStatus = getToolPresentation(tool.name).status;
  if (setStatus) setStatus(statusEl, tool, pending);
  else setToolStatus(statusEl, tool.status, 'claudian-tool-status');
}

/** One collapsible tool card for live and stored tools; later results replace its tool snapshot. */
function createToolCard(parentEl: HTMLElement, tool: ToolCallInfo, options: ToolCardOptions): HTMLElement {
  const presentation = getToolPresentation(tool.name);
  const live = options.initialText !== undefined;
  const initiallyExpanded = options.initiallyExpanded ?? false;
  const eager = presentation.cardBody !== undefined;

  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });
  toolEl.dataset.toolId = tool.id;
  if (tool.name === TOOL_BASH) {
    toolEl.addClass('claudian-tool-call-bash');
  }

  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, tool.name);
  const nameEl = header.createSpan({ cls: 'claudian-tool-name' });
  nameEl.setText(getToolName(tool.name, tool.input));
  const summaryEl = header.createSpan({ cls: 'claudian-tool-summary' });
  summaryEl.setText(getToolSummary(tool.name, tool.input));
  const { headerDetail } = presentation;
  const detailEl = headerDetail ? header.createSpan({ cls: 'claudian-tool-current' }) : null;
  const setDetail = (input: Record<string, unknown>) => { if (headerDetail) detailEl?.setText(headerDetail(input)); };
  setDetail(tool.input);
  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });
  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });

  setCardStatus(statusEl, tool, live);

  const state = { isExpanded: initiallyExpanded };
  let currentTool = tool;
  let pendingText = options.initialText;
  let dirty = true;
  const renderContent = () => {
    if (!dirty) return;
    content.empty();
    renderToolCardContent(content, currentTool, pendingText);
    dirty = false;
  };
  if (eager || initiallyExpanded || options.eagerWhen) renderContent();

  toolCardUpdates.set(toolEl, next => {
    currentTool = next;
    pendingText = undefined;
    dirty = true;
    if (live) next.isExpanded = state.isExpanded;
    nameEl.setText(getToolName(next.name, next.input));
    setDetail(next.input);
    setCardStatus(statusEl, next, false);
    if (eager || state.isExpanded) renderContent();
  });

  if (live) tool.isExpanded = initiallyExpanded;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded,
    onToggle: expanded => {
      if (live) currentTool.isExpanded = expanded;
      detailEl?.toggleClass('claudian-hidden', expanded);
      if (detailEl) statusEl.toggleClass('claudian-hidden', expanded);
      if (expanded) renderContent();
    },
    baseAriaLabel: getToolLabel(tool.name, tool.input),
  });

  return toolEl;
}

/** Live tool card: shows "Running..." until its result arrives through `updateToolCallResult`. */
export function renderToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: ToolCallRenderOptions = {}
): HTMLElement {
  const toolEl = createToolCard(parentEl, toolCall, {
    initialText: 'Running...',
    initiallyExpanded: options.initiallyExpanded,
  });
  return toolEl;
}

/** Applies a newer snapshot of the tool to a card rendered by this module. */
export function updateToolCallResult(toolEl: HTMLElement | undefined, toolCall: ToolCallInfo): void {
  if (toolEl) toolCardUpdates.get(toolEl)?.(toolCall);
}

/** For stored (non-streaming) tool calls — collapsed by default. */
export function renderStoredToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: ToolCallRenderOptions = {}
): HTMLElement {
  return createToolCard(parentEl, toolCall, {
    initiallyExpanded: options.initiallyExpanded,
    eagerWhen: toolCall.status === 'running',
  });
}
