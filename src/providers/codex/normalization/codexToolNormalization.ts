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
      return { command: (input.command ?? input.cmd ?? '') as string };

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
    if (!entry || typeof entry !== 'object') return { question: `Question ${index + 1}` };
    const item = entry as Record<string, unknown>;
    return {
      question: String(item.question ?? `Question ${index + 1}`),
      ...(item.id ? { id: String(item.id) } : {}),
      ...(item.header ? { header: String(item.header) } : {}),
    };
  });
}

function normalizeWebSearchInput(input: Record<string, unknown>): Record<string, unknown> {
  // web_search_call uses action.query; web_search uses query directly
  if (typeof input.query === 'string') return { query: input.query };
  const action = input.action;
  if (action && typeof action === 'object' && 'query' in action) {
    return { query: String((action as Record<string, unknown>).query ?? '') };
  }
  return { query: '' };
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
