export type ProjectionKey = 'savedProviderEffort' | 'savedProviderModel';

export function ensureProviderProjectionMap(
  settings: Record<string, unknown>,
  key: ProjectionKey,
): Record<string, string> {
  const current = settings[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, string>;
  }

  const next: Record<string, string> = {};
  settings[key] = next;
  return next;
}
