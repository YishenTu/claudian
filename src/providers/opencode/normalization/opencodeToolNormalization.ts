import { diffFromUnifiedText } from '@/core/tools/toolDiff';

import {
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EXEC,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_READ,
  TOOL_SKILL,
  TOOL_SUBAGENT,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import { normalizeToolResultDetails } from '../../../core/tools/toolResultDetails';
import type {
  AskUserAnswers,
  AskUserQuestionItem,
  ToolResultDetails,
  WebSearchResultItem,
} from '../../../core/types';
import {
  type ACPResolvedToolRawName,
  ACPToolStreamAdapter,
} from '../../acp';

const TOOL_NAME_MAP: Record<string, string> = {
  apply_patch: TOOL_APPLY_PATCH,
  bash: TOOL_BASH,
  shell: TOOL_BASH,
  edit: TOOL_EDIT,
  // V2 code mode runs JavaScript against namespaced tools.
  execute: TOOL_EXEC,
  glob: TOOL_GLOB,
  grep: TOOL_GREP,
  patch: TOOL_APPLY_PATCH,
  question: TOOL_ASK_USER_QUESTION,
  read: TOOL_READ,
  skill: TOOL_SKILL,
  task: TOOL_SUBAGENT,
  subagent: TOOL_SUBAGENT,
  todowrite: TOOL_TODO_WRITE,
  webfetch: TOOL_WEB_FETCH,
  websearch: TOOL_WEB_SEARCH,
  write: TOOL_WRITE,
};

type OpencodeKnownToolName = keyof typeof TOOL_NAME_MAP;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownToolName(value: unknown): value is OpencodeKnownToolName {
  if (typeof value !== 'string') {
    return false;
  }

  return value.trim().toLowerCase() in TOOL_NAME_MAP;
}

function toKnownToolName(value: string | undefined): OpencodeKnownToolName | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return isKnownToolName(normalized)
    ? normalized
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  return firstTrimmedString(...values) ?? '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueValues = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    uniqueValues.add(trimmed);
  }

  return [...uniqueValues];
}

function normalizeQuestionOptions(value: unknown): Array<{ description: string; label: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((option) => {
    if (typeof option === 'string') {
      const label = option.trim();
      return label ? [{ description: '', label }] : [];
    }

    if (!isPlainObject(option)) {
      return [];
    }

    const label = typeof option.label === 'string' ? option.label.trim() : '';
    if (!label) {
      return [];
    }

    return [{
      description: typeof option.description === 'string' ? option.description : '',
      label,
    }];
  });
}

function normalizeQuestionItems(value: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const record = isPlainObject(item) ? item : {};
    const question = firstTrimmedString(record.question) ?? `Question ${index + 1}`;
    const header = firstTrimmedString(record.header) ?? `Q${index + 1}`;

    return {
      ...(typeof record.id === 'string' && record.id.trim()
        ? { id: record.id }
        : {}),
      header,
      multiSelect: record.multiSelect === true || record.multi_select === true || record.multiple === true,
      options: normalizeQuestionOptions(record.options),
      question,
    };
  });
}

function normalizeTodoStatus(value: unknown): 'completed' | 'in_progress' | 'pending' {
  switch (value) {
    case 'completed':
    case 'cancelled':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function normalizeTodos(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isPlainObject(item)) {
      return [];
    }

    const content = firstTrimmedString(item.content, item.title, item.description);
    if (!content) {
      return [];
    }

    return [{
      activeForm: firstTrimmedString(item.activeForm, item.active_form) ?? content,
      content,
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      status: normalizeTodoStatus(item.status),
    }];
  });
}

function normalizeQuestionAnswers(
  rawAnswers: unknown,
  questions: AskUserQuestionItem[],
): AskUserAnswers | undefined {
  if (!Array.isArray(rawAnswers) || questions.length === 0) {
    return undefined;
  }

  const answers: AskUserAnswers = {};

  for (let index = 0; index < Math.min(rawAnswers.length, questions.length); index += 1) {
    const question = questions[index];
    const rawEntry = (rawAnswers as unknown[])[index];
    if (!question) {
      continue;
    }

    const values = Array.isArray(rawEntry)
      ? rawEntry
          .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : typeof rawEntry === 'string' && rawEntry.trim().length > 0
      ? [rawEntry]
      : [];

    if (values.length === 0) {
      continue;
    }

    const normalizedValue = values.length === 1 ? values[0] : values;
    answers[question.question] = normalizedValue;
    if (question.id) {
      answers[question.id] = normalizedValue;
    }
  }

  return Object.keys(answers).length > 0 ? answers : undefined;
}

