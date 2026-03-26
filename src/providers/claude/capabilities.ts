import type { ProviderCapabilities } from '../../core/providers/types';

export const CLAUDE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'claude',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: true,
  reasoningControl: 'effort',
  planPathPrefix: '/.claude/plans/',
});
