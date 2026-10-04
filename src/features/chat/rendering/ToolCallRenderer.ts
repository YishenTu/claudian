import { Platform, setIcon } from 'obsidian';

import { parseApplyPatchDiffs, parseFileUpdateChangeDiffs } from '@/core/tools/toolDiff';
import { stringifyUnknown } from '@/utils/stringify';

import type { TodoItem } from '../../../core/tools/todo';
import { getToolIcon, MCP_ICON_MARKER } from '../../../core/tools/toolIcons';
import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
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
  TOOL_GENERATE_IMAGE,
  TOOL_GENERATE_VIDEO,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
  TOOL_SKILL,
  TOOL_TODO_WRITE,
  TOOL_TOOL_SEARCH,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WORKFLOW,
  TOOL_WRITE,
  TOOL_WRITE_STDIN,
} from '../../../core/tools/toolNames';
import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  ScriptToolCallItem,
  ToolCallInfo,
  ToolResultImage,
  WebSearchResultItem,
} from '../../../core/types';
import type { DiffStats } from '../../../core/types/diff';
import { appendMCPIcon } from '../../../shared/icons';
import { setupCollapsible } from './collapsible';
import { renderDiffContent, renderDiffStats } from './DiffRenderer';
import { renderTodoItems } from './todoUtils';

export function setToolIcon(el: HTMLElement, name: string): void {
  const icon = getToolIcon(name);
  if (icon === MCP_ICON_MARKER) {
    appendMCPIcon(el);
  } else {
    setIcon(el, icon);
  }
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getInputText(input: Record<string, unknown>, key: string, fallback = ''): string {
  return stringifyToolValue(input[key]) || fallback;
}

export function getToolName(name: string, input: Record<string, unknown>): string {
  if (isScriptTool(name)) return name === TOOL_WORKFLOW ? 'Workflow' : 'Script';
  switch (name) {
    case TOOL_TODO_WRITE: {
      const todos = input.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos) && todos.length > 0) {
        const completed = todos.filter(t => t.status === 'completed').length;
        return `Tasks ${completed}/${todos.length}`;
      }
      return 'Tasks';
    }
    case 'send_message':
      return 'Message agent';
    case 'followup_task':
      return 'Continue agent';
    case 'list_agents':
      return 'List agents';
    case 'interrupt_agent':
      return 'Interrupt agent';
    case TOOL_ENTER_PLAN_MODE:
      return 'Entering plan mode';
    case TOOL_EXIT_PLAN_MODE:
      return 'Plan complete';
    default:
      return name;
  }
}

export function getToolSummary(name: string, input: Record<string, unknown>): string {
  if (isScriptTool(name)) return getScriptSummary(input);
  switch (name) {
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT: {
      const filePath = getInputText(input, 'file_path');
      return fileNameOnly(filePath);
    }
    case TOOL_BASH:
    case TOOL_BASH_OUTPUT: {
      const cmd = getInputText(input, 'command');
      return truncateText(cmd, 60);
    }
    case TOOL_GENERATE_IMAGE:
    case TOOL_EDIT_IMAGE:
    case TOOL_GENERATE_VIDEO:
      return truncateText(getInputText(input, 'prompt'), 60);
    case TOOL_GLOB:
    case TOOL_GREP:
      return getInputText(input, 'pattern');
    case TOOL_WEB_SEARCH:
      return getWebSearchSummary(input, 60);
    case TOOL_WEB_FETCH:
      return truncateText(getInputText(input, 'url'), 60);
    case TOOL_LS:
      return fileNameOnly(getInputText(input, 'path', '.'));
    case TOOL_SKILL:
      return getInputText(input, 'skill');
    case TOOL_TOOL_SEARCH:
      return truncateText(parseToolSearchQuery(getInputText(input, 'query')), 60);
    case TOOL_TODO_WRITE:
      return '';
    case TOOL_APPLY_PATCH:
      return getApplyPatchSummary(input);
    case TOOL_WRITE_STDIN:
      return getWriteStdinSummary(input);
    default:
      if (isAgentLifecycleTool(name)) {
        return getAgentLifecycleSummary(name, input);
      }
      return '';
  }
}

/** Combined name+summary for ARIA labels (collapsible regions need a single descriptive phrase). */
export function getToolLabel(name: string, input: Record<string, unknown>): string {
  if (isScriptTool(name)) return `${getToolName(name, input)}: ${getScriptSummary(input) || getScriptLanguage(input)}`;
  switch (name) {
    case TOOL_READ:
      return `Read: ${shortenPath(getInputText(input, 'file_path')) || 'file'}`;
    case TOOL_WRITE:
      return `Write: ${shortenPath(getInputText(input, 'file_path')) || 'file'}`;
    case TOOL_EDIT:
      return `Edit: ${shortenPath(getInputText(input, 'file_path')) || 'file'}`;
    case TOOL_BASH: {
      const cmd = getInputText(input, 'command', 'command');
      return `Bash: ${cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd}`;
    }
    case TOOL_GLOB:
      return `Glob: ${getInputText(input, 'pattern', 'files')}`;
    case TOOL_GREP:
      return `Grep: ${getInputText(input, 'pattern', 'pattern')}`;
    case TOOL_WEB_SEARCH: {
      return getWebSearchLabel(input, 40);
    }
    case TOOL_WEB_FETCH: {
      const url = getInputText(input, 'url', 'url');
      return `WebFetch: ${url.length > 40 ? url.substring(0, 40) + '...' : url}`;
    }
    case TOOL_LS:
      return `LS: ${shortenPath(getInputText(input, 'path')) || '.'}`;
    case TOOL_TODO_WRITE: {
      const todos = input.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos)) {
        const completed = todos.filter(t => t.status === 'completed').length;
        return `Tasks (${completed}/${todos.length})`;
      }
      return 'Tasks';
    }
    case TOOL_SKILL: {
      const skillName = getInputText(input, 'skill', 'skill');
      return `Skill: ${skillName}`;
    }
    case TOOL_TOOL_SEARCH: {
      const tools = parseToolSearchQuery(getInputText(input, 'query'));
      return `ToolSearch: ${tools || 'tools'}`;
    }
    case TOOL_ENTER_PLAN_MODE:
      return 'Entering plan mode';
    case TOOL_EXIT_PLAN_MODE:
      return 'Plan complete';
    case TOOL_BASH_OUTPUT:
    case TOOL_GENERATE_IMAGE:
    case TOOL_EDIT_IMAGE:
    case TOOL_GENERATE_VIDEO: {
      const summary = getToolSummary(name, input);
      return summary ? `${name}: ${summary}` : name;
    }
    case TOOL_APPLY_PATCH: {
      const summary = getApplyPatchSummary(input);
      return summary ? `apply_patch: ${summary}` : 'apply_patch';
    }
    case TOOL_WRITE_STDIN: {
      const summary = getWriteStdinSummary(input);
      return summary ? `write_stdin: ${summary}` : 'write_stdin';
    }
    default:
      if (isAgentLifecycleTool(name)) {
        const summary = getAgentLifecycleSummary(name, input);
        return summary ? `${getToolName(name, input)}: ${summary}` : getToolName(name, input);
      }
      return name;
  }
}

