import type { ProviderCapabilities } from '../../core/providers/types';

export const GROK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'grok',
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
