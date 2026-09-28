import type { ProviderCapabilities } from '../../core/providers/types';
import { getOpencodeState } from './types';

export const OPENCODE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'opencode',
  supportsResponseThroughput: true,
  supportsNativeHistory: true,
  supportsEphemeralSessions: true,
  supportsRewind: false,
  supportsFork: true,
  supportsEphemeralFork: false,
  forkMode: 'full-session',
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});

const OPENCODE_V2_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  ...OPENCODE_PROVIDER_CAPABILITIES,
  forkMode: 'checkpoint',
  supportsEphemeralFork: true,
});

export function getOpencodeConversationCapabilities(providerState?: Record<string, unknown>): ProviderCapabilities {
  return getOpencodeState(providerState).nativeVersion === 2
    ? OPENCODE_V2_CAPABILITIES
    : OPENCODE_PROVIDER_CAPABILITIES;
}
