/**
 * Shared Codex tool normalization layer.
 *
 * Used by both CodexChatRuntime (live streaming) and CodexHistoryStore (history reload)
 * to ensure tool identity parity between live and restored conversations.
 */

// ---------------------------------------------------------------------------
// Tool name normalization
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Record<string, string> = {
  command_execution: 'Bash',
  shell_command: 'Bash',
  shell: 'Bash',
  exec_command: 'Bash',
  update_plan: 'TodoWrite',
  request_user_input: 'AskUserQuestion',
  view_image: 'Read',
  web_search: 'WebSearch',
  web_search_call: 'WebSearch',
  file_change: 'apply_patch',
};

/** Native Codex tools that should NOT be remapped. */
const NATIVE_TOOLS = new Set([
  'apply_patch',
  'write_stdin',
  'spawn_agent',
  'send_input',
  'wait',
  'wait_agent',
  'resume_agent',
  'close_agent',
]);

export function normalizeCodexToolName(rawName: string | undefined): string {
  if (!rawName) return 'tool';
  if (NATIVE_TOOLS.has(rawName)) return rawName;
  return TOOL_NAME_MAP[rawName] ?? rawName;
}

// ---------------------------------------------------------------------------
// Tool input normalization
// ---------------------------------------------------------------------------

export function normalizeCodexToolInput(
  rawName: string | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (rawName) {
    case 'command_execution':
    case 'shell_command':
    case 'shell':
    case 'exec_command':
      return { command: normalizeCommandValue(input.command ?? input.cmd ?? '') };

    case 'update_plan':
      return { todos: normalizeUpdatePlanTodos(input) };

    case 'request_user_input':
      return { questions: normalizeQuestions(input) };

    case 'view_image':
      return {
        ...input,
        file_path: (input.path ?? input.file_path ?? '') as string,
      };

    case 'web_search':
    case 'web_search_call':
      return normalizeWebSearchInput(input);

    case 'apply_patch':
      return normalizeApplyPatchInput(input);

    default:
      return input;
  }
}

function normalizeUpdatePlanTodos(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const plan = input.plan;
  if (!Array.isArray(plan)) return [];

  return plan.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return { id: '', title: '', status: 'pending' };
    const item = entry as Record<string, unknown>;
    const text = String(item.step ?? item.title ?? item.content ?? '');
    return {
      id: String(item.id ?? ''),
      content: text,
      activeForm: text,
      status: String(item.status ?? 'pending'),
    };
  });
}

function normalizeQuestions(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const questions = input.questions;
  if (!Array.isArray(questions)) return [];

  return questions.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object') {
      return {
        question: `Question ${index + 1}`,
        header: `Q${index + 1}`,
        options: [],
        multiSelect: false,
      };
    }
    const item = entry as Record<string, unknown>;
    const options = Array.isArray(item.options)
      ? item.options
          .map((option: unknown) => {
            if (typeof option === 'string') {
              return { label: option, description: '' };
            }
            if (!option || typeof option !== 'object') {
              return null;
            }
            const raw = option as Record<string, unknown>;
            const label = typeof raw.label === 'string' ? raw.label : '';
            const description = typeof raw.description === 'string' ? raw.description : '';
            if (!label) return null;
            return { label, description };
          })
          .filter((option): option is { label: string; description: string } => option !== null)
      : [];

    return {
      question: String(item.question ?? `Question ${index + 1}`),
      ...(item.id ? { id: String(item.id) } : {}),
      header: typeof item.header === 'string' && item.header.trim()
        ? String(item.header)
        : `Q${index + 1}`,
      options,
      multiSelect: Boolean(item.multiSelect ?? item.multi_select),
    };
  });
}

function normalizeCommandValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(entry => (typeof entry === 'string' ? entry : String(entry)))
      .join(' ')
      .trim();
  }
  return value == null ? '' : String(value);
}

function normalizeWebSearchInput(input: Record<string, unknown>): Record<string, unknown> {
  const action = input.action && typeof input.action === 'object'
    ? input.action as Record<string, unknown>
    : {};

  const queries = normalizeStringArray(action.queries ?? input.queries);
  const query = firstNonEmptyString(action.query, input.query, queries[0]);
  const url = firstNonEmptyString(action.url, input.url);
  const pattern = firstNonEmptyString(action.pattern, input.pattern);
  const explicitType = firstNonEmptyString(action.type, input.actionType, input.action_type);

  const actionType = explicitType
    || (url && pattern ? 'find_in_page' : url ? 'open_page' : (query || queries.length > 0) ? 'search' : '');

  const normalized: Record<string, unknown> = {};
  if (actionType) normalized.actionType = actionType;
  if (query) normalized.query = query;
  if (queries.length > 0) normalized.queries = queries;
  if (url) normalized.url = url;
  if (pattern) normalized.pattern = pattern;
  return normalized;
}