function extractToolMetadata(rawOutput: unknown): Record<string, unknown> | null {
  if (!isPlainObject(rawOutput)) {
    return null;
  }

  return isPlainObject(rawOutput.metadata) ? rawOutput.metadata : null;
}

export function resolveOpencodeRawToolName(
  currentRawName: ACPResolvedToolRawName | undefined,
  update: {
    kind?: string | null;
    title?: string | null;
  },
): ACPResolvedToolRawName {
  const titleName = firstTrimmedString(update.title);
  const knownTitleName = titleName && isKnownToolName(titleName)
    ? titleName.trim().toLowerCase()
    : undefined;

  if (knownTitleName) {
    return { provenance: 'title', rawName: knownTitleName };
  }

  if (
    titleName
    && (
      currentRawName?.provenance !== 'mapped-kind'
      && (
        currentRawName?.provenance !== 'title'
        || !isKnownToolName(currentRawName.rawName)
      )
    )
  ) {
    return { provenance: 'title', rawName: titleName };
  }
  if (currentRawName) {
    return currentRawName;
  }

  switch (update.kind) {
    case 'execute':
      return { provenance: 'mapped-kind', rawName: 'bash' };
    case 'fetch':
      return { provenance: 'mapped-kind', rawName: 'webfetch' };
    case 'read':
      return { provenance: 'mapped-kind', rawName: 'read' };
    default:
      return { provenance: 'fallback', rawName: 'tool' };
  }
}

function normalizeWebSearchInput(input: Record<string, unknown>): Record<string, unknown> {
  const action = isPlainObject(input.action)
    ? input.action
    : {};

  const queries = normalizeStringArray(action.queries ?? input.queries);
  const query = firstNonEmptyString(action.query, input.query, queries[0]);
  const url = firstNonEmptyString(action.url, input.url);
  const pattern = firstNonEmptyString(action.pattern, input.pattern);
  const explicitType = firstNonEmptyString(action.type, input.actionType, input.action_type);

  const actionType = explicitType
    || (url && pattern ? 'find_in_page' : url ? 'open_page' : (query || queries.length > 0) ? 'search' : '');

  const normalized: Record<string, unknown> = {};
  if (actionType) {
    normalized.actionType = actionType;
  }
  if (query) {
    normalized.query = query;
  }
  if (queries.length > 0) {
    normalized.queries = queries;
  }
  if (url) {
    normalized.url = url;
  }
  if (pattern) {
    normalized.pattern = pattern;
  }

  return normalized;
}

export function normalizeOpencodeToolName(rawName: string | undefined): string {
  const knownName = toKnownToolName(rawName);
  if (!knownName) {
    return rawName?.trim() || 'tool';
  }

  return TOOL_NAME_MAP[knownName];
}

