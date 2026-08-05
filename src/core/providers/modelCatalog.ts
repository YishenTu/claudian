export type ProviderModelCatalogStatus = 'empty' | 'ready' | 'stale' | 'failed';

export interface ProviderModelCatalogStatusInput {
  readonly modelCount: number;
  readonly now?: number;
  readonly refreshedAt?: number;
  readonly refreshFailed?: boolean;
  readonly ttlMs?: number;
}

const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;

export function deriveProviderModelCatalogStatus(
  input: ProviderModelCatalogStatusInput,
): ProviderModelCatalogStatus {
  if (input.modelCount <= 0) return 'empty';
  if (input.refreshFailed) return 'failed';
  if (input.refreshedAt === undefined) return 'stale';

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  return now - input.refreshedAt > ttlMs ? 'stale' : 'ready';
}

