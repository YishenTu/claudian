import type { ProviderCapabilities } from '../../core/providers/types';

/** agy's ACP server has no fork, rewind or non-persistent sessions; those features stay off. */
export const ANTIGRAVITY_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'antigravity',
  supportsResponseThroughput: false,
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
