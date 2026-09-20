import type { ProviderCapabilities } from '../../core/providers/types';

export const OPENCODE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'opencode',
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsRewind: false,
  supportsFork: true,
  forkMode: 'full-session',
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