export function fileNameOnly(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

function getScriptSource(input: Record<string, unknown>): string {
  return [input.code, input.raw, input.value].find((value): value is string => (
    typeof value === 'string' && value.trim().length > 0
  )) ?? '';
}

function getScriptLanguage(input: Record<string, unknown>): string {
  return getInputText(input, 'language').trim() || 'JavaScript';
}

function getScriptSummary(input: Record<string, unknown>): string {
  const title = getInputText(input, 'title').trim();
  if (title) return truncateText(title, 60);
  const firstLine = getScriptSource(input).split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('//'));
  return truncateText(firstLine ?? '', 60);
}

function getApplyPatchSummary(input: Record<string, unknown>): string {
  // Extract file paths from patch text markers
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const patchFiles = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map(m => m[1]?.trim() ?? '');

  // Also check changes array
  const changes = input.changes;
  const changeFiles = Array.isArray(changes)
    ? (changes as Array<{ path?: string }>)
        .map(c => c.path)
        .filter((p): p is string => !!p)
    : [];

  const files = [...new Set([...patchFiles, ...changeFiles])];
  if (files.length === 0) return patchText ? 'patch' : '';
  if (files.length === 1) return fileNameOnly(files[0]);
  return `${files.length} files`;
}

function getWriteStdinSummary(input: Record<string, unknown>): string {
  const sessionId = stringifyToolValue(input.session_id ?? input.sessionId);
  const chars = typeof input.chars === 'string' ? input.chars.replace(/\n/g, '\\n') : '';
  if (chars) {
    const preview = chars.length > 24 ? `${chars.slice(0, 24)}...` : chars;
    return sessionId ? `#${sessionId} ${preview}` : preview;
  }
  return sessionId ? `#${sessionId}` : '';
}

function getAgentLifecycleSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'send_message':
    case 'followup_task':
      return truncateText([getInputText(input, 'target'), getInputText(input, 'message')].filter(Boolean).join(': '), 60);
    case 'list_agents':
      return getInputText(input, 'path_prefix', 'All agents');
    case 'interrupt_agent':
      return getInputText(input, 'target');
    case 'spawn_agent': {
      const msg = typeof input.message === 'string' ? input.message : '';
      return msg.length > 50 ? `${msg.slice(0, 50)}...` : msg;
    }
    case 'send_input': {
      const msg = typeof input.message === 'string' ? input.message : '';
      return msg.length > 40 ? `${msg.slice(0, 40)}...` : msg;
    }
    case 'wait_agent':
    case 'wait': {
      const ids = Array.isArray(input.ids) ? input.ids.length : 0;
      const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
      const parts: string[] = [];
      if (ids > 0) parts.push(`${ids} agent${ids === 1 ? '' : 's'}`);
      if (timeoutMs !== undefined) parts.push(`${Math.round(timeoutMs / 1000)}s`);
      return parts.join(', ');
    }
    case 'resume_agent':
    case 'close_agent':
      return '';
    default:
      return '';
  }
}

function shortenPath(filePath: string | undefined): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return '.../' + parts.slice(-2).join('/');
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function parseToolSearchQuery(query: string | undefined): string {
  if (!query) return '';
  const selectPrefix = 'select:';
  const body = query.startsWith(selectPrefix) ? query.slice(selectPrefix.length) : query;
  return body.split(',').map(s => s.trim()).filter(Boolean).join(', ');
}

interface WebSearchLink {
  title: string;
  url: string;
}

interface WebSearchDisplayData {
  actionType: string;
  query: string;
  queries: string[];
  url: string;
  pattern: string;
  linkId: string;
}

function normalizeWebSearchDisplayData(input: Record<string, unknown>): WebSearchDisplayData {
  const queries = Array.isArray(input.queries)
    ? input.queries
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map(entry => entry.trim())
    : [];

  const query = typeof input.query === 'string' && input.query.trim()
    ? input.query.trim()
    : queries[0] ?? '';
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : '';
  const pattern = typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : '';

  const explicitActionType = typeof input.actionType === 'string' && input.actionType.trim()
    ? input.actionType.trim()
    : '';
  const actionType = explicitActionType
    || (url && pattern ? 'find_in_page' : url ? 'open_page' : (query || queries.length > 0) ? 'search' : '');

  return { actionType, query, queries, url, pattern, linkId: getInputText(input, 'linkId') };
}

