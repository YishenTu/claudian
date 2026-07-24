import type { ProviderCapabilities } from '../../core/providers/types';

export const QODER_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'qoder',
  supportsPersistentRuntime: false,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
