import type { ProviderCapabilities } from '../../core/providers/types';

export const ACP_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'acp',
  supportsPersistentRuntime: false,  // Agent manages its own lifecycle
  supportsNativeHistory: false,      // Depends on agent implementation
  supportsPlanMode: false,           // Not in initial ACP spec
  supportsRewind: false,             // Not in ACP spec
  supportsFork: false,               // Not in ACP spec
  supportsProviderCommands: false,   // Agent-specific commands handled differently
  supportsImageAttachments: true,    // If agent supports it
  supportsInstructionMode: false,    // Not in initial MVP
  supportsMcpTools: false,           // ACP has its own tool system
  supportsTurnSteer: false,          // Not in ACP spec
  reasoningControl: 'none',          // Agent controls reasoning
});
