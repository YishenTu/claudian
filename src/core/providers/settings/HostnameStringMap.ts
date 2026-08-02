export type HostnameStringMap = Record<string, string>;

export function normalizeHostnameStringMap(value: unknown): HostnameStringMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: HostnameStringMap = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') {
      continue;
    }

    const key = rawKey.trim();
    const stringValue = rawValue.trim();
    if (!key || !stringValue) {
      continue;
    }

    Object.defineProperty(normalized, key, {
      configurable: true,
      enumerable: true,
      value: stringValue,
      writable: true,
    });
  }
  return normalized;
}
