import type { ProviderCapabilities } from '../../core/providers/types';

export const CURSOR_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'cursor',
  supportsPersistentRuntime: false,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  reasoningControl: 'none',
});
