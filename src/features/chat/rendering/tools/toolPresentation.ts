import {
  isAgentLifecycleTool,
  isScriptTool,
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
  TOOL_EDIT_IMAGE,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_FOLLOWUP_TASK,
  TOOL_GENERATE_IMAGE,
  TOOL_GENERATE_VIDEO,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_INTERRUPT_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_LS,
  TOOL_READ,
  TOOL_SEND_INPUT,
  TOOL_SEND_MESSAGE,
  TOOL_SKILL,
  TOOL_SPAWN_AGENT,
  TOOL_TODO_WRITE,
  TOOL_TOOL_SEARCH,
  TOOL_WAIT,
  TOOL_WAIT_AGENT,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WORKFLOW,
  TOOL_WRITE,
  TOOL_WRITE_STDIN,
} from '@/core/tools/toolNames';
import type { ToolCallInfo } from '@/core/types';
import { getApplyPatchSummary, renderApplyPatchExpanded, setApplyPatchStatus } from '@/features/chat/rendering/tools/applyPatchContent';
import { renderAskUserQuestionContent } from '@/features/chat/rendering/tools/askUserQuestionContent';
import { getScriptLanguage, getScriptSummary, renderScriptContent } from '@/features/chat/rendering/tools/scriptContent';
import { getCurrentTaskText, getTodoLabel, getTodoName, renderTodoWriteContent, setTodoWriteStatus } from '@/features/chat/rendering/tools/todoContent';
import {
  contentFallback,
  fileNameOnly,
  getInputText,
  renderEmptyResult,
  renderLinesExpanded,
  shortenPath,
  stringifyToolValue,
  truncateText,
} from '@/features/chat/rendering/tools/toolContentPrimitives';
import {
  renderAgentLifecycleExpanded,
  renderBashContent,
  renderFileSearchExpanded,
  renderReadExpanded,
  renderResultImages,
  renderToolSearchExpanded,
  renderWebFetchExpanded,
} from '@/features/chat/rendering/tools/toolExpandedContent';
import { setToolStatus } from '@/features/chat/rendering/tools/toolStatus';
import { getWebSearchLabel, getWebSearchSummary, renderWebSearchExpanded } from '@/features/chat/rendering/tools/webSearchContent';

/** Neutral tool fields the expanded view can present. */
export type ExpandedToolContent = Pick<
  ToolCallInfo,
  'name' | 'result' | 'resultFormat' | 'input' | 'webSearchResults' | 'resultImages' | 'scriptToolCalls'
> & Partial<Pick<ToolCallInfo, 'status'>>;

type ToolInput = Record<string, unknown>;

/** How one tool reads in headers, labels and bodies; every field falls back to a neutral default. */
interface ToolPresentation {
  /** Header name; defaults to the tool name. */
  name?: (input: ToolInput) => string;
  /** Header summary; defaults to none. */
  summary?: (input: ToolInput) => string;
  /** Accessible label; defaults to `name: summary`, or the name alone. */
  label?: (input: ToolInput) => string;
  /** Expanded body; defaults to the first 20 result lines. */
  body?: (container: HTMLElement, tool: ExpandedToolContent) => void;
  /** The body renders its own empty state instead of the "No result" placeholder. */
  handlesMissingResult?: boolean;
  /** The body still renders when the result is image-only. */
  showsBodyWithImages?: boolean;
  /** Tool-card placeholder while a live card awaits its result; defaults to the pending text. */
  pendingBody?: (container: HTMLElement, tool: ToolCallInfo, pendingText: string) => void;
  /** Tool-card body that replaces the expanded body and renders before first expansion. */
  cardBody?: (container: HTMLElement, tool: ToolCallInfo, pending: boolean) => void;
  /** Tool-card header status; defaults to the tool status icon. */
  status?: (statusEl: HTMLElement, tool: ToolCallInfo, pending: boolean) => void;
  /** Tool-card header detail, hidden with the status while expanded. */
  headerDetail?: (input: ToolInput) => string;
}

function inputText(key: string, fallback = ''): (input: ToolInput) => string {
  return input => getInputText(input, key, fallback);
}

function filePresentation(displayName: string): ToolPresentation {
  return {
    summary: input => fileNameOnly(getInputText(input, 'file_path')),
    label: input => `${displayName}: ${shortenPath(getInputText(input, 'file_path')) || 'file'}`,
  };
}

const commandSummary = (input: ToolInput) => truncateText(getInputText(input, 'command'), 60);
const promptSummary = (input: ToolInput) => truncateText(getInputText(input, 'prompt'), 60);

const FILE_SEARCH_BODY = (container: HTMLElement, tool: ExpandedToolContent) => renderFileSearchExpanded(container, tool.result ?? '');

function parseToolSearchQuery(query: string | undefined): string {
  if (!query) return '';
  const selectPrefix = 'select:';
  const body = query.startsWith(selectPrefix) ? query.slice(selectPrefix.length) : query;
  return body.split(',').map(s => s.trim()).filter(Boolean).join(', ');
}