function getWebSearchSummary(input: Record<string, unknown>, maxLength: number): string {
  if (Array.isArray(input.actions) && input.actions.length > 1) {
    return `${input.actions.length} web operations`;
  }
  if (Array.isArray(input.requests)) return getWebOperationLabel(getInputText(input, 'actionType'));
  const data = normalizeWebSearchDisplayData(input);

  switch (data.actionType) {
    case 'click':
      return truncateText(`Click link ${data.linkId} in ${data.url}`, maxLength);
    case 'open_page':
      return truncateText(`Open ${data.url || 'page'}`, maxLength);
    case 'find_in_page': {
      const target = data.pattern ? `Find "${data.pattern}"` : 'Find in page';
      const suffix = data.url ? ` in ${data.url}` : '';
      return truncateText(target + suffix, maxLength);
    }
    case 'search':
      return truncateText(data.query || data.queries[0] || '', maxLength);
    default:
      return truncateText(data.query || data.url || data.pattern || '', maxLength);
  }
}

function getWebSearchLabel(input: Record<string, unknown>, maxLength: number): string {
  const summary = getWebSearchSummary(input, maxLength);
  return `WebSearch: ${summary || 'search'}`;
}

function appendToolLink(parent: HTMLElement, title: string, url: string): void {
  // Native page references are useful text, not navigable URLs.
  let isWebURL = false;
  try { isWebURL = ['https:', 'http:'].includes(new URL(url).protocol); } catch { /* Reference or malformed URL. */ }
  if (!isWebURL) {
    parent.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap', text: title });
    return;
  }
  const linkEl = parent.createEl('a', { cls: 'claudian-tool-link' });
  linkEl.setAttribute('href', url);
  linkEl.setAttribute('target', '_blank');
  linkEl.setAttribute('rel', 'noopener noreferrer');

  const iconEl = linkEl.createSpan({ cls: 'claudian-tool-link-icon' });
  setIcon(iconEl, 'external-link');

  linkEl.createSpan({ cls: 'claudian-tool-link-title', text: title });
}

function parseWebSearchLinks(result: string): WebSearchLink[] {
  const linksMatch = result.match(/Links:\s*(\[[\s\S]*?\])(?:\n|$)/);
  if (!linksMatch) return [];

  try {
    const parsed = JSON.parse(linksMatch[1]) as WebSearchLink[];
    return Array.isArray(parsed) ? parsed.filter(l => l.title && l.url) : [];
  } catch {
    return [];
  }
}

function getWebOperationLabel(actionType: string): string {
  const label = actionType.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function renderWebSearchActionExpanded(container: HTMLElement, input: Record<string, unknown>): boolean {
  if (Array.isArray(input.actions)) {
    let rendered = false;
    for (const action of input.actions) {
      if (action && typeof action === 'object' && !Array.isArray(action)) {
        const { actions: _nested, ...single } = action as Record<string, unknown>;
        rendered = renderWebSearchActionExpanded(container, single) || rendered;
      }
    }
    return rendered;
  }
  if (Array.isArray(input.requests)) {
    const lines = container.createDiv({ cls: 'claudian-tool-lines' });
    lines.createDiv({ cls: 'claudian-tool-line', text: getWebOperationLabel(getInputText(input, 'actionType')) });
    renderLinesExpanded(container, JSON.stringify(input.requests, null, 2), 20);
    return true;
  }
  const data = normalizeWebSearchDisplayData(input);
  const hasStructuredData = Boolean(data.actionType || data.query || data.queries.length || data.url || data.pattern);
  if (!hasStructuredData) {
    return false;
  }

  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });

  switch (data.actionType) {
    case 'click':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: `Click link ${data.linkId}` });
      if (data.url) appendToolLink(linesEl, data.url, data.url);
      return true;
    case 'open_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: 'Open page' });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: 'URL unavailable' });
      }
      return true;

    case 'find_in_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: 'Find in page' });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: 'URL unavailable' });
      }
      if (data.pattern) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: `Pattern: ${data.pattern}` });
      }
      return true;

    case 'search':
    default: {
      const primaryQuery = data.query || data.queries[0];
      linesEl.createDiv({
        cls: 'claudian-tool-line',
        text: primaryQuery ? `Query: ${primaryQuery}` : 'Search web',
      });

      const alternateQueries = data.queries.filter(query => query !== primaryQuery);
      for (const query of alternateQueries.slice(0, 4)) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: `Alt query: ${query}` });
      }
      if (alternateQueries.length > 4) {
        linesEl.createDiv({
          cls: 'claudian-tool-truncated',
          text: `... ${alternateQueries.length - 4} more queries`,
        });
      }
      return true;
    }
  }
}

/** Shows the request and linked source titles only; result bodies, snippets and summaries stay hidden. */
function renderWebSearchExpanded(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string | undefined,
  structuredResults?: WebSearchResultItem[],
): void {
  const renderedRequest = renderWebSearchActionExpanded(container, input);
  const links = structuredResults?.length ? structuredResults : parseWebSearchLinks(result ?? '');
  if (links.length > 0) {
    const linksEl = container.createDiv({ cls: 'claudian-tool-lines' });
    for (const link of links) appendToolLink(linksEl, link.title, link.url);
  } else if (!renderedRequest) {
    container.createDiv({ cls: 'claudian-tool-empty', text: 'No result' });
  }
}

function renderFileSearchExpanded(container: HTMLElement, result: string): void {
  if (!result.trim()) {
    container.createDiv({ cls: 'claudian-tool-empty', text: 'No matches found' });
    return;
  }
  renderLinesExpanded(container, result, 15, true);
}

/** Strips `N→` line-number gutters only when every leading line carries the next consecutive number. */
function stripLegacyLineNumberGutters(result: string): string {
  const lines = result.split(/\r?\n/);
  const first = lines[0]?.match(/^\s*(\d+)→/);
  const second = lines[1]?.match(/^\s*(\d+)→/);
  if (!first || (lines.length > 1 && lines[1] !== '' && Number(second?.[1]) !== Number(first[1]) + 1)) return result;
  const start = Number(first[1]);
  return lines.map((line, index) => {
    const gutter = line.match(/^\s*(\d+)→/);
    return gutter && Number(gutter[1]) === start + index ? line.slice(gutter[0].length) : line;
  }).join('\n');
}

