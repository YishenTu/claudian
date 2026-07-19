import type { ProviderCapabilities } from '../../core/providers/types';

/**
 * Conservative Kimi Code ACP capabilities for Claudian.
 *
 * Verified against Kimi Code >= 0.27.0 ACP adapter:
 * - loadSession, image prompts, configOptions (model/mode/thinking), commands
 * - plan/default/auto/yolo modes when advertised
 * - no Claudian-managed MCP forwarding in Phase 1
 * - no rewind/fork/turn steering
 */
export const KIMI_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'kimi',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsTurnSteer: false,
  // Kimi advertises thought_level as an on/off select (effort-like axis).
  reasoningControl: 'effort',
});
