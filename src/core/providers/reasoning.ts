export const DEFAULT_REASONING_VALUE = 'high';

export function formatReasoningValueLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.toLowerCase() === 'xhigh') {
    return 'xHigh';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

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
