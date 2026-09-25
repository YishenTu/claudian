/** Persist metadata only for models selected in the provider's catalog. */
export function selectModelMetadata<T>(
  entries: Readonly<Record<string, T>>,
  selectedIds: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => selectedIds.has(id)));
}
