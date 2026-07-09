import type { ProviderCapabilities } from '../../core/providers/types';

export const OCTO_AGENT_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'octo-agent',
  reasoningControl: 'effort',
  supportsFork: true,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsPersistentRuntime: true,
  supportsPlanMode: false,
  supportsProviderCommands: false,
  supportsRewind: false,
  supportsNativeHistory: true,
  supportsTurnSteer: false,
});
