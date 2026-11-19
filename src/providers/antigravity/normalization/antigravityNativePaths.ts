import type { ExecutionPathMapper } from '@/core/process/execution-target/types';

/** agy's own filesystem arguments: `Path` (file tools), `AbsolutePath` (view_file) and `Cwd` (run_command). */
const ARGUMENT_PATH_FIELDS = ['AbsolutePath', 'Cwd', 'Path'] as const;

interface NativeToolCallPaths {
  content?: unknown;
  locations?: unknown;
  rawInput?: unknown;
}

/**
 * Presents the Linux paths a WSL agy reports as host paths. Only agy's top-level tool arguments map; nested values,
 * such as a user MCP server's arguments, stay literal.
 */
export function mapAntigravityArgumentPaths<T>(args: T, mapper?: ExecutionPathMapper): T {
  if (mapper?.target.method !== 'wsl' || !isRecord(args)) return args;
  const mapped: Record<string, unknown> = { ...args };
  for (const key of ARGUMENT_PATH_FIELDS) {
    const value = mapped[key];
    if (typeof value === 'string') mapped[key] = toHostPath(value, mapper);
  }
  return mapped as T;
}

/** Maps a tool call's arguments, its ACP locations and its diff paths; other content and output stay literal. */
export function mapAntigravityToolCallPaths<T extends NativeToolCallPaths>(toolCall: T, mapper?: ExecutionPathMapper): T {
  if (mapper?.target.method !== 'wsl') return toolCall;
  const mapped: T = { ...toolCall };
  if (isRecord(toolCall.rawInput)) mapped.rawInput = mapAntigravityArgumentPaths(toolCall.rawInput, mapper);
  if (Array.isArray(toolCall.locations)) {
    mapped.locations = toolCall.locations.map((location: unknown) => mapPathField(location, mapper));
  }
  if (Array.isArray(toolCall.content)) {
    mapped.content = toolCall.content.map((entry: unknown) => (isRecord(entry) && entry.type === 'diff' ? mapPathField(entry, mapper) : entry));
  }
  return mapped;
}

function mapPathField(value: unknown, mapper: ExecutionPathMapper): unknown {
  return isRecord(value) && typeof value.path === 'string' ? { ...value, path: toHostPath(value.path, mapper) } : value;
}

function toHostPath(value: string, mapper: ExecutionPathMapper): string {
  return value.startsWith('/') ? mapper.toHostPath(value) ?? value : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
