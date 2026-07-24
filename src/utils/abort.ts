export function toAbortError(
  signal: AbortSignal,
  fallbackMessage: string,
): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }

  const errorLikeReason = reason
    && typeof reason === 'object'
    && 'name' in reason
    && typeof reason.name === 'string'
    && 'message' in reason
    && typeof reason.message === 'string'
    ? { message: reason.message, name: reason.name }
    : null;
  const error = new Error(
    errorLikeReason?.message || fallbackMessage,
    { cause: reason },
  );
  if (errorLikeReason?.name) {
    error.name = errorLikeReason.name;
  }
  return error;
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): void {
  if (signal?.aborted) {
    throw toAbortError(signal, fallbackMessage);
  }
}
