type ProviderProjectionKey =
  | 'savedProviderEffort'
  | 'savedProviderModel'
  | 'savedProviderPermissionMode'
  | 'savedProviderServiceTier'
  | 'savedProviderThinkingBudget';

type ProviderProjectionMap = Partial<Record<string, string>>;

function normalizeProviderProjectionMap(value: unknown): ProviderProjectionMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const normalized: ProviderProjectionMap = {};
  for (const [providerId, projectedValue] of Object.entries(value)) {
    if (typeof projectedValue === 'string') {
      normalized[providerId] = projectedValue;
    }
  }
  return normalized;
}

export function ensureProviderProjectionMap(
  settings: Record<string, unknown>,
  key: ProviderProjectionKey,
): ProviderProjectionMap {
  const current = normalizeProviderProjectionMap(settings[key]);
  if (current) {
    settings[key] = current;
    return current;
  }

  const next: ProviderProjectionMap = {};
  settings[key] = next;
  return next;
}
