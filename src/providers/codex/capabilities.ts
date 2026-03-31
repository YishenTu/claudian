import type { ProviderCapabilities } from '../../core/providers/types';

export const CODEX_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'codex',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: false,
  reasoningControl: 'effort',
});
