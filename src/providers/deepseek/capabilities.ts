import type { ProviderCapabilities } from '@/core/providers/types';

export const DEEPSEEK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'deepseek',
  startsSharedRuntimeOnTabPresence: true,
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsEphemeralFork: true,
  supportsRewind: false,
  supportsFork: true,
  supportsConversationBranches: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  supportsResponseThroughput: true,
  reasoningControl: 'effort',
});
