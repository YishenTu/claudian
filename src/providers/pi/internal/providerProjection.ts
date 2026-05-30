export function ensureProviderProjectionMap(
  settings: Record<string, unknown>,
  key:
  | 'savedProviderEffort'
  | 'savedProviderModel'
  | 'savedProviderPermissionMode'
  | 'savedProviderServiceTier'
  | 'savedProviderThinkingBudget',
): Partial<Record<string, string>> {
  const current = settings[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Partial<Record<string, string>>;
  }

  const next: Partial<Record<string, string>> = {};
  settings[key] = next;
  return next;
}
