import type { ProviderCapabilities } from '../../core/providers/types';

/**
 * Conservative Grok Build capabilities for Claudian.
 *
 * Grok 0.2.99 ACP exposes loadSession and some agent commands, but Claudian does
 * not yet claim rewind/fork/images/MCP management through shared contracts.
 */
export const GROK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'grok',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
