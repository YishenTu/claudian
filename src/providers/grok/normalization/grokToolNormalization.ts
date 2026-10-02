import { stringifyUnknown } from '@/utils/stringify';

import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import {
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
  TOOL_GREP,
  TOOL_KILL_SHELL,
  TOOL_LS,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_SKILL,
  TOOL_TODO_WRITE,
  TOOL_TOOL_SEARCH,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WORKFLOW,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { AskUserAnswers, ToolResultImage, WebSearchResultItem } from '../../../core/types';
import type { SDKToolUseResult, StructuredPatchHunk } from '../../../core/types/diff';
import type { ACPToolRawNameProvenance } from '../../acp/ACPToolStreamAdapter';
import { GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES } from './grokLifecycleToolNames';

const GROK_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  apply_patch: TOOL_APPLY_PATCH,
  ask_user_question: TOOL_ASK_USER_QUESTION,
  edit_notebook: TOOL_NOTEBOOK_EDIT,
  enter_plan_mode: TOOL_ENTER_PLAN_MODE,
  exit_plan_mode: TOOL_EXIT_PLAN_MODE,
  get_terminal_command_output: TOOL_BASH_OUTPUT,
  grep: TOOL_GREP,
  hashline_edit: TOOL_EDIT,
  hashline_grep: TOOL_GREP,
  hashline_read: TOOL_READ,
  image_edit: TOOL_EDIT_IMAGE,
  image_gen: TOOL_GENERATE_IMAGE,
  image_to_video: TOOL_GENERATE_VIDEO,
  kill_terminal_command: TOOL_KILL_SHELL,
  list_dir: TOOL_LS,
  read_file: TOOL_READ,
  reference_to_video: TOOL_GENERATE_VIDEO,
  run_terminal_command: TOOL_BASH,
  search_replace: TOOL_EDIT,
  search_tool: TOOL_TOOL_SEARCH,
  skill: TOOL_SKILL,
  todo_write: TOOL_TODO_WRITE,
  web_fetch: TOOL_WEB_FETCH,
  web_search: TOOL_WEB_SEARCH,
  workflow: TOOL_WORKFLOW,
  write: TOOL_WRITE,
  write_file: TOOL_WRITE,
};

export interface GrokNormalizedToolCall {
  input: Record<string, unknown>;
  name: string;
  output: string;
  rawInput: unknown;
  rawName: string;
  rawOutput: unknown;
}

export interface GrokToolProviderPayload {
  rawInput?: unknown;
  rawName: string;
  rawOutput?: unknown;
}

export interface GrokNormalizedToolUseResult extends SDKToolUseResult {
  answers?: AskUserAnswers;
  providerPayload: GrokToolProviderPayload;
}

export interface GrokRawToolNameResolution {
  provenance: ACPToolRawNameProvenance;
  rawName: string;
}

export function normalizeGrokToolName(rawName: string, rawInput?: unknown, rawOutput?: unknown): string {
  const normalized = rawName.trim();
  const lookup = normalized.toLowerCase();
  // Background shells share the task-output tool with subagents; only proven shell results leave the lifecycle.
  if (lookup === 'get_command_or_subagent_output' && readShellTaskResults(rawOutput)) {
    return TOOL_BASH_OUTPUT;
  }
  if (GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES.has(lookup)) {
    return normalized || 'tool';
  }
  // `use_tool` dispatches to an MCP catalog key (`server__tool`); present the MCP tool itself.
  if (lookup === 'use_tool' && isRecord(rawInput) && typeof rawInput.tool_name === 'string' && rawInput.tool_name.trim()) {
    return `mcp__${rawInput.tool_name.trim()}`;
  }
  return GROK_TOOL_NAME_MAP[lookup] ?? (normalized || 'tool');
}