function renderLinesExpanded(
  container: HTMLElement,
  result: string,
  maxLines: number,
  hoverable = false
): void {
  const displayLines = result.split(/\r?\n/, maxLines);
  let lineCount = 1;
  for (let offset = result.indexOf('\n'); offset !== -1; offset = result.indexOf('\n', offset + 1)) lineCount++;
  const truncated = lineCount > maxLines;

  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
  for (const line of displayLines) {
    const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
    if (hoverable) lineEl.addClass('hoverable');
    lineEl.setText(line || ' ');
  }

  if (truncated) {
    linesEl.createDiv({
      cls: 'claudian-tool-truncated',
      text: `... ${lineCount - maxLines} more lines`,
    });
  }
}

function renderToolSearchExpanded(container: HTMLElement, result: string): void {
  let toolNames: string[] = [];
  try {
    const parsed = JSON.parse(result) as Array<{ type: string; tool_name: string }>;
    if (Array.isArray(parsed)) {
      toolNames = parsed
        .filter(item => item.type === 'tool_reference' && item.tool_name)
        .map(item => item.tool_name);
    }
  } catch {
    // Fall back to showing raw result
  }

  if (toolNames.length === 0) {
    renderLinesExpanded(container, result, 20);
    return;
  }

  for (const name of toolNames) {
    const lineEl = container.createDiv({ cls: 'claudian-tool-search-item' });
    const iconEl = lineEl.createSpan({ cls: 'claudian-tool-search-icon' });
    setToolIcon(iconEl, name);
    lineEl.createSpan({ text: name });
  }
}

function renderWebFetchExpanded(container: HTMLElement, result: string): void {
  const maxChars = 500;
  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
  const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap' });

  if (result.length > maxChars) {
    lineEl.setText(result.slice(0, maxChars));
    linesEl.createDiv({
      cls: 'claudian-tool-truncated',
      text: `... ${result.length - maxChars} more characters`,
    });
  } else {
    lineEl.setText(result);
  }
}

function renderApplyPatchExpanded(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string | undefined,
): void {
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const parsedDiffs = getApplyPatchFileDiffs(input);

  if (result && /verification failed|^[Ee]rror:/.test(result.trim())) {
    renderLinesExpanded(container, result, 20);
  }

  if (parsedDiffs.length > 0) {
    renderApplyPatchDiffSections(container, parsedDiffs);
    return;
  }

  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length > 0) {
    const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
    for (const change of changes as unknown[]) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) continue;
      const changeRecord = change as Record<string, unknown>;
      const path = typeof changeRecord.path === 'string' ? changeRecord.path : '';
      if (!path) continue;
      const movedTo = readMoveTarget(changeRecord.kind);
      const pathText = movedTo ? `${path} -> ${movedTo}` : path;
      linesEl.createDiv({ cls: 'claudian-tool-line', text: pathText });
    }
    return;
  }

  if (patchText) {
    renderLinesExpanded(container, patchText, 80);
    return;
  }

  if (result) {
    const fileMatches = [...result.matchAll(/(?:update|add|delete|create|modify|Applied:\s*)(?:\w+:\s*)?([^\n,]+)/gi)];
    if (fileMatches.length > 0) {
      const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
      for (const match of fileMatches) {
        const filePath = match[1]?.trim();
        if (filePath) {
          const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
          lineEl.setText(filePath);
        }
      }
      return;
    }
    renderLinesExpanded(container, result, 20);
    return;
  }

  container.createDiv({ cls: 'claudian-tool-empty', text: 'No result' });
}

function renderApplyPatchDiffSections(
  container: HTMLElement,
  fileDiffs: ReturnType<typeof parseApplyPatchDiffs>,
): void {
  for (const fileDiff of fileDiffs) {
    const sectionEl = container.createDiv({ cls: 'claudian-tool-patch-section' });

    if (fileDiff.operation === 'delete' && fileDiff.diffLines.length === 0) {
      sectionEl.createDiv({ cls: 'claudian-tool-empty', text: 'File deleted' });
      continue;
    }

    if (fileDiff.diffLines.length === 0) {
      sectionEl.createDiv({ cls: 'claudian-tool-empty', text: 'No textual diff available' });
      continue;
    }

    const diffRow = sectionEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const diffEl = diffRow.createDiv({ cls: 'claudian-write-edit-diff' });
    renderDiffContent(diffEl, fileDiff.diffLines);
  }
}

function readMoveTarget(kind: unknown): string | undefined {
  if (!kind || typeof kind !== 'object' || Array.isArray(kind)) {
    return undefined;
  }
  const record = kind as Record<string, unknown>;
  return typeof record.move_path === 'string' ? record.move_path : undefined;
}

function getApplyPatchFileDiffs(input: Record<string, unknown>): ReturnType<typeof parseApplyPatchDiffs> {
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const parsedDiffs = patchText ? parseApplyPatchDiffs(patchText) : [];
  return parsedDiffs.length > 0 ? parsedDiffs : parseFileUpdateChangeDiffs(input.changes);
}

function getApplyPatchDiffStats(input: Record<string, unknown>): DiffStats | undefined {
  const fileDiffs = getApplyPatchFileDiffs(input);
  if (fileDiffs.length === 0) return undefined;

  const stats = fileDiffs.reduce<DiffStats>(
    (acc, fileDiff) => ({
      added: acc.added + fileDiff.stats.added,
      removed: acc.removed + fileDiff.stats.removed,
    }),
    { added: 0, removed: 0 }
  );

  return stats.added > 0 || stats.removed > 0 ? stats : undefined;
}

function getDiffStatsAriaLabel(stats: DiffStats): string {
  return `Changes: +${stats.added} -${stats.removed}`;
}

