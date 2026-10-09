import type { ProviderCapabilities } from '@/core/providers/types';

export const DEEPSEEK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'deepseek',
  startsSharedRuntimeOnTabPresence: true,
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsEphemeralFork: false,
  supportsRewind: false,
  supportsFork: true,
  supportsConversationBranches: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsResponseThroughput: true,
  reasoningControl: 'effort',
});