export function resolveGrokRawToolName(
  currentRawName: GrokRawToolNameResolution | undefined,
  update: { kind?: string | null; title?: string | null },
): GrokRawToolNameResolution {
  const title = update.title?.trim();
  const normalizedTitle = title?.toLowerCase();
  if (currentRawName?.provenance === 'title') {
    return currentRawName;
  }
  if (
    normalizedTitle
    && (
      normalizedTitle in GROK_TOOL_NAME_MAP
      || GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES.has(normalizedTitle)
    )
  ) {
    return { provenance: 'title', rawName: normalizedTitle };
  }
  if (title) {
    return { provenance: 'title', rawName: title };
  }
  if (currentRawName) {
    return currentRawName;
  }
  const kind = update.kind?.trim();
  if (kind) {
    return { provenance: 'kind', rawName: kind };
  }
  return { provenance: 'fallback', rawName: 'tool' };
}

export function normalizeGrokToolCall(value: {
  kind?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  title?: string | null;
}, currentRawName?: GrokRawToolNameResolution): GrokNormalizedToolCall {
  const rawName = resolveGrokRawToolName(currentRawName, value).rawName;
  return {
    input: normalizeGrokToolInput(rawName, value.rawInput, value.rawOutput),
    name: normalizeGrokToolName(rawName, value.rawInput, value.rawOutput),
    output: formatToolOutput(value.rawOutput),
    rawInput: value.rawInput,
    rawName,
    rawOutput: value.rawOutput,
  };
}

export function buildGrokToolProviderPayload(value: {
  rawInput?: unknown;
  rawName: string;
  rawOutput?: unknown;
}): GrokToolProviderPayload {
  return {
    ...(value.rawInput !== undefined ? { rawInput: value.rawInput } : {}),
    rawName: value.rawName,
    ...(value.rawOutput !== undefined ? { rawOutput: value.rawOutput } : {}),
  };
}

export function normalizeGrokToolUseResult(
  rawName: string,
  input: Record<string, unknown>,
  rawOutput: unknown,
  rawInput?: unknown,
): GrokNormalizedToolUseResult {
  const providerPayload = buildGrokToolProviderPayload({
    rawInput,
    rawName,
    rawOutput,
  });
  const answers = normalizeGrokQuestionAnswers(rawName, input, rawOutput);
  const output = isRecord(rawOutput) ? rawOutput : null;
  const edits = output?.type === 'SearchReplace' && isRecord(output.EditsApplied)
    ? output.EditsApplied
    : null;
  const structuredPatch = edits ? buildEditPatch(edits) : undefined;
  const webSearch = output?.type === 'WebSearch' ? output : null;
  const webSearchResults = webSearch ? buildCitationResults(webSearch.citations) : undefined;
  const webSearchSummary = webSearch && typeof webSearch.content === 'string' && webSearch.content.trim()
    ? webSearch.content
    : undefined;
  const resultImages = output ? readResultImages(output) : undefined;
  return {
    ...(answers ? { answers } : {}),
    ...(output?.type === 'ReadFile' && isRecord(output.FileContent) ? { resultFormat: 'plain' } : {}),
    ...(structuredPatch && typeof edits?.absolute_path === 'string'
      ? { filePath: edits.absolute_path, structuredPatch }
      : {}),
    ...(webSearchResults ? { webSearchResults } : {}),
    ...(webSearchResults && webSearchSummary ? { webSearchSummary } : {}),
    ...(resultImages ? { resultImages } : {}),
    providerPayload,
  };
}

interface GrokToolUpdateFields {
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: unknown;
}

/**
 * Projects a native Grok tool update onto ACP presentation content and status.
 * Raw input/output stay untouched so provider payloads remain lossless.
 */
