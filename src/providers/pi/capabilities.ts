import type { ProviderCapabilities } from '../../core/providers/types';

export const PI_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'pi',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: false,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