function renderAgentLifecycleExpanded(
  container: HTMLElement,
  result: string,
  input: Record<string, unknown>,
  initialText?: string,
): void {
  const target = getInputText(input, 'target');
  const message = getInputText(input, 'message');
  if (target || message) {
    const inputEl = container.createDiv({ cls: 'claudian-tool-lines' });
    if (target) inputEl.createDiv({ cls: 'claudian-tool-line', text: `Agent: ${target}` });
    if (message) inputEl.createDiv({ cls: 'claudian-tool-line claudian-tool-line-wrap', text: message });
  }
  if (!result) {
    contentFallback(container, initialText ?? 'No output');
    return;
  }
  // Try to parse as JSON for structured display
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
      for (const [key, value] of Object.entries(parsed)) {
        const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
        const displayValue = formatToolDisplayValue(value);
        lineEl.setText(`${key}: ${displayValue}`);
      }
      return;
    } catch { /* fall through to plain text */ }
  }
  renderLinesExpanded(container, result, 20);
}

function formatToolDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value, null, 2);
}

/** Neutral tool fields the expanded view can present. */
export type ExpandedToolContent = Pick<
  ToolCallInfo,
  'name' | 'result' | 'resultFormat' | 'input' | 'webSearchResults' | 'resultImages' | 'scriptToolCalls'
> & Partial<Pick<ToolCallInfo, 'status'>>;

export function renderExpandedContent(
  container: HTMLElement,
  toolCall: ExpandedToolContent,
): void {
  const images = toolCall.resultImages ?? [];
  // An image-only result needs no empty-state placeholder above its preview.
  if (toolCall.result || images.length === 0 || isScriptTool(toolCall.name)) renderExpandedResult(container, toolCall);
  if (images.length > 0) renderResultImages(container, images);
}

/** Resolves a provider image to a URL the host webview can load. */
function getResultImageSource(image: ToolResultImage): string {
  if (image.kind === 'data') return `data:${image.mediaType};base64,${image.data}`;
  const segments = image.path.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  return Platform.resourcePathPrefix + segments
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
}

function renderResultImages(container: HTMLElement, images: ToolResultImage[]): void {
  const imagesEl = container.createDiv({ cls: 'claudian-tool-result-images' });
  for (const image of images) {
    const alt = image.alt ?? (image.kind === 'file' ? fileNameOnly(image.path) : image.mediaType);
    imagesEl.createEl('img', { cls: 'claudian-tool-result-image', attr: { alt, loading: 'lazy', src: getResultImageSource(image) } });
  }
}

function renderExpandedResult(
  container: HTMLElement,
  toolCall: ExpandedToolContent,
): void {
  const { name: toolName, result, input } = toolCall;
  if (isAgentLifecycleTool(toolName)) {
    renderAgentLifecycleExpanded(container, result ?? '', input);
    return;
  }

  if (isScriptTool(toolName)) {
    renderScriptContent(container, toolCall);
    return;
  }
  if (!result && toolName !== TOOL_WEB_SEARCH && toolName !== TOOL_BASH && toolName !== TOOL_APPLY_PATCH) {
    container.createDiv({ cls: 'claudian-tool-empty', text: 'No result' });
    return;
  }

  const resolvedResult = result ?? '';

  switch (toolName) {
    case TOOL_BASH:
      renderBashContent(container, input, resolvedResult);
      break;
    case TOOL_BASH_OUTPUT:
      if (getInputText(input, 'command')) renderBashContent(container, input, resolvedResult);
      else renderLinesExpanded(container, resolvedResult, 20);
      break;
    case TOOL_WRITE_STDIN:
      renderLinesExpanded(container, resolvedResult, 20);
      break;
    case TOOL_READ:
      renderLinesExpanded(container, toolCall.resultFormat === 'plain' ? resolvedResult : stripLegacyLineNumberGutters(resolvedResult), 15);
      break;
    case TOOL_GLOB:
    case TOOL_GREP:
    case TOOL_LS:
      renderFileSearchExpanded(container, resolvedResult);
      break;
    case TOOL_WEB_SEARCH:
      renderWebSearchExpanded(container, input, result, toolCall.webSearchResults);
      break;
    case TOOL_WEB_FETCH:
      renderWebFetchExpanded(container, resolvedResult);
      break;
    case TOOL_TOOL_SEARCH:
      renderToolSearchExpanded(container, resolvedResult);
      break;
    case TOOL_APPLY_PATCH:
      renderApplyPatchExpanded(container, input, result);
      break;
    default:
      renderLinesExpanded(container, resolvedResult, 20);
      break;
  }
}

function getTodos(input: Record<string, unknown>): TodoItem[] | undefined {
  const todos = input.todos;
  if (!todos || !Array.isArray(todos)) return undefined;
  return todos as TodoItem[];
}

function getCurrentTask(input: Record<string, unknown>): TodoItem | undefined {
  const todos = getTodos(input);
  if (!todos) return undefined;
  return todos.find(t => t.status === 'in_progress');
}

function areAllTodosCompleted(input: Record<string, unknown>): boolean {
  const todos = getTodos(input);
  if (!todos) return false;
  return todos.every(t => t.status === 'completed');
}

function resetStatusElement(statusEl: HTMLElement, statusClass: string, ariaLabel: string): void {
  statusEl.className = 'claudian-tool-status';
  statusEl.empty();
  statusEl.addClass(statusClass);
  statusEl.setAttribute('aria-label', ariaLabel);
}

const STATUS_ICONS: Record<string, string> = {
  completed: 'check',
  error: 'x',
  blocked: 'shield-off',
};

function setTodoWriteStatus(statusEl: HTMLElement, input: Record<string, unknown>): void {
  const isComplete = areAllTodosCompleted(input);
  const status = isComplete ? 'completed' : 'running';
  const ariaLabel = isComplete ? 'Status: completed' : 'Status: in progress';
  resetStatusElement(statusEl, `status-${status}`, ariaLabel);
  if (isComplete) setIcon(statusEl, 'check');
}

function setToolStatus(statusEl: HTMLElement, status: ToolCallInfo['status']): void {
  resetStatusElement(statusEl, `status-${status}`, `Status: ${status}`);
  const icon = STATUS_ICONS[status];
  if (icon) setIcon(statusEl, icon);
}

