export function ensureProviderProjectionMap(
  settings: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = settings[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  settings[key] = next;
  return next;
}