export function normalizeGrokToolUpdate<T extends GrokToolUpdateFields>(update: T): T {
  const output = isRecord(update.rawOutput) ? update.rawOutput : null;
  if (!output) {
    // Before execution Grok echoes the command description as content; it is not output.
    if (isRecord(update.rawInput) && update.rawInput.variant === 'Bash' && update.status == null) {
      const { content: _description, ...rest } = update;
      return rest as T;
    }
    return update;
  }

  switch (output.type) {
    case 'Bash':
      return normalizeTerminalUpdate(update, output);
    case 'GrepSearch': {
      const matches = formatGrepMatches(output.file_matches);
      return matches ? withText(update, matches) : update;
    }
    case 'ListDir':
      return isRecord(output.Content) && typeof output.Content.content === 'string'
        ? withText(update, output.Content.content)
        : withFallbackText(update, output);
    case 'Todo':
      return isRecord(output.TodosUpdated) && typeof output.TodosUpdated.summary_for_prompt === 'string'
        && !hasTextContent(update)
        ? withText(update, output.TodosUpdated.summary_for_prompt)
        : withFallbackText(update, output);
    case 'WebSearch':
      return typeof output.content === 'string' && !hasTextContent(update)
        ? withText(update, output.content)
        : update;
    case 'MCP':
      return normalizeMCPUpdate(update, output);
    case 'ReadFile':
      return isRecord(output.FileContent)
        ? mapContentText(update, stripGrokReadGutters)
        : withFallbackText(update, output);
    case 'ImageGen':
    case 'ImageEdit':
      return typeof output.path === 'string' ? withText(update, output.path) : update;
    case 'TaskOutput': {
      const shells = readShellTaskResults(output);
      return shells ? withText(update, shells.map(result => formatShellTaskResult(result, shells.length > 1)).join('\n\n')) : update;
    }
    case 'KillTask':
      return isRecord(output.Result) && typeof output.Result.message === 'string' && !hasTextContent(update)
        ? withText(update, output.Result.message)
        : update;
    case 'SearchTool': {
      const tools = typeof output.content === 'string' ? formatToolCatalog(output.content) : null;
      return tools ? withText(update, tools) : update;
    }
    case 'Workflow':
      return typeof output.message === 'string' && !hasTextContent(update)
        ? withText(update, output.message)
        : withFallbackText(update, output);
    default:
      return withFallbackText(update, output);
  }
}

/** Grok reports nonzero exits, timeouts, and signals as completed calls. */
function normalizeTerminalUpdate<T extends GrokToolUpdateFields>(
  update: T,
  output: Record<string, unknown>,
): T {
  const presented = mapContentText(update, text => collapseCarriageReturns(stripAnsi(text)));
  // Progress output rewrites the current line, so only completed lines are stable enough to stream.
  if (update.status !== 'completed') {
    const streamed = readContentText(presented);
    return streamed === undefined || update.status === 'failed'
      ? presented
      : withText(presented, streamed.slice(0, streamed.lastIndexOf('\n') + 1));
  }

  const text = (readContentText(presented) ?? '').replace(/\n+$/, '');
  const failure = typeof output.exit_code === 'number' && output.exit_code !== 0
    ? `exit: ${output.exit_code}`
    : output.timed_out === true
      ? 'timed out'
      : typeof output.signal === 'string' && output.signal
        ? `signal: ${output.signal}`
        : null;
  if (!failure) return withText(presented, text);
  return { ...withText(presented, text ? `${failure}\n${text}` : failure), status: 'failed' };
}

/** MCP results arrive as `{ OkayOutput | Error: text }`; `is_error` marks server-reported failures. */
function normalizeMCPUpdate<T extends GrokToolUpdateFields>(update: T, output: Record<string, unknown>): T {
  const result = isRecord(output.output) ? output.output : null;
  const text = result && typeof result.OkayOutput === 'string'
    ? result.OkayOutput
    : result && typeof result.Error === 'string' ? result.Error : undefined;
  const presented = text !== undefined && !hasTextContent(update)
    ? withText(update, splitDataImages(text).text)
    : update;
  return output.is_error === true && update.status === 'completed'
    ? { ...presented, status: 'failed' }
    : presented;
}

const DATA_IMAGE_LINE = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Grok inlines MCP image blocks as `data:` URI lines inside the text result. */
function splitDataImages(text: string): { images: ToolResultImage[]; text: string } {
  const images: ToolResultImage[] = [];
  const lines = text.split('\n').filter((line) => {
    const match = line.trim().match(DATA_IMAGE_LINE);
    if (match) images.push({ kind: 'data', mediaType: match[1], data: match[2] });
    return !match;
  });
  return { images, text: images.length > 0 ? lines.join('\n') : text };
}

