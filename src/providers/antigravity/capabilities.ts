import type { ProviderCapabilities } from '@/core/providers/types';

export const ANTIGRAVITY_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'antigravity',
  supportsResponseThroughput: true,
  supportsNativeHistory: true,
  startsSharedRuntimeOnTabPresence: false,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: true,
  supportsEphemeralFork: false,
  forkMode: 'checkpoint',
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});

export function getAntigravityConversationCapabilities(
  _providerState?: Record<string, unknown>,
): ProviderCapabilities {
  return ANTIGRAVITY_PROVIDER_CAPABILITIES;
}
