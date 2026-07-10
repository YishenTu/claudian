export const DEFAULT_REASONING_VALUE = 'high';

export function resolvePreferredReasoningDefault(
  availableValues: readonly string[],
  fallbackValue: string,
): string {
  if (availableValues.includes(DEFAULT_REASONING_VALUE)) {
    return DEFAULT_REASONING_VALUE;
  }
  if (availableValues.includes(fallbackValue)) {
    return fallbackValue;
  }
  return availableValues[0] ?? fallbackValue;
}
