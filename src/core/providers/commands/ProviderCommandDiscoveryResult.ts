export type ProviderCommandDiscoveryResult<T> =
  | { status: 'ready'; items: [T, ...T[]] }
  | { status: 'empty' }
  | { status: 'requires-session'; message: string }
  | { status: 'error'; message: string; retryable: true };

export function normalizeProviderCommandDiscoveryItems<T>(
  items: readonly T[],
): ProviderCommandDiscoveryResult<T> {
  if (items.length === 0) {
    return { status: 'empty' };
  }

  return {
    status: 'ready',
    items: [...items] as [T, ...T[]],
  };
}
