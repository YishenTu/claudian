import type { ProviderCapabilities } from '../../core/providers/types';

export const OMP_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'omp',
  commandDiscoveryDeadline: 'provider-owned',
  supportsNativeHistory: true,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
