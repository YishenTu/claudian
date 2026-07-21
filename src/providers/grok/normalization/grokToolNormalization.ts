import {
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
  TOOL_GREP,
  TOOL_KILL_SHELL,
  TOOL_LS,
  TOOL_READ,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { AcpToolRawNameProvenance } from '../../acp/AcpToolStreamAdapter';

const GROK_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  apply_patch: TOOL_EDIT,
  ask_user_question: TOOL_ASK_USER_QUESTION,
  get_terminal_command_output: TOOL_BASH_OUTPUT,
  grep: TOOL_GREP,
  hashline_read: TOOL_READ,
  kill_terminal_command: TOOL_KILL_SHELL,
  list_dir: TOOL_LS,
  read_file: TOOL_READ,
  run_terminal_command: TOOL_BASH,
  search_replace: TOOL_EDIT,
  todo_write: TOOL_TODO_WRITE,
  web_fetch: TOOL_WEB_FETCH,
  web_search: TOOL_WEB_SEARCH,
  write_file: TOOL_WRITE,
};

const GROK_TASK_TOOL_NAMES = new Set([
  'kill_task',
  'task',
  'task_output',
  'wait_for_task',
]);

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
  if (GROK_TASK_TOOL_NAMES.has(lookup)) {
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
    && (normalizedTitle in GROK_TOOL_NAME_MAP || GROK_TASK_TOOL_NAMES.has(normalizedTitle))
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
    input: normalizeToolInput(value.rawInput),
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
    && (normalized in GROK_TOOL_NAME_MAP || GROK_TASK_TOOL_NAMES.has(normalized))
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

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return value === undefined ? {} : { value };
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
