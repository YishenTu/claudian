import type { ProviderCapabilities } from '../../core/providers/types';

export const CLAUDE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'claude',
  supportsResponseThroughput: true,
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