function setApplyPatchHeaderRight(statusEl: HTMLElement, toolCall: ToolCallInfo): void {
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';
  const stats = isError ? undefined : getApplyPatchDiffStats(toolCall.input);
  if (!stats) {
    setToolStatus(statusEl, toolCall.status);
    return;
  }

  statusEl.className = 'claudian-tool-status claudian-write-edit-stats';
  statusEl.empty();
  statusEl.setAttribute('aria-label', getDiffStatsAriaLabel(stats));
  renderDiffStats(statusEl, stats);
}

function setGenericToolHeaderRight(statusEl: HTMLElement, toolCall: ToolCallInfo): void {
  if (toolCall.name === TOOL_APPLY_PATCH) {
    setApplyPatchHeaderRight(statusEl, toolCall);
    return;
  }

  setToolStatus(statusEl, toolCall.status);
}

function renderTodoWriteResult(
  container: HTMLElement,
  input: Record<string, unknown>
): void {
  container.empty();
  container.addClass('claudian-todo-list-container');

  const todos = input.todos as TodoItem[] | undefined;
  if (!todos || !Array.isArray(todos)) {
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText('Tasks updated');
    return;
  }

  renderTodoItems(container, todos);
}

interface ToolElementStructure {
  toolEl: HTMLElement;
  header: HTMLElement;
  iconEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  statusEl: HTMLElement;
  content: HTMLElement;
  currentTaskEl: HTMLElement | null;
}

export interface ToolCallRenderOptions {
  initiallyExpanded?: boolean;
}

