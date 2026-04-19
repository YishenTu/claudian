import type { ProviderCapabilities } from '../../core/providers/types';

export const OPENCODE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'opencode',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsInstructionMode: false,
  supportsMcpTools: false,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