function getWriteStdinSummary(input: ToolInput): string {
  const sessionId = stringifyToolValue(input.session_id ?? input.sessionId);
  const chars = typeof input.chars === 'string' ? input.chars.replace(/\n/g, '\\n') : '';
  if (chars) {
    const preview = chars.length > 24 ? `${chars.slice(0, 24)}...` : chars;
    return sessionId ? `#${sessionId} ${preview}` : preview;
  }
  return sessionId ? `#${sessionId}` : '';
}

function scriptPresentation(displayName: string): ToolPresentation {
  return {
    name: () => displayName,
    summary: getScriptSummary,
    label: input => `${displayName}: ${getScriptSummary(input) || getScriptLanguage(input)}`,
    body: (container, tool) => renderScriptContent(container, tool, (name, input) => ({
      name: getToolName(name, input),
      summary: getToolSummary(name, input),
    })),
    handlesMissingResult: true,
    showsBodyWithImages: true,
    pendingBody: (container, tool) => renderExpandedContent(container, tool),
  };
}

const AGENT_LIFECYCLE: ToolPresentation = {
  body: (container, tool) => renderAgentLifecycleExpanded(container, tool.result ?? '', tool.input),
  handlesMissingResult: true,
  pendingBody: (container, tool, pendingText) =>
    renderAgentLifecycleExpanded(container, tool.result ?? '', tool.input, pendingText),
};

const agentTargetMessageSummary = (input: ToolInput) =>
  truncateText([getInputText(input, 'target'), getInputText(input, 'message')].filter(Boolean).join(': '), 60);

function agentMessageSummary(maxLength: number): (input: ToolInput) => string {
  return input => truncateText(typeof input.message === 'string' ? input.message : '', maxLength);
}

function agentWaitSummary(input: ToolInput): string {
  const ids = Array.isArray(input.ids) ? input.ids.length : 0;
  const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
  const parts: string[] = [];
  if (ids > 0) parts.push(`${ids} agent${ids === 1 ? '' : 's'}`);
  if (timeoutMs !== undefined) parts.push(`${Math.round(timeoutMs / 1000)}s`);
  return parts.join(', ');
}

const SCRIPT = scriptPresentation('Script');
const DEFAULT_PRESENTATION: ToolPresentation = {};

const TOOL_PRESENTATIONS: ReadonlyMap<string, ToolPresentation> = new Map<string, ToolPresentation>([
  [TOOL_READ, {
    ...filePresentation('Read'),
    body: (container, tool) => renderReadExpanded(container, tool.result ?? '', tool.resultFormat),
  }],
  [TOOL_WRITE, filePresentation('Write')],
  [TOOL_EDIT, filePresentation('Edit')],
  [TOOL_BASH, {
    summary: commandSummary,
    label: input => `Bash: ${truncateText(getInputText(input, 'command', 'command'), 40)}`,
    body: (container, tool) => renderBashContent(container, tool.input, tool.result ?? ''),
    handlesMissingResult: true,
    pendingBody: (container, tool, pendingText) =>
      renderBashContent(container, tool.input, tool.result ?? '', pendingText),
  }],
  [TOOL_BASH_OUTPUT, {
    summary: commandSummary,
    body: (container, tool) => {
      if (getInputText(tool.input, 'command')) renderBashContent(container, tool.input, tool.result ?? '');
      else renderLinesExpanded(container, tool.result ?? '', 20);
    },
  }],
  [TOOL_GENERATE_IMAGE, { summary: promptSummary }],
  [TOOL_EDIT_IMAGE, { summary: promptSummary }],
  [TOOL_GENERATE_VIDEO, { summary: promptSummary }],
  [TOOL_GLOB, {
    summary: inputText('pattern'),
    label: input => `Glob: ${getInputText(input, 'pattern', 'files')}`,
    body: FILE_SEARCH_BODY,
  }],
  [TOOL_GREP, {
    summary: inputText('pattern'),
    label: input => `Grep: ${getInputText(input, 'pattern', 'pattern')}`,
    body: FILE_SEARCH_BODY,
  }],
  [TOOL_LS, {
    summary: input => fileNameOnly(getInputText(input, 'path', '.')),
    label: input => `LS: ${shortenPath(getInputText(input, 'path')) || '.'}`,
    body: FILE_SEARCH_BODY,
  }],
  [TOOL_WEB_SEARCH, {
    summary: input => getWebSearchSummary(input, 60),
    label: input => getWebSearchLabel(input, 40),
    body: (container, tool) => renderWebSearchExpanded(container, tool.input, tool.result, tool.webSearchResults),
    handlesMissingResult: true,
  }],
  [TOOL_WEB_FETCH, {
    summary: input => truncateText(getInputText(input, 'url'), 60),
    label: input => `WebFetch: ${truncateText(getInputText(input, 'url', 'url'), 40)}`,
    body: (container, tool) => renderWebFetchExpanded(container, tool.result ?? ''),
  }],
  [TOOL_SKILL, {
    summary: inputText('skill'),
    label: input => `Skill: ${getInputText(input, 'skill', 'skill')}`,
  }],
  [TOOL_TOOL_SEARCH, {
    summary: input => truncateText(parseToolSearchQuery(getInputText(input, 'query')), 60),
    label: input => `ToolSearch: ${parseToolSearchQuery(getInputText(input, 'query')) || 'tools'}`,
    body: (container, tool) => renderToolSearchExpanded(container, tool.result ?? ''),
  }],
  [TOOL_TODO_WRITE, {
    name: getTodoName,
    label: getTodoLabel,
    headerDetail: getCurrentTaskText,
    // A live card shows its run status until the first result settles the task list.
    status: (statusEl, tool, pending) => pending
      ? setToolStatus(statusEl, tool.status, 'claudian-tool-status')
      : setTodoWriteStatus(statusEl, tool.input),
    cardBody: (container, tool) => renderTodoWriteContent(container, tool.input),
  }],
  [TOOL_ASK_USER_QUESTION, {
    cardBody: renderAskUserQuestionContent,
  }],
  [TOOL_ENTER_PLAN_MODE, { name: () => 'Entering plan mode' }],
  [TOOL_EXIT_PLAN_MODE, { name: () => 'Plan complete' }],
  [TOOL_APPLY_PATCH, {
    summary: getApplyPatchSummary,
    body: (container, tool) => renderApplyPatchExpanded(container, tool.input, tool.result),
    handlesMissingResult: true,
    status: setApplyPatchStatus,
  }],
  [TOOL_WRITE_STDIN, { summary: getWriteStdinSummary }],
  [TOOL_WORKFLOW, scriptPresentation('Workflow')],
  [TOOL_SEND_MESSAGE, { ...AGENT_LIFECYCLE, name: () => 'Message agent', summary: agentTargetMessageSummary }],
  [TOOL_FOLLOWUP_TASK, { ...AGENT_LIFECYCLE, name: () => 'Continue agent', summary: agentTargetMessageSummary }],
  [TOOL_LIST_AGENTS, { ...AGENT_LIFECYCLE, name: () => 'List agents', summary: inputText('path_prefix', 'All agents') }],
  [TOOL_INTERRUPT_AGENT, { ...AGENT_LIFECYCLE, name: () => 'Interrupt agent', summary: inputText('target') }],
  [TOOL_SPAWN_AGENT, { ...AGENT_LIFECYCLE, summary: agentMessageSummary(50) }],
  [TOOL_SEND_INPUT, { ...AGENT_LIFECYCLE, summary: agentMessageSummary(40) }],
  [TOOL_WAIT, { ...AGENT_LIFECYCLE, summary: agentWaitSummary }],
  [TOOL_WAIT_AGENT, { ...AGENT_LIFECYCLE, summary: agentWaitSummary }],
]);

