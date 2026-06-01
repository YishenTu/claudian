import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';

const PI_BUILT_IN_TOOL_NAMES: Record<string, string> = {
  bash: TOOL_BASH,
  edit: TOOL_EDIT,
  find: TOOL_GLOB,
  grep: TOOL_GREP,
  ls: TOOL_LS,
  read: TOOL_READ,
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

export function getPiToolId(value: Record<string, unknown>): string {
  return firstString(value.id, value.toolCallId, value.callId, value.call_id) ?? '';
}

export function getPiToolName(value: Record<string, unknown>): string {
  return normalizePiToolName(firstString(value.name, value.tool, value.toolName, value.tool_name) ?? 'tool');
}

export function normalizePiToolName(name: string): string {
  return PI_BUILT_IN_TOOL_NAMES[name.trim().toLowerCase()] ?? name;
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
