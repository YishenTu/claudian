export function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;

  const message = typeof value === 'string' && value.length > 0
    ? value
    : fallbackMessage;
  return new Error(message, { cause: value });
}
