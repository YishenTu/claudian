import {
  deriveProviderModelCatalogStatus,
} from '@/core/providers/modelCatalog';

describe('deriveProviderModelCatalogStatus', () => {
  it('reports an empty catalog when no models have been discovered', () => {
    expect(deriveProviderModelCatalogStatus({
      modelCount: 0,
      now: 10_000,
      refreshedAt: 9_000,
    })).toBe('empty');
  });

  it('reports a ready catalog within the freshness window', () => {
    expect(deriveProviderModelCatalogStatus({
      modelCount: 2,
      now: 10_000,
      refreshedAt: 9_000,
      ttlMs: 5_000,
    })).toBe('ready');
  });

  it('reports stale cached data after the freshness window', () => {
    expect(deriveProviderModelCatalogStatus({
      modelCount: 2,
      now: 16_000,
      refreshedAt: 9_000,
      ttlMs: 5_000,
    })).toBe('stale');
  });

  it('reports refresh failure without discarding a usable cached catalog', () => {
    expect(deriveProviderModelCatalogStatus({
      modelCount: 2,
      now: 10_000,
      refreshedAt: 9_000,
      refreshFailed: true,
    })).toBe('failed');
  });
});

