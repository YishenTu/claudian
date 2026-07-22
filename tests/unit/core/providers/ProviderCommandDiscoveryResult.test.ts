import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
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

  it('models retryable errors without provider settings or diagnostics payloads', () => {
    const result: ProviderCommandDiscoveryResult<string> = {
      status: 'error',
      message: 'Could not load provider commands',
      retryable: true,
    };

    expect(result).toEqual({
      status: 'error',
      message: 'Could not load provider commands',
      retryable: true,
    });
  });
});
