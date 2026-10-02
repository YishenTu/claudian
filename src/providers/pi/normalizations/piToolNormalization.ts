import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EXEC,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { ScriptToolCallItem, WebSearchResultItem } from '../../../core/types';

const PI_BUILT_IN_TOOL_NAMES: Record<string, string> = {
  bash: TOOL_BASH,
  // Built-in extension that runs JavaScript calling the other tools.
  codemode: TOOL_EXEC,
  edit: TOOL_EDIT,
  find: TOOL_GLOB,
  grep: TOOL_GREP,
  ls: TOOL_LS,
  // Windows shell tool; same `command` schema as bash.
  powershell: TOOL_BASH,
  read: TOOL_READ,
  web_fetch: TOOL_WEB_FETCH,
  web_search: TOOL_WEB_SEARCH,
  write: TOOL_WRITE,
};

export function extractPiToolTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(extractPiToolTextContent)
      .filter(Boolean)
      .join('\n');
  }

  if (!isPlainObject(value)) {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return extractPiToolTextContent(value.content);
  }
  if (isPlainObject(value.partialResult)) {
    return extractPiToolTextContent(value.partialResult.content);
  }
  if (isPlainObject(value.result)) {
    return extractPiToolTextContent(value.result.content ?? value.result);
  }

  return '';
}

/** The first content part of a codemode result; Pi's own renderer drops it too. */
const CODEMODE_RESULT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** Result text for display, given a result object or its content parts. */
export function extractPiToolResultText(toolName: string, value: unknown): string {
  const parts = Array.isArray(value) ? value : isPlainObject(value) && Array.isArray(value.content) ? value.content : null;
  const first: unknown = parts?.[0];
  if (
    parts
    && normalizePiToolName(toolName) === TOOL_EXEC
    && isPlainObject(first)
    && typeof first.text === 'string'
    && CODEMODE_RESULT_HEADER.test(first.text)
  ) {
    return extractPiToolTextContent(parts.slice(1));
  }
  return extractPiToolTextContent(value);
}

export function normalizePiToolInput(value: unknown, toolName?: string): Record<string, unknown> {
  const input = isPlainObject(value) ? { ...value } : {};
  const normalizedToolName = toolName ? normalizePiToolName(toolName) : '';

  if (
    (normalizedToolName === TOOL_READ || normalizedToolName === TOOL_WRITE || normalizedToolName === TOOL_EDIT)
    && typeof input.path === 'string'
    && typeof input.file_path !== 'string'
  ) {
    input.file_path = input.path;
  }

  return input;
}

/**
 * Projects a native `{ content, details }` result onto the neutral fields
 * renderers read. Edit `details.diff` is Pi's numbered TUI diff, so the
 * unified `details.patch` is the only diff source.
 */
export function normalizePiToolUseResult(
  toolName: string,
  result: unknown,
  nestedArguments?: ReadonlyMap<string, unknown>,
): Record<string, unknown> | undefined {
  const details = isPlainObject(result) && isPlainObject(result.details) ? result.details : null;
  switch (normalizePiToolName(toolName)) {
    case TOOL_READ:
      return { resultFormat: 'plain' };
    case TOOL_EDIT: {
      const patch = typeof details?.patch === 'string' && details.patch.trim() ? details.patch : undefined;
      return patch ? { diff: patch } : undefined;
    }
    case TOOL_WEB_SEARCH: {
      const webSearchResults = Array.isArray(details?.results)
        ? details.results.flatMap(toWebSearchResultItem)
        : [];
      return webSearchResults.length > 0 ? { webSearchResults } : undefined;
    }
    case TOOL_EXEC: {
      const scriptToolCalls = Array.isArray(details?.calls)
        ? details.calls.flatMap(call => toScriptToolCallItem(call, nestedArguments))
        : [];
      return scriptToolCalls.length > 0 ? { scriptToolCalls } : undefined;
    }
    default:
      return undefined;
  }
}

const SCRIPT_TOOL_CALL_STATUSES: Record<string, ScriptToolCallItem['status']> = {
  cancelled: 'cancelled',
  error: 'error',
  ok: 'completed',
  running: 'running',
};

/**
 * Reads one codemode `details.calls` entry: `{ id, name, args, status, durationMs, error }`.
 * `args` is a JSON preview capped at 200 characters, so complete arguments come from the
 * nested call itself when known, and a cut-off preview stays display text.
 */
function toScriptToolCallItem(value: unknown, nestedArguments?: ReadonlyMap<string, unknown>): ScriptToolCallItem[] {
  if (!isPlainObject(value)) {
    return [];
  }
  const rawName = firstString(value.name);
  const status = typeof value.status === 'string' ? SCRIPT_TOOL_CALL_STATUSES[value.status] : undefined;
  if (!rawName || !status) {
    return [];
  }
  const name = normalizePiToolName(rawName);
  const id = firstString(value.id);
  const args = firstString(value.args);
  const fullArguments = (id ? nestedArguments?.get(id) : undefined) ?? parseJSONObject(args);
  const error = firstString(value.error);
  return [{
    name,
    status,
    ...(isPlainObject(fullArguments) ? { input: normalizePiToolInput(fullArguments, name) } : args ? { args } : {}),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(error ? { error } : {}),
  }];
}

/** Reads one `{ title, url, description, age }` search hit. */
function toWebSearchResultItem(value: unknown): WebSearchResultItem[] {
  if (!isPlainObject(value)) {
    return [];
  }
  const url = firstString(value.url);
  if (!url) {
    return [];
  }
  const snippet = firstString(value.description);
  const publishedAt = firstString(value.age);
  return [{
    title: firstString(value.title) ?? url,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  }];
}

export function getPiToolId(value: Record<string, unknown>): string {
  return firstString(value.id, value.toolCallId, value.callId, value.call_id) ?? '';
}

export function getPiToolName(value: Record<string, unknown>): string {
  return normalizePiToolName(firstString(value.name, value.tool, value.toolName, value.tool_name) ?? 'tool');
}

export function normalizePiToolName(name: string): string {
  return PI_BUILT_IN_TOOL_NAMES[name.trim().toLowerCase()] ?? name;
}

function parseJSONObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
