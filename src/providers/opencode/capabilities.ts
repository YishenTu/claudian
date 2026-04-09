import type { ProviderCapabilities } from '../../core/providers/types';

export const OPENCODE_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  providerId: 'opencode',
  supportsPersistentRuntime: true,
  supportsNativeHistory: false,
  supportsPlanMode: false, // OpenCode may support this in the future
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsInstructionMode: false,
  supportsMcpTools: true,
  supportsTurnSteer: false,
  reasoningControl: 'none',
};