export function normalizeOpencodeToolInput(
  rawName: string | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const knownName = toKnownToolName(rawName);
  switch (knownName) {
    case 'question':
      return { questions: normalizeQuestionItems(input.questions) };
    case 'apply_patch':
    case 'patch':
      return firstString(input.patch, input.patchText) ? { patch: firstString(input.patch, input.patchText) } : {};
    case 'read':
      return {
        ...(firstString(input.file_path, input.filePath, input.path) ? { file_path: firstString(input.file_path, input.filePath, input.path) } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
      };
    case 'write':
      return {
        ...(typeof input.content === 'string' ? { content: input.content } : {}),
        ...(firstString(input.file_path, input.filePath, input.path) ? { file_path: firstString(input.file_path, input.filePath, input.path) } : {}),
      };
    case 'edit': {
      const oldString = firstString(input.old_string, input.oldString);
      const newString = firstString(input.new_string, input.newString);
      return {
        ...(firstString(input.file_path, input.filePath, input.path) ? { file_path: firstString(input.file_path, input.filePath, input.path) } : {}),
        ...(oldString !== undefined ? { old_string: oldString } : {}),
        ...(newString !== undefined ? { new_string: newString } : {}),
        ...(typeof input.replace_all === 'boolean'
          ? { replace_all: input.replace_all }
          : typeof input.replaceAll === 'boolean'
          ? { replace_all: input.replaceAll }
          : {}),
      };
    }
    case 'subagent':
    case 'task':
      return {
        ...(firstTrimmedString(input.command) ? { command: firstTrimmedString(input.command) } : {}),
        ...(firstTrimmedString(input.description) ? { description: firstTrimmedString(input.description) } : {}),
        ...(firstTrimmedString(input.prompt) ? { prompt: firstTrimmedString(input.prompt) } : {}),
        ...(input.run_in_background === true || input.run_in_background === false
          ? { run_in_background: input.run_in_background }
          : typeof input.background === 'boolean'
          ? { run_in_background: input.background }
          : {}),
        ...(firstTrimmedString(input.subagent_type, input.agent) ? { subagent_type: firstTrimmedString(input.subagent_type, input.agent) } : {}),
        ...(firstTrimmedString(input.task_id, input.sessionID) ? { task_id: firstTrimmedString(input.task_id, input.sessionID) } : {}),
      };
    case 'todowrite':
      return { todos: normalizeTodos(input.todos) };
    case 'skill':
      return firstTrimmedString(input.skill, input.name, input.id)
        ? { skill: firstTrimmedString(input.skill, input.name, input.id) }
        : {};
    case 'websearch':
      return normalizeWebSearchInput(input);
    default:
      return input;
  }
}

/** Parses `## [title](url)` hits, each with an optional `Published:` line and snippet. */
function parseWebSearchResults(text: string): WebSearchResultItem[] {
  return text.split(/^(?=## \[)/m).flatMap((block) => {
    const match = block.match(/^## \[(.+)\]\((https?:\/\/\S+)\)[ \t]*(?:\r?\n([\s\S]*))?$/);
    if (!match) {
      return [];
    }
    const [, title, url, body = ''] = match;
    const published = body.match(/^Published: ([^\r\n]+)\r?\n?/);
    const snippet = (published ? body.slice(published[0].length) : body).trim();
    return [{
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(published ? { publishedAt: published[1].trim() } : {}),
    }];
  });
}

/** Decodes a native OpenCode `{ output, metadata }` result into the neutral result fields. */
export function normalizeOpencodeToolResultDetails(
  rawName: string | undefined,
  input: Record<string, unknown>,
  rawOutput: unknown,
): ToolResultDetails | undefined {
  const knownName = toKnownToolName(rawName);
  const metadata = extractToolMetadata(rawOutput);
  const normalized: ToolResultDetails = {};

  if (knownName === 'read') {
    normalized.resultFormat = 'plain';
  }

  if (knownName === 'edit') {
    const files = Array.isArray(metadata?.files) ? metadata.files.filter(isPlainObject) : [];
    const patch = firstTrimmedString(files[0]?.patch);
    const filePath = firstString(input.file_path, input.filePath, input.path, metadata?.filepath, metadata?.filePath);
    const diff = patch ? diffFromUnifiedText(patch, filePath) : undefined;
    if (diff) {
      normalized.diff = diff;
    }
  }

  if (knownName === 'websearch') {
    const output = isPlainObject(rawOutput) ? firstString(rawOutput.output) : undefined;
    const results = output ? parseWebSearchResults(output) : [];
    if (results.length > 0) {
      normalized.webSearchResults = results;
    }
  }

  if (knownName === 'question') {
    const questions = Array.isArray(input.questions)
      ? input.questions as AskUserQuestionItem[]
      : [];
    const answers = normalizeQuestionAnswers(metadata?.answers, questions);
    if (answers) {
      normalized.resolvedAnswers = answers;
    }
  }

  return normalizeToolResultDetails(normalized);
}

/** Native outcomes that OpenCode reports as successful tool completions. */
function isOpencodeToolOutcomeFailure(
  knownName: OpencodeKnownToolName | null,
  metadata: Record<string, unknown> | null,
): boolean {
  switch (knownName) {
    case 'execute':
      return metadata?.error === true;
    case 'shell':
      return (typeof metadata?.exit === 'number' && metadata.exit !== 0)
        || Boolean(firstTrimmedString(metadata?.signal))
        || metadata?.timeout === true;
    default:
      return false;
  }
}

/** Removes the `Read file X, lines a-b` header and `N: ` line gutters. */
function unwrapReadOutput(text: string): string {
  const header = text.match(/^Read file [^\n]*, lines \d+-\d+\r?\n/);
  return header ? text.slice(header[0].length).replace(/^\d+: ?/gm, '') : text;
}

/** Converts native result text to the shared tool presentation and detects in-band failures. */
export function normalizeOpencodeToolResult(
  rawName: string | undefined,
  content: string,
  rawOutput: unknown,
): { content: string; isError: boolean } {
  const knownName = toKnownToolName(rawName);
  const isError = isOpencodeToolOutcomeFailure(knownName, extractToolMetadata(rawOutput));
  switch (knownName) {
    case 'read':
      return { content: unwrapReadOutput(content), isError };
    default:
      return { content, isError };
  }
}

export function createOpencodeToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    normalizeToolInput: normalizeOpencodeToolInput,
    normalizeToolName: normalizeOpencodeToolName,
    normalizeToolResultDetails: normalizeOpencodeToolResultDetails,
    resolveRawToolName: resolveOpencodeRawToolName,
  });
}