function createToolElementStructure(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo
): ToolElementStructure {
  const toolEl = parentEl.createDiv({ cls: 'claudian-tool-call' });
  toolEl.dataset.toolId = toolCall.id;
  if (toolCall.name === TOOL_BASH) {
    toolEl.addClass('claudian-tool-call-bash');
  }

  const header = toolEl.createDiv({ cls: 'claudian-tool-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');

  const iconEl = header.createSpan({ cls: 'claudian-tool-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setToolIcon(iconEl, toolCall.name);

  const nameEl = header.createSpan({ cls: 'claudian-tool-name' });
  nameEl.setText(getToolName(toolCall.name, toolCall.input));

  const summaryEl = header.createSpan({ cls: 'claudian-tool-summary' });
  summaryEl.setText(getToolSummary(toolCall.name, toolCall.input));

  const currentTaskEl = toolCall.name === TOOL_TODO_WRITE
    ? createCurrentTaskPreview(header, toolCall.input)
    : null;

  const statusEl = header.createSpan({ cls: 'claudian-tool-status' });

  const content = toolEl.createDiv({ cls: 'claudian-tool-content' });

  return { toolEl, header, iconEl, nameEl, summaryEl, statusEl, content, currentTaskEl };
}

function formatAnswer(raw: unknown): string {
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') return raw;
  return '';
}

function resolveAskUserAnswers(toolCall: ToolCallInfo): Record<string, unknown> | undefined {
  if (toolCall.resolvedAnswers) return toolCall.resolvedAnswers;

  const parsed = extractResolvedAnswersFromResultText(toolCall.result);
  if (parsed) {
    toolCall.resolvedAnswers = parsed;
    return parsed;
  }

  return undefined;
}

function renderAskUserQuestionResult(container: HTMLElement, toolCall: ToolCallInfo): boolean {
  const questions = toolCall.input.questions as AskUserQuestionItem[] | undefined;
  const answers = resolveAskUserAnswers(toolCall);
  if (!questions || !Array.isArray(questions) || !answers) return false;
  if (!questions.some(question => (question.id && question.id in answers) || question.question in answers)) return false;
  if (toolCall.input.replyMode === 'user-message' && !questions.every(question => (question.id && question.id in answers) || question.question in answers)) return false;
  container.empty();

  const reviewEl = container.createDiv({ cls: 'claudian-ask-review' });
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = formatAnswer(
      (q.id ? answers[q.id] : undefined) ?? answers[q.question]
    );
    const pairEl = reviewEl.createDiv({ cls: 'claudian-ask-review-pair' });
    const bodyEl = pairEl.createDiv({ cls: 'claudian-ask-review-body' });
    bodyEl.createDiv({ text: q.question, cls: 'claudian-ask-review-q-text' });
    bodyEl.createDiv({
      text: answer || 'Not answered',
      cls: answer ? 'claudian-ask-review-a-text' : 'claudian-ask-review-empty',
    });
  }

  return true;
}

function renderQuestionContent(container: HTMLElement, tool: ToolCallInfo, initialText?: string): void {
  if (renderAskUserQuestionResult(container, tool)) return;
  const prompt = tool.input.replyMode === 'user-message'
    ? tool.questionStatus === 'pending' ? 'Answer in the question panel below.' : 'Question expired.'
    : initialText;
  renderAskUserQuestionFallback(container, tool, prompt);
}

function renderAskUserQuestionFallback(container: HTMLElement, toolCall: ToolCallInfo, initialText?: string): void {
  container.empty();

  const questions = Array.isArray(toolCall.input.questions)
    ? toolCall.input.questions as AskUserQuestionItem[]
    : [];

  if (questions.length === 0) {
    contentFallback(container, initialText || toolCall.result || 'Waiting for answer...');
    return;
  }

  if (initialText || toolCall.result) {
    container.createDiv({
      cls: 'claudian-ask-review-prompt',
      text: initialText || toolCall.result || 'Waiting for answer...',
    });
  }

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    const question = questions[questionIndex];
    const reviewEl = container.createDiv({ cls: 'claudian-ask-review' });
    const pairEl = reviewEl.createDiv({ cls: 'claudian-ask-review-pair' });
    const bodyEl = pairEl.createDiv({ cls: 'claudian-ask-review-body' });
    bodyEl.createDiv({ text: question.question, cls: 'claudian-ask-review-q-text' });

    if (!Array.isArray(question.options) || question.options.length === 0) {
      bodyEl.createDiv({ cls: 'claudian-ask-review-empty', text: 'No options recorded' });
      continue;
    }

    const listEl = bodyEl.createDiv({ cls: 'claudian-ask-list' });
    question.options.forEach((option) => {
      renderAskUserQuestionOption(listEl, option, question.multiSelect === true);
    });
  }
}

function renderAskUserQuestionOption(
  parentEl: HTMLElement,
  option: AskUserQuestionOption,
  isMultiSelect: boolean,
): void {
  const itemEl = parentEl.createDiv({ cls: 'claudian-ask-item is-disabled' });

  if (isMultiSelect) {
    itemEl.createDiv({ cls: 'claudian-ask-check', attr: { 'aria-hidden': 'true' } });
  } else {
    itemEl.createDiv({ cls: 'claudian-ask-radio', attr: { 'aria-hidden': 'true' } });
  }

  const contentEl = itemEl.createDiv({ cls: 'claudian-ask-item-content' });
  const labelRowEl = contentEl.createDiv({ cls: 'claudian-ask-label-row' });
  labelRowEl.createDiv({ cls: 'claudian-ask-item-label', text: option.label });

  if (option.description) {
    contentEl.createDiv({ cls: 'claudian-ask-item-desc', text: option.description });
  }
}

function contentFallback(container: HTMLElement, text: string): void {
  const resultRow = container.createDiv({ cls: 'claudian-tool-result-row' });
  const resultText = resultRow.createSpan({ cls: 'claudian-tool-result-text' });
  resultText.setText(text);
}

const SCRIPT_CALL_STATUS_ICONS: Partial<Record<ScriptToolCallItem['status'], string>> = {
  completed: 'check',
  error: 'x',
  cancelled: 'ban',
};

function formatScriptCallDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `key: value` pairs for tools without a dedicated summary. */
function summarizeToolInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${stringifyUnknown(value)}`)
    .join(', ');
}

function getScriptToolCallSummary(call: ScriptToolCallItem): string {
  if (!call.input) return call.args ?? '';
  return getToolSummary(call.name, call.input) || summarizeToolInput(call.input);
}

function renderScriptToolCalls(container: HTMLElement, calls: ScriptToolCallItem[]): void {
  container.createDiv({ cls: 'claudian-tool-script-label', text: 'Tool calls' });
  const listEl = container.createEl('ul', { cls: 'claudian-tool-script-calls', attr: { 'aria-label': 'Tool calls' } });
  for (const call of calls) {
    const itemEl = listEl.createEl('li', { cls: 'claudian-tool-script-call' });
    const statusEl = itemEl.createSpan({
      cls: `claudian-tool-status status-${call.status}`,
      attr: { role: 'img', 'aria-label': `Status: ${call.status}` },
    });
    const icon = SCRIPT_CALL_STATUS_ICONS[call.status];
    if (icon) setIcon(statusEl, icon);
    const summary = truncateText(getScriptToolCallSummary(call), 80);
    itemEl.createSpan({ cls: 'claudian-tool-script-call-name', text: call.input ? getToolName(call.name, call.input) : call.name });
    if (summary) {
      itemEl.append(' ');
      itemEl.createSpan({ cls: 'claudian-tool-script-call-detail', text: summary });
    }
    if (call.durationMs !== undefined) {
      itemEl.append(' ');
      itemEl.createSpan({ cls: 'claudian-tool-script-call-detail', text: formatScriptCallDuration(call.durationMs) });
    }
    if (call.error) {
      itemEl.createDiv({ cls: 'claudian-tool-script-call-error', text: call.error });
    }
  }
}

function renderScriptContent(
  container: HTMLElement,
  toolCall: ExpandedToolContent,
): void {
  const source = getScriptSource(toolCall.input);
  if (source) {
    container.createDiv({ cls: 'claudian-tool-script-label', text: getScriptLanguage(toolCall.input) });
    const sourceEl = container.createEl('pre', { cls: 'claudian-tool-script-code' });
    sourceEl.createEl('code', { text: source });
  }
  if (toolCall.scriptToolCalls?.length) {
    renderScriptToolCalls(container, toolCall.scriptToolCalls);
  }
  const result = toolCall.result ?? '';
  container.createDiv({ cls: 'claudian-tool-script-label', text: 'Output' });
  if (result) {
    container.createEl('pre', { cls: 'claudian-tool-script-output', text: result });
  } else if (!toolCall.resultImages?.length) {
    contentFallback(container, toolCall.status === 'running' ? 'Running...' : 'No result');
  }
}

function renderBashContent(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string,
  initialText?: string,
): void {
  const command = (input.command as string) || '';
  if (command) {
    const cmdEl = container.createDiv({ cls: 'claudian-tool-bash-command' });
    cmdEl.setText(`$ ${command}`);
  }
  if (initialText) {
    contentFallback(container, initialText);
  } else if (result) {
    renderLinesExpanded(container, result, 20);
  } else {
    container.createDiv({ cls: 'claudian-tool-empty', text: 'No result' });
  }
}

function createCurrentTaskPreview(
  header: HTMLElement,
  input: Record<string, unknown>
): HTMLElement {
  const currentTaskEl = header.createSpan({ cls: 'claudian-tool-current' });
  const currentTask = getCurrentTask(input);
  if (currentTask) {
    currentTaskEl.setText(currentTask.activeForm);
  }
  return currentTaskEl;
}

function createTodoToggleHandler(
  currentTaskEl: HTMLElement | null,
  statusEl: HTMLElement | null,
  onExpandChange?: (expanded: boolean) => void
): (expanded: boolean) => void {
  return (expanded: boolean) => {
    if (onExpandChange) onExpandChange(expanded);
    if (currentTaskEl) {
      currentTaskEl.toggleClass('claudian-hidden', expanded);
    }
    if (statusEl) {
      statusEl.toggleClass('claudian-hidden', expanded);
    }
  };
}

function renderToolContent(
  content: HTMLElement,
  toolCall: ToolCallInfo,
  initialText?: string,
): void {
  if (toolCall.name === TOOL_TODO_WRITE) {
    content.addClass('claudian-tool-content-todo');
    renderTodoWriteResult(content, toolCall.input);
  } else if (toolCall.name === TOOL_ASK_USER_QUESTION) {
    content.addClass('claudian-tool-content-ask');
    renderQuestionContent(content, toolCall, initialText ? 'Waiting for answer...' : undefined);
  } else if (isAgentLifecycleTool(toolCall.name)) {
    renderAgentLifecycleExpanded(content, toolCall.result ?? '', toolCall.input, initialText);
  } else if (isScriptTool(toolCall.name)) {
    renderExpandedContent(content, toolCall);
  } else if (toolCall.name === TOOL_BASH) {
    renderBashContent(content, toolCall.input, toolCall.result ?? '', initialText);
  } else if (initialText) {
    contentFallback(content, initialText);
  } else {
    renderExpandedContent(content, toolCall);
  }
}

const liveContentUpdates = new WeakMap<HTMLElement, (toolCall: ToolCallInfo) => void>();

export function renderToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>,
  options: ToolCallRenderOptions = {}
): HTMLElement {
  const { toolEl, header, statusEl, content, currentTaskEl } =
    createToolElementStructure(parentEl, toolCall);

  toolCallElements.set(toolCall.id, toolEl);

  setGenericToolHeaderRight(statusEl, toolCall);

  const initiallyExpanded = options.initiallyExpanded ?? false;
  const state = { isExpanded: initiallyExpanded };
  let currentTool = toolCall;
  let initial = true;
  let dirty = true;
  const renderCurrentContent = () => {
    if (!dirty) return;
    content.empty();
    if (initial) renderToolContent(content, currentTool, 'Running...');
    else renderExpandedContent(content, currentTool);
    dirty = false;
  };
  const eager = toolCall.name === TOOL_TODO_WRITE || toolCall.name === TOOL_ASK_USER_QUESTION;
  if (eager || initiallyExpanded) renderCurrentContent();
  if (!eager) liveContentUpdates.set(toolEl, next => {
    currentTool = next;
    currentTool.isExpanded = state.isExpanded;
    initial = false;
    dirty = true;
    if (state.isExpanded) renderCurrentContent();
  });
  toolCall.isExpanded = initiallyExpanded;
  const todoStatusEl = toolCall.name === TOOL_TODO_WRITE ? statusEl : null;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded,
    onToggle: createTodoToggleHandler(currentTaskEl, todoStatusEl, (expanded) => {
      currentTool.isExpanded = expanded;
      if (expanded && !eager) renderCurrentContent();
    }),
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
  });

  return toolEl;
}

export function updateToolCallResult(
  toolId: string,
  toolCall: ToolCallInfo,
  toolCallElements: Map<string, HTMLElement>
) {
  const toolEl = toolCallElements.get(toolId);
  if (!toolEl) return;

  if (toolCall.name === TOOL_TODO_WRITE) {
    const statusEl = toolEl.querySelector('.claudian-tool-status') as HTMLElement;
    if (statusEl) {
      setTodoWriteStatus(statusEl, toolCall.input);
    }
    const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
    if (content) {
      renderTodoWriteResult(content, toolCall.input);
    }
    const nameEl = toolEl.querySelector('.claudian-tool-name') as HTMLElement;
    if (nameEl) {
      nameEl.setText(getToolName(toolCall.name, toolCall.input));
    }
    const currentTaskEl = toolEl.querySelector('.claudian-tool-current') as HTMLElement;
    if (currentTaskEl) {
      const currentTask = getCurrentTask(toolCall.input);
      currentTaskEl.setText(currentTask ? currentTask.activeForm : '');
    }
    return;
  }

  const statusEl = toolEl.querySelector('.claudian-tool-status') as HTMLElement;
  if (statusEl) {
    setGenericToolHeaderRight(statusEl, toolCall);
  }

  if (toolCall.name === TOOL_ASK_USER_QUESTION) {
    const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
    if (content) {
      content.addClass('claudian-tool-content-ask');
      renderQuestionContent(content, toolCall);
    }
    return;
  }

  const updateLiveContent = liveContentUpdates.get(toolEl);
  if (updateLiveContent) {
    updateLiveContent(toolCall);
    return;
  }

  const content = toolEl.querySelector('.claudian-tool-content') as HTMLElement;
  if (content) {
    content.empty();
    renderExpandedContent(content, toolCall);
  }
}

/** For stored (non-streaming) tool calls — collapsed by default. */
export function renderStoredToolCall(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: ToolCallRenderOptions = {}
): HTMLElement {
  const { toolEl, header, statusEl, content, currentTaskEl } =
    createToolElementStructure(parentEl, toolCall);

  if (toolCall.name === TOOL_TODO_WRITE) {
    setTodoWriteStatus(statusEl, toolCall.input);
  } else {
    setGenericToolHeaderRight(statusEl, toolCall);
  }

  let contentRendered = false;
  const renderContentOnce = () => {
    if (contentRendered) return;
    renderToolContent(content, toolCall);
    contentRendered = true;
  };
  const deferContent = toolCall.status !== 'running'
    && toolCall.name !== TOOL_ASK_USER_QUESTION
    && toolCall.name !== TOOL_TODO_WRITE;
  if (!deferContent || options.initiallyExpanded) renderContentOnce();

  const state = { isExpanded: false };
  const todoStatusEl = toolCall.name === TOOL_TODO_WRITE ? statusEl : null;
  setupCollapsible(toolEl, header, content, state, {
    initiallyExpanded: options.initiallyExpanded ?? false,
    onToggle: createTodoToggleHandler(currentTaskEl, todoStatusEl, (expanded) => {
      if (expanded) renderContentOnce();
    }),
    baseAriaLabel: getToolLabel(toolCall.name, toolCall.input)
  });

  return toolEl;
}
