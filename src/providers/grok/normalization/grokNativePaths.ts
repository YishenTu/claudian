import type { ExecutionPathMapper } from '@/core/process/execution-target/types';

// Native payloads retain their schema and unknown fields. Project only structured
// filesystem fields; tool text, diffs, command strings and URLs remain literal.
const PATH_FIELDS = new Set(['path', 'file_path', 'filePath', 'target_file', 'absolute_path', 'target_directory', 'directory', 'cwd']);

export function mapGrokNativePaths<T>(value: T, mapper?: ExecutionPathMapper): T {
  if (mapper?.target.method !== 'wsl') return value;
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key,
      PATH_FIELDS.has(key) && typeof child === 'string' && child.startsWith('/')
        ? mapper.toHostPath(child) ?? child : visit(child),
    ]));
  };
  return visit(value) as T;
}
