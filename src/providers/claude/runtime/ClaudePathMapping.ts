const PATH_KEYS = new Set([
  'file_path',
  'path',
  'notebook_path',
  'plan_file_path',
]);

export function mapClaudeToolInputPaths(
  input: Record<string, unknown>,
  mapPath: (value: string) => string | null,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PATH_KEYS.has(key) && typeof value === 'string') {
      mapped[key] = mapPath(value) ?? value;
    } else if (Array.isArray(value)) {
      mapped[key] = value.map(entry =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? mapClaudeToolInputPaths(entry as Record<string, unknown>, mapPath)
          : entry
      );
    } else if (value && typeof value === 'object') {
      mapped[key] = mapClaudeToolInputPaths(value as Record<string, unknown>, mapPath);
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}