function readResultImages(output: Record<string, unknown>): ToolResultImage[] | undefined {
  if ((output.type === 'ImageGen' || output.type === 'ImageEdit') && typeof output.path === 'string') {
    return [{ kind: 'file', path: output.path, ...(typeof output.filename === 'string' ? { alt: output.filename } : {}) }];
  }
  if (output.type === 'MCP' && isRecord(output.output) && typeof output.output.OkayOutput === 'string') {
    const { images } = splitDataImages(output.output.OkayOutput);
    return images.length > 0 ? images : undefined;
  }
  return undefined;
}

interface GrokShellTaskResult {
  command: string;
  task_id?: unknown;
  exit_code?: unknown;
  output?: unknown;
}

/** Task results that name a command are background shells; subagent results do not. */
function readShellTaskResults(rawOutput: unknown): GrokShellTaskResult[] | null {
  if (!isRecord(rawOutput) || rawOutput.type !== 'TaskOutput') return null;
  const results = Array.isArray(rawOutput.Result) ? rawOutput.Result : [rawOutput.Result];
  const shells = results.filter((result): result is GrokShellTaskResult => (
    isRecord(result) && typeof result.command === 'string'
  ));
  return shells.length > 0 && shells.length === results.length ? shells : null;
}

function formatShellTaskResult(result: GrokShellTaskResult, includeLabel: boolean): string {
  const output = typeof result.output === 'string' ? result.output.replace(/\n+$/, '') : '';
  const exit = typeof result.exit_code === 'number' && result.exit_code !== 0 ? `exit: ${result.exit_code}` : '';
  const taskId = typeof result.task_id === 'string' && result.task_id ? ` (${result.task_id})` : '';
  const label = includeLabel ? `$ ${result.command}${taskId}` : '';
  return [label, exit, output].filter(Boolean).join('\n');
}

/**
 * Grok anchors line 1 and every tenth line as `N→`; other lines are verbatim file text.
 * Remove only native anchors; the remaining text is presented verbatim.
 */
function stripGrokReadGutters(text: string): string {
  const lines = text.split('\n');
  const first = lines[0].match(/^(\d+)→/);
  if (!first) return text;
  const start = Number(first[1]);
  return lines.map((line, index) => {
    const anchor = `${start + index}→`;
    const isNativeAnchor = (index === 0 || (start + index) % 10 === 0) && line.startsWith(anchor);
    return isNativeAnchor ? line.slice(anchor.length) : line;
  }).join('\n');
}

