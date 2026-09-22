import type { ProviderCapabilities } from '../../core/providers/types';

export const GROK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'grok',
  supportsResponseThroughput: false,
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
