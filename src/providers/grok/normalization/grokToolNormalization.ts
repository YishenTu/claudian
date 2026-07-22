import {
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
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
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { AcpToolRawNameProvenance } from '../../acp/AcpToolStreamAdapter';
import { GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES } from './grokLifecycleToolNames';

const GROK_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  apply_patch: TOOL_APPLY_PATCH,
  ask_user_question: TOOL_ASK_USER_QUESTION,
  edit_notebook: TOOL_NOTEBOOK_EDIT,
  get_terminal_command_output: TOOL_BASH_OUTPUT,
  grep: TOOL_GREP,
  hashline_edit: TOOL_EDIT,
  hashline_grep: TOOL_GREP,
  hashline_read: TOOL_READ,
  kill_terminal_command: TOOL_KILL_SHELL,
  list_dir: TOOL_LS,
  read_file: TOOL_READ,
  run_terminal_command: TOOL_BASH,
  search_replace: TOOL_EDIT,
  search_tool: TOOL_TOOL_SEARCH,
  skill: TOOL_SKILL,
  todo_write: TOOL_TODO_WRITE,
  web_fetch: TOOL_WEB_FETCH,
  web_search: TOOL_WEB_SEARCH,
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

export interface GrokRawToolNameResolution {
  provenance: AcpToolRawNameProvenance;
  rawName: string;
}

export function normalizeGrokToolName(rawName: string): string {
  const normalized = rawName.trim();
  const lookup = normalized.toLowerCase();
  if (GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES.has(lookup)) {
    return normalized || 'tool';
  }
  return GROK_TOOL_NAME_MAP[lookup] ?? (normalized || 'tool');
}

export function resolveGrokRawToolName(
  currentRawName: GrokRawToolNameResolution | undefined,
  update: { kind?: string | null; title?: string | null },
): GrokRawToolNameResolution {
  const title = update.title?.trim();
  const normalizedTitle = title?.toLowerCase();
  if (
    normalizedTitle
    && (
      normalizedTitle in GROK_TOOL_NAME_MAP
      || GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES.has(normalizedTitle)
    )
  ) {
    return { provenance: 'title', rawName: normalizedTitle };
  }
  if (
    title
    && (
      currentRawName?.provenance !== 'title'
      || !isKnownGrokRawToolName(currentRawName.rawName)
    )
  ) {
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
    input: normalizeToolInput(rawName, value.rawInput),
    name: normalizeGrokToolName(rawName),
    output: formatToolOutput(value.rawOutput),
    rawInput: value.rawInput,
    rawName,
    rawOutput: value.rawOutput,
  };
}

function isKnownGrokRawToolName(rawName: string | undefined): boolean {
  const normalized = rawName?.trim().toLowerCase();
  return Boolean(
    normalized
    && (
      normalized in GROK_TOOL_NAME_MAP
      || GROK_SUBAGENT_LIFECYCLE_TOOL_NAMES.has(normalized)
    )
  );
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

function normalizeToolInput(rawName: string, value: unknown): Record<string, unknown> {
  const input = isRecord(value)
    ? value
    : value === undefined ? {} : { value };

  switch (rawName.trim().toLowerCase()) {
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
  const todos = input.todos.map((todo) => {
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
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
