import {
normalizeProviderCommandDiscoveryItems
} from '@/core/providers/commands/ProviderCommandDiscoveryResult';

describe('ProviderCommandDiscoveryResult', () => {
  it('normalizes an authoritative non-empty response to ready', () => {
    expect(normalizeProviderCommandDiscoveryItems(['skill:review'])).toEqual({
      status: 'ready',
      items: ['skill:review'],
    });
  });

  it('normalizes an authoritative zero-item response to empty', () => {
    expect(normalizeProviderCommandDiscoveryItems([])).toEqual({ status: 'empty' });
  });
});