/** Lists `search_tool` catalog hits as `key — first description line`. */
function formatToolCatalog(content: string): string | null {
  let catalog: unknown;
  try {
    catalog = JSON.parse(content);
  } catch {
    return null;
  }
  const servers = isRecord(catalog) && Array.isArray(catalog.results) ? catalog.results.filter(isRecord) : [];
  const lines = servers.flatMap(server => (Array.isArray(server.tools) ? server.tools.filter(isRecord) : []))
    .flatMap((tool) => {
      if (typeof tool.tool_name !== 'string') return [];
      const description = typeof tool.description === 'string' ? tool.description.split('\n')[0].trim() : '';
      return [description ? `${tool.tool_name} — ${description}` : tool.tool_name];
    });
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Exposes an inline workflow's Rhai source and `meta` name to the shared script view. */
function normalizeWorkflowInput(input: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(input.source) ? input.source : null;
  if (!source || source.type !== 'script' || typeof source.script !== 'string') return input;
  const name = source.script.match(/\bmeta\s*=\s*#\{[^}]*?\bname\s*:\s*"([^"]+)"/)?.[1];
  return {
    ...input,
    code: source.script,
    language: 'Rhai',
    ...(name && input.title === undefined ? { title: name } : {}),
  };
}

function hasTextContent(update: GrokToolUpdateFields): boolean {
  return readContentText(update) !== undefined;
}

function readContentText(update: GrokToolUpdateFields): string | undefined {
  if (!Array.isArray(update.content)) return undefined;
  const texts = update.content.flatMap((entry: unknown) => {
    if (!isRecord(entry) || entry.type !== 'content' || !isRecord(entry.content)) return [];
    return entry.content.type === 'text' && typeof entry.content.text === 'string' ? [entry.content.text] : [];
  });
  return texts.length > 0 ? texts.join('') : undefined;
}

function mapContentText<T extends GrokToolUpdateFields>(update: T, map: (text: string) => string): T {
  if (!Array.isArray(update.content)) return update;
  return {
    ...update,
    content: update.content.map((entry: unknown) => (
      isRecord(entry) && entry.type === 'content' && isRecord(entry.content)
        && entry.content.type === 'text' && typeof entry.content.text === 'string'
        ? { ...entry, content: { ...entry.content, text: map(entry.content.text) } }
        : entry
    )),
  };
}

/** Replaces text content while keeping native non-text entries such as diffs. */
function withText<T extends GrokToolUpdateFields>(update: T, text: string): T {
  const retained: unknown[] = Array.isArray(update.content)
    ? (update.content as unknown[]).filter(entry => !isRecord(entry) || entry.type !== 'content')
    : [];
  return {
    ...update,
    content: [...retained, { type: 'content', content: { type: 'text', text } }],
  };
}

/** Failed variants such as `{ type: 'ListDir', NotFound: '...' }` carry their message only in raw output. */
function withFallbackText<T extends GrokToolUpdateFields>(update: T, output: Record<string, unknown>): T {
  if (update.status !== 'failed' || hasTextContent(update)) return update;
  const variants = Object.entries(output).filter(([key]) => key !== 'type');
  const message = variants.length === 1 ? variants[0][1] : undefined;
  return typeof message === 'string' && message.trim() ? withText(update, message) : update;
}

function formatGrepMatches(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines = value.filter(isRecord).flatMap((file) => {
    if (typeof file.path !== 'string') return [];
    const filePath = file.path.replace(/\/(?:\.\/)+/g, '/');
    const matches = Array.isArray(file.matches) ? file.matches.filter(isRecord) : [];
    if (matches.length === 0) return [filePath];
    return matches.map(match => (
      typeof match.line_number === 'number' && typeof match.content === 'string'
        ? `${filePath}:${match.line_number}:${match.content}`
        : filePath
    ));
  });
  return lines.length > 0 ? lines.join('\n') : null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences begin with the ESC control character.
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Keeps what a terminal would show when progress output rewrites a line with `\r`. */
function collapseCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const segments = line.split('\r').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : '';
  }).join('\n');
}

/** Builds one hunk per native edit detail; context is kept only when hunks cannot overlap. */
function buildEditPatch(edits: Record<string, unknown>): StructuredPatchHunk[] | undefined {
  const details = isRecord(edits.edits) && Array.isArray(edits.edits.details)
    ? edits.edits.details.filter(isRecord)
    : [];
  const hunks = details.flatMap((detail): StructuredPatchHunk[] => {
    const { new_line: newLine, new_string: newString, old_line: oldLine, old_string: oldString } = detail;
    if (
      typeof oldString !== 'string' || typeof newString !== 'string'
      || typeof oldLine !== 'number' || typeof newLine !== 'number'
    ) {
      return [];
    }
    const prefix = typeof detail.line_prefix === 'string' ? detail.line_prefix : '';
    const withContext = details.length === 1;
    const before = withContext ? splitPatchLines(detail.context_before) : [];
    const after = withContext ? splitPatchLines(detail.context_after) : [];
    const removed = splitPatchLines(prefix + oldString);
    const added = splitPatchLines(prefix + newString);
    return [{
      lines: [
        ...before.map(line => ` ${line}`),
        ...removed.map(line => `-${line}`),
        ...added.map(line => `+${line}`),
        ...after.map(line => ` ${line}`),
      ],
      newLines: before.length + added.length + after.length,
      newStart: newLine - before.length,
      oldLines: before.length + removed.length + after.length,
      oldStart: oldLine - before.length,
    }];
  });
  return hunks.length === details.length && hunks.length > 0 ? hunks : undefined;
}