function normalizeApplyPatchInput(input: Record<string, unknown>): Record<string, unknown> {
  const patch = firstNonEmptyString(input.patch, input.raw, input.value);
  if (!patch) return input;

  const normalized: Record<string, unknown> = { ...input, patch };
  delete normalized.raw;
  delete normalized.value;
  return normalized;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const uniqueValues = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    uniqueValues.add(trimmed);
  }

  return [...uniqueValues];
}

// ---------------------------------------------------------------------------
// MCP tool normalization
// ---------------------------------------------------------------------------

interface CodexMcpResultPart {
  type?: string;
  text?: string;
}

interface CodexMcpResultPayload {
  content?: CodexMcpResultPart[] | null;
}

export interface NormalizedCodexMcpToolState {
  isTerminal: boolean;
  isError: boolean;
  status: 'running' | 'completed' | 'error';
  result?: string;
}

export function normalizeCodexMcpToolName(server: unknown, tool: unknown): string {
  const serverName = typeof server === 'string' ? server : '';
  const toolName = typeof tool === 'string' ? tool : '';
  if (!serverName && !toolName) return 'tool';
  return `mcp__${serverName}__${toolName}`;
}

export function normalizeCodexMcpToolInput(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments === 'string') {
    return parseCodexArguments(rawArguments);
  }

  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>;
  }

  return {};
}

export function normalizeCodexMcpToolState(
  rawStatus: unknown,
  resultPayload?: unknown,
  rawError?: unknown,
): NormalizedCodexMcpToolState {
  const status = typeof rawStatus === 'string' ? rawStatus : '';
  const error = typeof rawError === 'string' ? rawError : '';
  const resultText = extractCodexMcpResultText(resultPayload);
  const isTerminalStatus = status === 'completed'
    || status === 'failed'
    || status === 'error'
    || status === 'cancelled';
  const isTerminal = isTerminalStatus || Boolean(error) || Boolean(resultText);
  const isError = Boolean(error) || status === 'failed' || status === 'error' || status === 'cancelled';

  let result = error || resultText;
  if (!result && isTerminalStatus) {
    result = status === 'completed' ? 'Completed' : 'Failed';
  }

  return {
    isTerminal,
    isError,
    status: isTerminal ? (isError ? 'error' : 'completed') : 'running',
    ...(result ? { result } : {}),
  };
}

function extractCodexMcpResultText(resultPayload?: unknown): string {
  if (!resultPayload || typeof resultPayload !== 'object') return '';

  const content = (resultPayload as CodexMcpResultPayload).content;
  if (!Array.isArray(content)) return '';

  return content
    .map(item => (typeof item?.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool result normalization
// ---------------------------------------------------------------------------

/**
 * Tools whose results should get terminal-style unwrapping.
 * Uses normalized names only — callers always pass through normalizeCodexToolName first.
 */
const TERMINAL_RESULT_TOOLS = new Set([
  'Bash',
  'write_stdin',
]);

export function normalizeCodexToolResult(
  normalizedName: string,
  rawResult: string,
): string {
  if (!rawResult) return rawResult;
  if (!TERMINAL_RESULT_TOOLS.has(normalizedName)) return rawResult;
  return unwrapTerminalResult(rawResult);
}

function unwrapTerminalResult(raw: string): string {
  let result = raw;

  // Unwrap JSON { output: "..." } wrapper
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { output?: unknown };
      if (typeof parsed.output === 'string') {
        result = parsed.output;
      }
    } catch { /* not JSON, keep as-is */ }
  }

  // Strip "Output:\n" prefix
  const outputMarker = 'Output:\n';
  const markerIndex = result.indexOf(outputMarker);
  if (markerIndex >= 0) {
    result = result.slice(markerIndex + outputMarker.length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

export function isCodexToolOutputError(output: string): boolean {
  const exitCodeMatch = output.match(/(?:Exit code:|Process exited with code)\s*(\d+)/i);
  if (exitCodeMatch) {
    return Number(exitCodeMatch[1]) !== 0;
  }

  const trimmed = output.trim();

  // Detect "Error:" / "error:" prefix
  if (/^[Ee]rror:/.test(trimmed)) return true;

  // Detect JSON { "error": ... } wrapper
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if ('error' in parsed) return true;
    } catch { /* not JSON */ }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseCodexArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}
