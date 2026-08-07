export function readStoredBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function readStoredString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function hasStoredConfigNormalization(
  storedConfig: Record<string, unknown>,
  normalizedConfig: Record<string, unknown>,
): boolean {
  return Object.keys(normalizedConfig).some(key => (
    Object.prototype.hasOwnProperty.call(storedConfig, key)
    && JSON.stringify(storedConfig[key]) !== JSON.stringify(normalizedConfig[key])
  ));
}
