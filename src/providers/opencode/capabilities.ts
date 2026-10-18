import type { ProviderCapabilities } from '../../core/providers/types';

export const OPENCODE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'opencode',
  supportsResponseThroughput: true,
  supportsNativeHistory: true,
  startsSharedRuntimeOnTabPresence: true,
  supportsEphemeralSessions: true,
  supportsRewind: false,
  supportsFork: true,
  supportsEphemeralFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
