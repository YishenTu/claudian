export function mergePersistedProviderState(
  existingState: Record<string, unknown> | undefined,
  ownedKeys: readonly string[],
  normalizedOwnedState: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const ownedKeySet = new Set(ownedKeys);
  const entries = Object.entries(existingState ?? {})
    .filter(([key, value]) => !ownedKeySet.has(key) && value !== undefined);

  for (const [key, value] of Object.entries(normalizedOwnedState ?? {})) {
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
