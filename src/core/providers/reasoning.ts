export const DEFAULT_REASONING_VALUE = 'high';
export const STANDARD_REASONING_VALUES = ['low', 'medium', 'high'] as const;

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
