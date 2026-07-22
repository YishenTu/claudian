import type { ProviderCapabilities } from '../../core/providers/types';

export const GROK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'grok',
  reasoningControl: 'effort',
  supportsFork: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: true,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: true,
});
