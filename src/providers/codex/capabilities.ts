import type { ProviderCapabilities } from '../../core/providers/types';

export const CODEX_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'codex',
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
