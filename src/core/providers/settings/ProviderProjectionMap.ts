export const PROVIDER_PROJECTION_KEYS = [
  'savedProviderModel',
  'savedProviderEffort',
  'savedProviderServiceTier',
  'savedProviderThinkingBudget',
  'savedProviderPermissionMode',
] as const;

export type ProviderProjectionKey = typeof PROVIDER_PROJECTION_KEYS[number];
export type ProviderProjectionMap = Partial<Record<string, string>>;

export function normalizeProviderProjectionMap(value: unknown): ProviderProjectionMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: ProviderProjectionMap = {};
  for (const [providerId, projectedValue] of Object.entries(value)) {
    if (typeof projectedValue !== 'string') {
      continue;
    }

    Object.defineProperty(normalized, providerId, {
      configurable: true,
      enumerable: true,
      value: projectedValue,
      writable: true,
    });
  }
  return normalized;
}

export function ensureProviderProjectionMap(
  settings: Record<string, unknown>,
  key: ProviderProjectionKey,
): ProviderProjectionMap {
  const normalized = normalizeProviderProjectionMap(settings[key]);
  settings[key] = normalized;
  return normalized;
}