function splitPatchLines(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

function buildCitationResults(value: unknown): WebSearchResultItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = [...new Set(value.filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url)))];
  return urls.length > 0 ? urls.map(url => ({ title: url, url })) : undefined;
}

function normalizeGrokQuestionAnswers(
  rawName: string,
  input: Record<string, unknown>,
  rawOutput: unknown,
): AskUserAnswers | undefined {
  if (normalizeGrokToolName(rawName) !== TOOL_ASK_USER_QUESTION || !isRecord(rawOutput)) {
    return undefined;
  }
  const userAnswered = isRecord(rawOutput.UserAnswered)
    ? rawOutput.UserAnswered
    : isRecord(rawOutput.userAnswered)
      ? rawOutput.userAnswered
      : null;
  const message = userAnswered && typeof userAnswered.message === 'string'
    ? userAnswered.message.trim()
    : '';
  if (!message) return undefined;

  const questions = Array.isArray(input.questions)
    ? input.questions.filter(isRecord)
    : [];
  const parsed = extractResolvedAnswersFromResultText(message);
  if (parsed && questions.length !== 1) return parsed;
  if (questions.length !== 1) {
    return undefined;
  }

  const question = questions[0];
  const questionText = typeof question.question === 'string' ? question.question : '';
  if (!questionText) return undefined;
  const questionId = typeof question.id === 'string' ? question.id : '';
  if (parsed && (parsed[questionText] !== undefined || (questionId && parsed[questionId] !== undefined))) {
    return parsed;
  }
  const answers: AskUserAnswers = { [questionText]: message };
  if (questionId) {
    answers[questionId] = message;
  }
  return answers;
}

export function normalizeGrokToolInput(rawName: string, value: unknown, rawOutput?: unknown): Record<string, unknown> {
  const input = isRecord(value)
    ? value
    : value === undefined ? {} : { value };

  switch (rawName.trim().toLowerCase()) {
    case 'get_command_or_subagent_output': {
      const shells = readShellTaskResults(rawOutput);
      return shells?.length === 1 && input.command === undefined ? { ...input, command: shells[0].command } : input;
    }
    case 'hashline_read':
    case 'read_file':
      return addInputAlias(input, 'file_path', ['target_file', 'path']);
    case 'list_dir':
      return addInputAlias(input, 'path', ['target_directory']);
    case 'skill':
      return addInputAlias(input, 'skill', ['name']);
    case 'spawn_subagent':
    case 'task':
      return addInputAlias(input, 'run_in_background', ['background']);
    case 'todo_write':
      return normalizeTodoInput(input);
    case 'use_tool':
      return isRecord(input.tool_input) ? input.tool_input : {};
    case 'workflow':
      return normalizeWorkflowInput(input);
    default:
      return input;
  }
}

function addInputAlias(
  input: Record<string, unknown>,
  targetKey: string,
  sourceKeys: readonly string[],
): Record<string, unknown> {
  if (input[targetKey] !== undefined) return input;
  for (const sourceKey of sourceKeys) {
    if (input[sourceKey] !== undefined) {
      return { ...input, [targetKey]: input[sourceKey] };
    }
  }
  return input;
}

function normalizeTodoInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.todos)) return input;

  let changed = false;
  const rawTodos: unknown[] = input.todos;
  const todos = rawTodos.map((todo) => {
    if (!isRecord(todo) || typeof todo.content !== 'string' || todo.activeForm !== undefined) {
      return todo;
    }
    changed = true;
    return { ...todo, activeForm: todo.content };
  });
  return changed ? { ...input, todos } : input;
}

function formatToolOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return stringifyUnknown(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
