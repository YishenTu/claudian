import type { ProviderCapabilities } from '../../core/providers/types';

export const GROK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'grok',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsLegacySubagentTools: false,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: false,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
});
