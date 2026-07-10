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

export interface NormalizedCodexToolCall {
  name: string;
  input: Record<string, unknown>;
}

export function normalizeCodexToolCall(
  rawName: string | undefined,
  rawInput: Record<string, unknown>,
): NormalizedCodexToolCall {
  const nestedCall = rawName === 'exec' ? decodeExecEnvelope(rawInput) : null;
  const effectiveName = nestedCall?.name ?? rawName;
  const effectiveInput = nestedCall?.input ?? rawInput;

  return {
    name: normalizeCodexToolName(effectiveName),
    input: normalizeCodexToolInput(effectiveName, effectiveInput),
  };
}

function decodeExecEnvelope(input: Record<string, unknown>): {
  name: string;
  input: Record<string, unknown>;
} | null {
  const source = firstNonEmptyString(input.raw, input.value);
  if (!source) return null;

  const tokens = tokenizeExecEnvelope(source);
  if (!tokens) return null;

  const calls = findExecEnvelopeToolCalls(tokens);
  if (!calls || calls.length !== 1) return null;

  const call = calls[0];
  if (!call) return null;

  if (call.name === 'exec_command') {
    const command = extractExecCommand(tokens, call);
    return command ? { name: call.name, input: { cmd: command } } : null;
  }

  if (call.name === 'apply_patch') {
    const patch = extractApplyPatch(tokens, call);
    return patch ? { name: call.name, input: { patch } } : null;
  }

  return null;
}

type JavaScriptTokenKind = 'identifier' | 'string' | 'punctuation';

interface JavaScriptToken {
  kind: JavaScriptTokenKind;
  value: string;
}

interface ExecEnvelopeToolCall {
  name: string;
  toolTokenIndex: number;
  openParenTokenIndex: number;
}

function tokenizeExecEnvelope(source: string): JavaScriptToken[] | null {
  const tokens: JavaScriptToken[] = [];

  for (let index = 0; index < source.length;) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }

    if (char === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd === -1) return null;
      index = commentEnd + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const stringToken = readJavaScriptStringToken(source, index);
      if (!stringToken) return null;
      tokens.push({ kind: 'string', value: stringToken.value });
      index = stringToken.end;
      continue;
    }

    // Template literals and slash expressions need a full JavaScript lexer.
    // Preserve the generic exec envelope instead of guessing when they are present.
    if (char === '`' || char === '/') {
      return null;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w$]/.test(source[end] ?? '')) {
        end += 1;
      }
      tokens.push({ kind: 'identifier', value: source.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ kind: 'punctuation', value: char });
    index += 1;
  }

  return tokens;
}

function readJavaScriptStringToken(
  source: string,
  startIndex: number,
): { value: string; end: number } | null {
  const quote = source[startIndex];
  if (quote !== '"' && quote !== "'") return null;

  for (let index = startIndex + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] !== quote) continue;

    const literal = source.slice(startIndex, index + 1);
    if (quote === '"') {
      try {
        const parsed = JSON.parse(literal) as unknown;
        return typeof parsed === 'string' ? { value: parsed, end: index + 1 } : null;
      } catch {
        return null;
      }
    }

    return {
      value: decodeSingleQuotedString(literal.slice(1, -1)),
      end: index + 1,
    };
  }

  return null;
}

function findExecEnvelopeToolCalls(
  tokens: readonly JavaScriptToken[],
): ExecEnvelopeToolCall[] | null {
  const calls: ExecEnvelopeToolCall[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const toolsToken = tokens[index];
    const previousToken = tokens[index - 1];
    if (
      toolsToken?.kind !== 'identifier'
      || toolsToken.value !== 'tools'
      || previousToken?.value === '.'
    ) {
      continue;
    }

    const dotToken = tokens[index + 1];
    const nameToken = tokens[index + 2];
    const openParenToken = tokens[index + 3];
    if (
      dotToken?.value !== '.'
      || nameToken?.kind !== 'identifier'
      || openParenToken?.value !== '('
    ) {
      return null;
    }

    calls.push({
      name: nameToken.value,
      toolTokenIndex: index,
      openParenTokenIndex: index + 3,
    });
  }

  return calls;
}