/** Exact tool name first, then tool families, then the neutral default. */
export function getToolPresentation(name: string): ToolPresentation {
  const exact = TOOL_PRESENTATIONS.get(name);
  if (exact) return exact;
  if (isScriptTool(name)) return SCRIPT;
  if (isAgentLifecycleTool(name)) return AGENT_LIFECYCLE;
  return DEFAULT_PRESENTATION;
}

export function getToolName(name: string, input: ToolInput): string {
  return getToolPresentation(name).name?.(input) ?? name;
}

export function getToolSummary(name: string, input: ToolInput): string {
  return getToolPresentation(name).summary?.(input) ?? '';
}

/** Combined name+summary for ARIA labels (collapsible regions need a single descriptive phrase). */
export function getToolLabel(name: string, input: ToolInput): string {
  const label = getToolPresentation(name).label;
  if (label) return label(input);
  const displayName = getToolName(name, input);
  const summary = getToolSummary(name, input);
  return summary ? `${displayName}: ${summary}` : displayName;
}

export function renderExpandedContent(
  container: HTMLElement,
  toolCall: ExpandedToolContent,
): void {
  const presentation = getToolPresentation(toolCall.name);
  const images = toolCall.resultImages ?? [];
  // An image-only result needs no empty-state placeholder above its preview.
  if (toolCall.result || images.length === 0 || presentation.showsBodyWithImages) {
    if (!toolCall.result && !presentation.handlesMissingResult) {
      renderEmptyResult(container);
    } else if (presentation.body) {
      presentation.body(container, toolCall);
    } else {
      renderLinesExpanded(container, toolCall.result ?? '', 20);
    }
  }
  if (images.length > 0) renderResultImages(container, images);
}

/** Tool-card body; a pending card shows `pendingText` until its first result arrives. */
export function renderToolCardContent(container: HTMLElement, tool: ToolCallInfo, pendingText?: string): void {
  const presentation = getToolPresentation(tool.name);
  if (presentation.cardBody) {
    presentation.cardBody(container, tool, pendingText !== undefined);
  } else if (pendingText === undefined) {
    renderExpandedContent(container, tool);
  } else if (presentation.pendingBody) {
    presentation.pendingBody(container, tool, pendingText);
  } else {
    contentFallback(container, pendingText);
  }
}
