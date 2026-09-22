import type { ProviderCapabilities } from '../../core/providers/types';

export const PI_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'pi',
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
