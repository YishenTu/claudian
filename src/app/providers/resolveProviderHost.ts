import type { ProviderHost } from '../../core/providers/ProviderHost';

interface ProviderHostOwner {
  readonly providerHost?: ProviderHost;
}

/** Keeps feature-level test doubles compatible while production uses the app adapter. */
export function resolveProviderHost(value: ProviderHostOwner): ProviderHost {
  return value.providerHost ?? (value as ProviderHost);
}