function extractExecCommand(
  tokens: readonly JavaScriptToken[],
  call: ExecEnvelopeToolCall,
): string | null {
  const closeParenTokenIndex = findMatchingToken(tokens, call.openParenTokenIndex, '(', ')');
  if (closeParenTokenIndex === null) return null;
  if (tokens[call.openParenTokenIndex + 1]?.value !== '{') return null;

  let objectDepth = 0;
  for (let index = call.openParenTokenIndex + 1; index < closeParenTokenIndex; index += 1) {
    const token = tokens[index];
    if (token?.value === '{') {
      objectDepth += 1;
      continue;
    }
    if (token?.value === '}') {
      objectDepth -= 1;
      continue;
    }
    if (
      objectDepth === 1
      && token?.value === 'cmd'
      && tokens[index + 1]?.value === ':'
      && tokens[index + 2]?.kind === 'string'
    ) {
      return tokens[index + 2]?.value ?? null;
    }
  }

  return null;
}

function extractApplyPatch(
  tokens: readonly JavaScriptToken[],
  call: ExecEnvelopeToolCall,
): string | null {
  const argumentToken = tokens[call.openParenTokenIndex + 1];
  if (argumentToken?.kind === 'string') return argumentToken.value;
  if (argumentToken?.kind !== 'identifier') return null;

  let patch: string | null = null;
  for (let index = 0; index <= call.toolTokenIndex - 4; index += 1) {
    const declarationToken = tokens[index];
    if (
      declarationToken?.kind === 'identifier'
      && (declarationToken.value === 'const'
        || declarationToken.value === 'let'
        || declarationToken.value === 'var')
      && tokens[index + 1]?.value === argumentToken.value
      && tokens[index + 2]?.value === '='
      && tokens[index + 3]?.kind === 'string'
    ) {
      patch = tokens[index + 3]?.value ?? null;
    }
  }

  return patch;
}

function findMatchingToken(
  tokens: readonly JavaScriptToken[],
  openTokenIndex: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;

  for (let index = openTokenIndex; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === open) {
      depth += 1;
    } else if (value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return null;
}

function decodeSingleQuotedString(value: string): string {
  return value.replace(/\\([\\'"nrtbfv0])/g, (_match, escaped: string) => {
    const escapes: Record<string, string> = {
      '\\': '\\',
      "'": "'",
      '"': '"',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      0: '\0',
    };
    return escapes[escaped] ?? escaped;
  });
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
        file_path: stringifyCodexValue(input.path ?? input.file_path),
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
    const text = stringifyCodexValue(item.step ?? item.title ?? item.content);
    return {
      id: stringifyCodexValue(item.id),
      content: text,
      activeForm: text,
      status: stringifyCodexValue(item.status) || 'pending',
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
      question: stringifyCodexValue(item.question) || `Question ${index + 1}`,
      ...(item.id ? { id: stringifyCodexValue(item.id) } : {}),
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
      .map(stringifyCodexValue)
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return stringifyCodexValue(value);
}

function stringifyCodexValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
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

export function stringifyCodexToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';

  if (Array.isArray(value)) {
    const textParts = value
      .map(part => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('');
  }

  try {
    const result = JSON.stringify(value);
    return typeof result === 'string' ? result : String(value);
  } catch {
    return String(value);
  }
}

export function extractCodexExecCellId(output: string): string | undefined {
  const match = output.trimStart().match(/^Script running with cell ID\s+([^\n]+)/i);
  return match?.[1]?.trim() || undefined;
}

export function readCodexExecCellIdArgument(
  input: Record<string, unknown>,
): string | undefined {
  const value = input.cell_id ?? input.cellId;
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function appendCodexCommandOutput(previous: string | undefined, next: string): string {
  if (!next) return previous ?? '';
  if (!previous) return next;
  if (previous.endsWith('\n') || next.startsWith('\n')) return previous + next;
  return `${previous}\n${next}`;
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
